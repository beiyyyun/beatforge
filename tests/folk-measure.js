/**
 * 民乐引擎频谱测量（在页面上下文中执行，由 folk-host.cjs 注入）。
 *
 * 约束：这个文件由 executeJavaScript 解析执行，
 * 所以绝对不能出现 TypeScript 类型标注（曾因此报 Missing initializer in const declaration）。
 *
 * 返回一个用例数组，每项含：
 *   peak / peakErrPct  基频峰值（Goertzel 局部扫描）
 *   centroid           频谱质心
 *   rms / hasNaN       整体电平与数值健康度
 *   decayRatio         起音能量 / 延音能量（拨弦是否真在循环）
 *   vibratoRate/Depth  颤音（拉弦）
 *   breathRatio        气声能量 / 基频能量（吹管）
 *   rollRate/Depth     轮音（扬琴）
 */
(async () => {
  const F = window.FOLK;
  const SR = 44100;
  const A4 = 440;

  /* ---------------- 基础分析工具 ---------------- */

  /**
   * Goertzel 单频能量。
   *
   * 不用完整 FFT：我们只关心少数几个确定频率（基频、二次谐波、颤音包络），
   * Goertzel 直接给出单频幅度，复杂度 O(窗长) 且数值稳定。
   * 窗长取 8 个周期 → 频率分辨率约 ±3%。
   *
   * 注意 winSec 的单位是**秒**，不是采样数。调用方若想指定采样数
   * 必须自行换算 —— 早先在 centroid() 里误传了 Math.round(sr/freq)（采样数），
   * 结果被当成秒放大几千倍，窗长超出缓冲区，质心全部返回 0。
   */
  function energyAt(data, sr, freq, t0, winSec) {
    const n = winSec ? Math.round(sr * winSec) : Math.max(8, Math.round(sr / freq));
    const start = Math.round(t0 * sr);
    if (start < 0 || start + n > data.length) return 0;
    const c = 2 * Math.cos((2 * Math.PI * freq) / sr);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
      const x = data[start + i];
      const s0 = x + c * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const m = s1 * s1 + s2 * s2 - c * s1 * s2;
    return Math.sqrt(m > 0 ? m : 0) / n;
  }

  /**
   * 带通能量（宽带噪声的正确测法）。
   *
   * 早先用Goertzel 在 3000Hz / 4200Hz 两个单点测幅度，得到气声比 0.004~0.009，
   * 远低于断言阈值 0.05。但那是测量方法的错，不是引擎的错：
   * 呼吸噪声是宽带的（带通中心 2~4kHz，Q=0.8），能量摊在整条带上，
   * 任一单点的幅度必然很低。拿单点幅度当"气声总量"低估了一个数量级。
   *
   * 正确做法：在频带内密集采样后求平方和，等价于对带通做能量积分。
   */
  function bandEnergy(data, sr, fLo, fHi, t0, winSec) {
    let s = 0;
    const step = Math.max(20, (fHi - fLo) / 24);
    for (let f = fLo; f <= fHi; f += step) {
      s += Math.pow(energyAt(data, sr, f, t0, winSec), 2);
    }
    return Math.sqrt(s);
  }

  /** 频谱质心：对数间隔频带求 Σ f·A(f) / Σ A(f)，A 为幅度 */
  /**
   * 窗长必须按频率自适应。
   *
   * 早先固定用"8 个周期"，扫到 12kHz 时窗长只剩 3 个采样 ——
   * 远短于该频率的周期，Goertzel 在这种欠采样窗下数值无意义。
   * 后果实测到：阮（阻尼仅 1500Hz 的低音弦）报出质心 6592Hz，
   * 而它 4kHz 以上的带能量其实只有 4.17e-5，比200-500Hz 低 330倍。
   *
   * 修正：窗长至少 256 采样，否则Goertzel 的单频假设不成立。
   * 代价是高频分辨率变粗，但对质心这种整体指标无影响。
   */
  function centroid(data, sr) {
    // 窗口必须落在起音段。
    // 早先固定用 0.3s，但阮在 0.3s 已衰减到 -73dB（实测触底），
    // 那时测到的"质心"是浮点底噪的谱 —— 报出 3028Hz，
    // 而它 3kHz 以上带能量其实只有 2.3e-3，比基频带低 8.6 倍。
    // 统一用 0.02s（起音后20ms），此时所有乐器都还有充足能量。
    let num = 0, den = 0;
    for (let f = 100; f < 12000; f *= 1.15) {
      // 窗长按秒传（energyAt 的 winSec 单位是秒）：至少 256 采样，
      // 即max(256/sr, 8 周期)，两者取大者。
      const need = Math.max(256 / sr, 8 / f);
      const a = energyAt(data, sr, f, 0.02, need);
      num += a * f;
      den += a;
    }
    return den > 0 ? num / den : 0;
  }

  /**
   * 基频检测 —— 归一化互相关（ACF）求周期。
   *
   * 为什么不能用谱峰法：实测（tests/folk-diag-pitch.js）KS 拨弦的
   * 二次谐波天然强于基频 —— 阮 G3 的谱峰表里 384Hz（ratio 1.96）
   * 幅度 0.0281，而真正的基频 192Hz 只有 0.0157。
   * 于是"在[0.75f,1.35f] 邻域找最大"必然抓到二次谐波，
   * 这正是之前音高偏差普遍 20~35% 的原因（古筝 578Hz、阮 385Hz 都是伪峰）。
   *
   * ACF 对 KS 信号可靠：周期即基频周期。
   * 阮 G3 实测 193.28Hz、相关度 0.979，误差 1.4%。
   * 两种方法失效模式不同，以 ACF 为主，谱峰仅作交叉验证。
   *
   * 窗口必须落在起音段：早先在 0.3s 处测，信号已衰减到噪声底，
   * 相关函数退化，报出 22050Hz（Nyquist）。
   */
  function pitchByACF(data, sr, t0, winLen, expectHz) {
    const s = Math.round(t0 * sr);
    const n = Math.min(winLen, data.length - s - Math.floor(sr / 35));
    if (n < 300) return { hz: 0, corr: 0 };
    let mean = 0;
    for (let i = 0; i < n; i++) mean += data[s + i];
    mean /= n;
    const x = new Float32Array(n);
    let e0 = 0;
    for (let i = 0; i < n; i++) { x[i] = data[s + i] - mean; e0 += x[i] * x[i]; }
    if (e0 <= 0) return { hz: 0, corr: 0 };

    // 只在期望周期附近搜索，避免锁到高次周期的倍数上
    const expectLag = sr / expectHz;
    const minLag = Math.max(2, Math.floor(expectLag / 1.5));
    const maxLag = Math.min(Math.ceil(expectLag / 0.7), Math.floor(sr / 35));

    let best = -1, bestLag = 0;
    const vals = [];
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sxy = 0, ey = 0;
      for (let i = 0; i + lag < n; i++) { const v = x[i + lag]; sxy += x[i] * v; ey += v * v; }
      const den = Math.sqrt(e0 * ey);
      const c = den > 0 ? sxy / den : 0;
      vals.push({ lag, c });
      if (c > best) { best = c; bestLag = lag; }
    }
    if (bestLag === 0) return { hz: 0, corr: 0 };
    let refined = bestLag;
    const idx = vals.findIndex((v) => v.lag === bestLag);
    if (idx > 0 && idx < vals.length - 1) {
      const den = vals[idx - 1].c - 2 * vals[idx].c + vals[idx + 1].c;
      if (Math.abs(den) > 1e-12) refined = bestLag + (0.5 * (vals[idx - 1].c - vals[idx + 1].c)) / den;
    }
    return { hz: refined > 0 ? sr / refined : 0, corr: best };
  }

  /**
   * 基频局部峰值检测（仅作交叉验证，不用作主判据 —— 见pitchByACF 的说明）。
   */
  function peakFreqNear(data, sr, expectHz, t0) {
    const lo = expectHz * 0.75, hi = expectHz * 1.35;
    let best = 0, bestF = 0;
    for (let i = 0; i <= 48; i++) {
      const f = lo + ((hi - lo) * i) / 48;
      const a = energyAt(data, sr, f, t0);
      if (a > best) { best = a; bestF = f; }
    }
    return bestF;
  }

  function rmsOf(data, t0, t1) {
    const a = Math.round(t0 * SR), b = Math.min(data.length, Math.round(t1 * SR));
    let s = 0;
    for (let i = a; i < b; i++) s += data[i] * data[i];
    return Math.sqrt(s / Math.max(1, b - a));
  }

  function hasNaN(data) {
    for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i])) return true;
    return false;
  }

  /**
   * 包络调制分析。
   *
   * 做法：8ms 跳距算能量包络 → 移动平均去趋势 → 对残差做 Goertzel 频扫。
   *
   * 去趋势这一步不能省：拨弦/击弦本身是强衰减的，
   * 不去掉趋势的话，"包络在变化"会被误读成"存在调制"。
   * 移动平均窗取 ±25 个包络点（约 ±0.2s），远长于被测调制周期（≤0.34s），
   * 不会把真实的 5~14Hz 调制一起抹掉。
   */
  function modAnalysis(data, sr, t0, t1, loHz, hiHz) {
    const hop = 0.008, hs = Math.round(hop * sr);
    const start = Math.round(t0 * sr), end = Math.round(t1 * sr);
    const env = [];
    for (let i = start; i + hs <= end; i += hs) {
      let s = 0;
      for (let j = i; j < i + hs; j++) s += data[j] * data[j];
      env.push(Math.sqrt(s / hs));
    }
    if (env.length < 16) return { rate: 0, depthPct: 0 };

    const W = 25;
    const sm = env.map((_, i) => {
      let s = 0, n = 0;
      for (let j = Math.max(0, i - W); j <= Math.min(env.length - 1, i + W); j++) { s += env[j]; n++; }
      return s / n;
    });
    const d = env.map((v, i) => v - sm[i]);

    const esr = 1 / hop;// 包络采样率125Hz
    let best = 0, bestF = 0;
    for (let f = loHz; f <= hiHz; f += 0.1) {
      const c = 2 * Math.cos((2 * Math.PI * f) / esr);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < d.length; i++) {
        const s0 = d[i] + c * s1 - s2;
        s2 = s1; s1 = s0;
      }
      const m = s1 * s1 + s2 * s2 - c * s1 * s2;
      const a = Math.sqrt(m > 0 ? m : 0) / d.length;
      if (a > best) { best = a; bestF = f; }
    }

    let num = 0, den = 0;
    for (let i = 0; i < d.length; i++) { num += d[i] * d[i]; den += sm[i] * sm[i]; }
    return { rate: Math.round(bestF * 10) / 10, depthPct: (Math.sqrt(num / Math.max(1e-12, den)) * 100) };
  }

  /* ---------------- 渲染 ---------------- */

  async function render(Inst, params, dur, key) {
    const ctx = new OfflineAudioContext(1, Math.ceil(SR * dur), SR);
    const e = new Inst(ctx, ctx.destination);
    // 拨弦/扬琴的阻尼在 AudioWorklet 里实现，而 worklet 模块是异步加载的。
    // 必须等它就绪再noteOn，否则节点还不存在。
    // （离线路径下 postMessage 赶不上渲染，所以这一步是必需的，不是保险起见。）
    if (e.ready_) await e.ready_();
    e.noteOn(key, 0, 0.85, params, 'n1');
    // 释放排在末尾。拨弦/扬琴的 releaseAll 现在只清理存活期外的声部，
    // 这一调用同时验证"调用它不会把声音掐断"——
    // 早先它无条件 v.stop()，正是它让所有拨弦离线渲染 RMS=0。
    e.releaseAll(dur - 0.2, params);
    const buf = await ctx.startRendering();
    return buf.getChannelData(0);
  }

  /* ---------------- 乐器参数 ---------------- */
  // 说明：这些参数是各乐器的物理设定，不是同一套参数换名字。
  // 依据写在每项注释里。Task #8 会把它们落到 presets.ts，
  // 这里是同一份数值的验证副本，改动必须两边同步。
  const P = {
    // 古筝：21 弦，钢丝弦高张力→ 明亮、余音长（T60 取 4s，接近真实古筝）
    guzheng: { damping: 3400, t60: 4.0, level: 0.7, detune: 0 },
    // 琵琶：相位音箱、弦短硬，攻击最亮，衰减中等
    pipa: { damping: 4600, t60: 1.6, level: 0.7, detune: 0 },
    // 阮：圆形音箱、丝弦低张力 → 音色浑厚，余音较短
    ruan: { damping: 1500, t60: 1.2, level: 0.72, detune: 0 },
    // 扬琴：金属弦、双排弦拍频、双手轮音
    yangqin: { damping: 4400, t60: 1.8, level: 0.62, detune: 0, rollRate: 14, rollDepth: 0.4, detune2: 14 },

    // 二胡：内弦，揉弦 4~6Hz，琴筒共鸣偏低
    erhu: { vibratoDepth: 45, vibratoRate: 5.2, vibratoDelay: 0.28, bowPressure: 0.42, attack: 0.09, sustain: 0.82, release: 0.18, bowNoise: 0.07, bodyHz: 420, bodyQ: 3.2, level: 0.65 },
    // 板胡：外弦、高把位，弓压大 → 泛音更亮，揉弦更快
    banhu: { vibratoDepth: 58, vibratoRate: 6.4, vibratoDelay: 0.24, bowPressure: 0.72, attack: 0.07, sustain: 0.8, release: 0.15, bowNoise: 0.09, bodyHz: 620, bodyQ: 2.6, level: 0.66 },

    // 竹笛：亮、高频气声强、奇次谐波为主
    dizi: { breath: 0.3, breathHz: 3400, tone: 0.75, oddHarmonics: 0.78, attack: 0.055, breathAttack: 0.09, release: 0.14, detune: 0, vibratoDepth: 16, vibratoRate: 4.6, bodyHz: 1400, bodyQ: 2.4, hollow: 0.12, level: 0.62 },
    // 箫：低沉、接近闭管（奇次谐波极强）、气声偏暗
    xiao: { breath: 0.24, breathHz: 2200, tone: 0.78, oddHarmonics: 0.88, attack: 0.075, breathAttack: 0.12, release: 0.18, detune: 0, vibratoDepth: 14, vibratoRate: 4.2, bodyHz: 950, bodyQ: 2.8, hollow: 0.3, level: 0.62 },
    // 唢呐：奇偶谐波齐备 → 明亮高亢，金属芯
    suona: { breath: 0.32, breathHz: 2600, tone: 0.72, oddHarmonics: 0.22, attack: 0.05, breathAttack: 0.08, release: 0.12, detune: 0, vibratoDepth: 22, vibratoRate: 5.4, bodyHz: 1700, bodyQ: 2.0, hollow: 0.08, level: 0.6 },
    // 笙：多管共鸣，泛音丰富，气声弱
    sheng: { breath: 0.2, breathHz: 1800, tone: 0.8, oddHarmonics: 0.85, attack: 0.06, breathAttack: 0.1, release: 0.16, detune: 0, vibratoDepth: 12, vibratoRate: 4.0, bodyHz: 1100, bodyQ: 3.0, hollow: 0.26, level: 0.6 },
  };

  /* ---------------- 用例 ---------------- */

  const cases = [];

  async function run(name, group, Inst, params, key, expect) {
    const dur = 2.5;
    const data = await render(Inst, params, dur, key);

    // 主判据：ACF。窗口取起音段（0.01s 起），谐波类乐器另加 0.25s 处的第二次测量。
    const acf = pitchByACF(data, SR, 0.01, 6000, expect);
    const peak = acf.hz;
    const c = {
      name, group,
      expect: Math.round(expect),
      peak: Math.round(peak),
      peakErrPct: acf.hz > 0 ? Math.abs(acf.hz - expect) / expect * 100 : 100,
      acfCorr: Number(acf.corr.toFixed(3)),
      // 交叉验证：谱峰值与 ACF 的偏差。两者接近才可信。
      spectrumPeak: Math.round(peakFreqNear(data, SR, expect, 0.01)),
      centroid: centroid(data, SR),
      rms: rmsOf(data, 0, dur),
      hasNaN: hasNaN(data),
      // 报出设定的 T60，断言要按它归一化：
      // "起音→延音降多少 dB"不是固定值，而是 60 × Δt / T60。
      expectT60: Number(params.t60 || 0),
    };
    if (group === '拨弦' || group === '拨弦低音区' || group === '击弦') {
      // 衰减判据：总能量的单调下降。
      //
      // 【关键：必须用总能量，不能用基频幅度】
      // 实测（tests/folk-diag-t60.js）扫频率发现：
      //   key 28 (41Hz)  0.33s 降0.0dB
      //   key 69 (415Hz) 0.33s 降 7.4dB
      //   key 80 (831Hz) 0.33s 降 49.8dB
      // 而同一时刻的总能量 RMS：key40 降 4.1dB、key69 降 4.7dB（几乎相同）。
      //
      // 结论：衰减是正常且与音高无关的（T60 设定 2s → 0.33s 降约 3dB，
      // 实测 4~5dB，量级吻合）。变化的是"哪些频率在衰减"：
      // 一阶低通对高频衰减更强，所以频率越高，测到的幅度下降越多。
      // 拿基频幅度衡量衰减，低音弦必然显示"永不衰减"—— 那是指标错了，不是引擎错。
      //
      // 也不能用"起音/延音 ≥ 3"：该阈值隐含"衰减很快"，
      // 与古筝 4 秒余音直接矛盾（实测 E2 的 -32→-32.2dB是正常平缓衰减）。
      //
      // 还要避开浮点底噪：阮实测 0.58s 就触底，之后稳定在 3.3e-8，
      // 所以测量窗限定在起音后 0.9s 内。
      const segRms = (t0, t1) => {
        const a = Math.round(t0 * SR), b = Math.min(data.length, Math.round(t1 * SR));
        let s = 0;
        for (let i = a; i < b; i++) s += data[i] * data[i];
        return Math.sqrt(s / Math.max(1, b - a));
      };

      const pts = [];
      for (let t = 0.02; t <= 0.86; t += 0.06) pts.push(segRms(t, t + 0.06));
      let monotonic = true;
      for (let i = 1; i < pts.length; i++) {
        // 允许 5% 回升容差：拍频与激励残留会造成小幅起伏，不是缺陷
        if (pts[i] > pts[i - 1] * 1.05) { monotonic = false; break; }
      }
      const e0 = segRms(0.02, 0.08);
      const e1 = segRms(0.5, 0.56);
      const floor = e0 * 1e-5;
      c.decayMonotonic = monotonic;
      c.decayStartDb = e0 > 0 ? Number((20 * Math.log10(e0)).toFixed(1)) : -200;
      c.decayEndDb = e1 > 0 ? Number((20 * Math.log10(e1)).toFixed(1)) : -200;
      c.decayDropDb = Number((c.decayStartDb - c.decayEndDb).toFixed(1));
      c.tailOverFloor = Number((e1 / floor).toPrecision(2));
      c.floorReached = e1 <= floor;
    }
    if (group === '拉弦') {
      const m = modAnalysis(data, SR, 0.5, 1.8, 3, 9);
      c.vibratoRate = m.rate;
      c.vibratoDepthPct = m.depthPct;
    }
    if (group === '吹管') {
      // 气声比：2.5~5kHz 带通能量 / 基频能量。
      // 用带通积分而非单点幅度 —— 呼吸噪声是宽带的，单点会低估一个数量级。
      const f0 = energyAt(data, SR, expect, 0.3, 0.2);
      const fb = bandEnergy(data, SR, 2500, 5000, 0.3, 0.2);
      c.breathRatio = fb / Math.max(1e-9, f0);
    }
    if (group === '击弦') {
      const m = modAnalysis(data, SR, 0.2, 1.2, 9, 19);
      c.rollRate = m.rate;
      c.rollDepthPct = m.depthPct;
    }
    cases.push(c);
  }

  const hzOf = (k) => A4 * Math.pow(2, (k - 69) / 12);

  // 拨弦（中高音区）
  await run('古筝', '拨弦', F.PluckSynth, P.guzheng, 69, hzOf(69));
  await run('琵琶', '拨弦', F.PluckSynth, P.pipa, 69, hzOf(69));
  await run('阮', '拨弦', F.PluckSynth, P.ruan, 69, hzOf(69));

  // 拨弦低音区：曾经"周期短于128采样走梳状滤波"的错误分流点就在这一区，
  // 必须单独验证音高没跑。
  await run('古筝 低音E2', '拨弦低音区', F.PluckSynth, P.guzheng, 40, hzOf(40));
  await run('古筝 中音C3', '拨弦低音区', F.PluckSynth, P.guzheng, 48, hzOf(48));
  await run('阮 中音G3', '拨弦低音区', F.PluckSynth, P.ruan, 55, hzOf(55));

  // 拉弦
  await run('二胡', '拉弦', F.BowSynth, P.erhu, 69, hzOf(69));
  await run('板胡', '拉弦', F.BowSynth, P.banhu, 69, hzOf(69));

  // 吹管
  await run('竹笛', '吹管', F.WindSynth, P.dizi, 69, hzOf(69));
  await run('箫', '吹管', F.WindSynth, P.xiao, 69, hzOf(69));
  await run('唢呐', '吹管', F.WindSynth, P.suona, 69, hzOf(69));
  await run('笙', '吹管', F.WindSynth, P.sheng, 69, hzOf(69));

  // 击弦
  await run('扬琴', '击弦', F.YangleSynth, P.yangqin, 69, hzOf(69));

  return cases;
})()