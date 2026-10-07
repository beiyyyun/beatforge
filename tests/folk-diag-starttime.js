/**
 * 离线路径诊断：验证 KS Worklet 的 startTime 是否真的生效。
 * 理由：export.ts 要在渲染开始前把整首曲子的音符一次性排入，
 * 若音符全挤在 t=0，导出结果就是一声糊响 —— 而这在界面上看不出来，
 * 只能靠离线渲染的波形暴露。必须实测。
 */
(async () => {
  const F = window.FOLK;
  const SR = 44100;
  const out = [];

  /**
   * 渲染若干拨弦音符，报告每个音符的能量起始时刻。
   * 判据：第 k 个音符的起音时刻应接近k * 间隔。
   */
  async function renderSchedule(times, gapSec, dur) {
    const ctx = new OfflineAudioContext(1, Math.ceil(SR * dur), SR);
    await F.preparePluck(ctx);
    const g = ctx.createGain();
    g.gain.value = 1;
    g.connect(ctx.destination);
    const synth = new F.PluckSynth(ctx, g);
    times.forEach((t, i) => {
      synth.noteOn(60, t, 0.8, { damping: 3400, t60: 1.5, level: 0.7, detune: 0 });
    });
    const buf = await ctx.startRendering();
    return buf.getChannelData(0);
  }

  /** 找出能量首次超过阈值的时间点 */
  function onsetOf(data, thr) {
    for (let i = 0; i < data.length; i++) {
      if (Math.abs(data[i]) > thr) return i / SR;
    }
    return -1;
  }

  /** 按窗口统计 RMS，用于看包络形状 */
  function rmsCurve(data, winSec) {
    const n = Math.round(SR * winSec);
    const pts = [];
    for (let a = 0; a + n <= data.length; a += n) {
      let s = 0;
      for (let i = a; i < a + n; i++) s += data[i] * data[i];
      pts.push(Math.sqrt(s / n));
    }
    return pts;
  }

  function peakOf(data) {
    let p = 0;
    for (let i = 0; i < data.length; i++) p = Math.max(p, Math.abs(data[i]));
    return p;
  }

  // ---- 用例1：4 个音符，间隔 0.5s，应分别在 0/0.5/1.0/1.5s 附近起音 ----
  {
    const times = [0.1, 0.6, 1.1, 1.6];
    const data = await renderSchedule(times, 0.5, 3.0);
    // 包络峰值应出现在音符起点附近
    const curve = rmsCurve(data, 0.05).map((v) => Number(v.toPrecision(3)));
    // 找出 4 个局部极大
    const peaks = [];
    for (let i = 2; i < curve.length - 2; i++) {
      if (curve[i] > curve[i - 1] && curve[i] > curve[i - 2]
        && curve[i] >= curve[i + 1] && curve[i] >= curve[i + 2] && curve[i] > 1e-3) {
        peaks.push(Number((i * 0.05).toFixed(2)));
      }
    }
    out.push({
      case: '拨弦多音符错峰',
      expect: '4 个起音峰值 ≈ 0.1 / 0.6 / 1.1 / 1.6s',
      peakTimes: peaks,
      peakAmp: Number(peakOf(data).toFixed(4)),
      firstOnset: Number(onsetOf(data, 1e-4).toFixed(3)),
      // 若startTime 失效：所有音符在 t=0 齐响，起音只有一个峰
      distinctPeaks: peaks.length,
      curveHead: curve.slice(0, 12),
      pass: peaks.length >= 4 && peaks[0] >= 0.05 && peaks[0] <= 0.25,
    });
  }

  // ---- 用例2：单个音符在 t=1.0s，之前必须完全静音 ----
  {
    const data = await renderSchedule([1.0], 0, 2.0);
    let pre = 0;
    for (let i = 0; i < Math.round(0.95 * SR); i++) pre = Math.max(pre, Math.abs(data[i]));
    let post = 0;
    for (let i = Math.round(1.02 * SR); i < data.length; i++) post = Math.max(post, Math.abs(data[i]));
    out.push({
      case: '起音时刻精确性',
      expect: '1.0s 之前绝对静音，之后有声',
      preMax: pre,
      postMax: Number(post.toFixed(4)),
      firstOnset: Number(onsetOf(data, 1e-4).toFixed(3)),
      pass: pre < 1e-6 && post > 1e-3,
    });
  }

  // ---- 用例3：扬琴轮音在延后起音时不应提前空转 ----
  {
    const ctx = new OfflineAudioContext(1, Math.ceil(SR * 2.5), SR);
    await F.preparePluck(ctx);
    const g = ctx.createGain();
    g.connect(ctx.destination);
    const synth = new F.YangleSynth(ctx, g);
    synth.noteOn(60, 1.0, 0.8, {
      damping: 4400, t60: 1.8, level: 0.62, detune: 0,
      rollRate: 14, rollDepth: 0.4, detune2: 14,
    });
    const data = (await ctx.startRendering()).getChannelData(0);
    let pre = 0;
    for (let i = 0; i < Math.round(0.95 * SR); i++) pre = Math.max(pre, Math.abs(data[i]));
    out.push({
      case: '扬琴延后起音（轮音不提前空转）',
      expect: '1.0s 之前静音（否则轮音振荡器会空转并调制出声音）',
      preMax: pre,
      firstOnset: Number(onsetOf(data, 1e-4).toFixed(3)),
      pass: pre < 1e-5,
    });
  }

  // ---- 用例4：导出链路的完整路径（renderProject 用的是同一套 noteOn） ----
  // 直接模拟：一个 track + 一段音符 + 主总线，确认不是"单测过、集成挂"
  {
    const ctx = new OfflineAudioContext(2, Math.ceil(SR * 2.0), SR);
    await F.preparePluck(ctx);
    const input = ctx.createGain();
    const vol = ctx.createGain();
    const pan = ctx.createStereoPanner();
    input.connect(vol);
    vol.connect(pan);
    pan.connect(ctx.destination);
    vol.gain.value = 0.8;
    pan.pan.value = 0;
    const synth = new F.PluckSynth(ctx, input);
    // 模拟 export.ts 的排布：secPerStep 排入
    const secPerStep = 0.125;
    const steps = [0, 2, 4, 8];
    for (const s of steps) {
      synth.noteOn(48 + s, s * secPerStep, 0.85,
        { damping: 3400, t60: 3.0, level: 0.7, detune: 0 });
    }
    const buf = await ctx.startRendering();
    const l = buf.getChannelData(0);
    const r = buf.getChannelData(1);
    let peak = 0, nan = false;
    for (let i = 0; i < l.length; i++) {
      const v = Math.abs(l[i]);
      if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) nan = true;
      if (v > peak) peak = v;
    }
    out.push({
      case: '导出拓扑（input→vol→pan→dest）',
      expect: '有输出、无 NaN、双声道一致',
      peak: Number(peak.toFixed(4)),
      hasNaN: nan,
      stereoMatch: Math.abs(l[20000] - r[20000]) < 1e-9,
      pass: peak > 1e-3 && !nan,
    });
  }

  return out;
})()