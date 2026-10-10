/**
 * 诊断：离线渲染下引擎对 time 参数的响应
 * ============================================
 *
 * 验证两个独立 bug：
 *
 * 【Bug A】BowSynth / WindSynth 的 noteOn 忽略 time 参数
 *   noteOn(key, _time, ...) 里 _time 被丢弃，BowVoice 构造时用
 *   ctx.currentTime（离线渲染时恒为 0）。后果：离线导出时
 *   所有拉弦/吹管音符挤在 t=0 齐响 —— 与之前修过的
 *   Pluck/Yangle startTime 问题同类，但漏修了这两类。
 *
 * 【Bug B】FMSynth 缺 noteOff
 *   engine.ts releaseNote 对无 noteOff 的引擎调 releaseAll()，
 *   把所有正在发声的 FM 声部一起掐断。两个重叠的 FM 音符，
 *   先结束的那个会把后结束的也一起切断。
 *
 * 方法：用 OfflineAudioContext 排两个错开的音符，渲染后
 * 分析波形包络，确认每个音符是否出现在正确时刻、持续正确长度。
 */
(async () => {
  const F = window.FOLK;
  const SR = 44100;
  const out = [];

  function rmsRange(data, a, b) {
    const i0 = Math.floor(a * SR);
    const i1 = Math.floor(b * SR);
    let s = 0;
    for (let i = i0; i < i1; i++) s += data[i] * data[i];
    return Math.sqrt(s / (i1 - i0));
  }

  // ---- Bug A：Bow/Wind 忽略 time ----
  // 两个音符 t=0.1 和 t=1.2。直接找 n2 的起音跳变：
  // 在 1.0~1.5s 区间按 50ms 细窗算 RMS。n2 若在 1.2s 起音，
  // 起音前后的窗口能量应有明显跳变；若 time 被忽略（n2 也在 0 起音），
  // 该区间只有 n1 的余音，能量曲线平滑、无跳变。
  for (const [name, Synth, defaults] of [
    ['BowSynth', F.BowSynth, F.BOW_DEFAULTS],
    ['WindSynth', F.WindSynth, F.WIND_DEFAULTS],
  ]) {
    const dur = 2.5;
    const ctx = new OfflineAudioContext(1, SR * dur, SR);
    const dest = ctx.createGain();
    dest.connect(ctx.destination);
    const synth = new Synth(ctx, dest);

    const p = { ...defaults, attack: 0.005, release: 0.05, sustain: 0.3 };
    synth.noteOn(69, 0.1, 0.9, p, 'n1');
    synth.noteOn(69, 1.2, 0.9, p, 'n2');

    const buf = await ctx.startRendering();
    const data = buf.getChannelData(0);

    // 50ms 细窗，覆盖 0.95 ~ 1.55s
    const curve = [];
    for (let a = 0.95; a < 1.55; a += 0.05) {
      curve.push(+rmsRange(data, a, a + 0.05).toFixed(4));
    }
    // 跳变比 = n2 起音后窗口（1.20~1.35）峰值 / 起音前窗口（1.00~1.15）均值
    const preIdx = [1, 2, 3];        // 1.00, 1.05, 1.10
    const postIdx = [5, 6, 7];       // 1.20, 1.25, 1.30
    const preAvg = preIdx.reduce((s, i) => s + curve[i], 0) / preIdx.length;
    const postMax = Math.max(...postIdx.map((i) => curve[i]));
    const jumpRatio = preAvg > 0 ? postMax / preAvg : Infinity;

    // time 被尊重：1.2s 处有明显能量跳变（jumpRatio 显著 > 1）
    // time 被忽略：n2 也在 0 起音，此区间只有 n1 余音，曲线平滑（≈1）
    const separated = jumpRatio > 1.5;
    out.push({
      case: `Bug A: ${name} noteOn 忽略 time 参数`,
      expect: 'n2 在 1.2s 起音，起音处能量跳变 > 1.5 倍',
      curve,
      preAvg: +preAvg.toFixed(4),
      postMax: +postMax.toFixed(4),
      jumpRatio: +jumpRatio.toFixed(3),
      separated,
      pass: separated,
    });
  }

  // ---- Bug B：FM 缺 noteOff，releaseAll 掐断重叠音符 ----
  // n1 从 t=0 持续，n2 从 t=0.5 持续。在 t=1.0 释放 n1。
  // 若 noteOff 正确实现，n2 应继续发声；若用 releaseAll，
  // n2 会被一起掐掉，t=1.2 后接近静音。
  {
    const dur = 3;
    const ctx = new OfflineAudioContext(1, SR * dur, SR);
    const dest = ctx.createGain();
    dest.connect(ctx.destination);
    const synth = new F.FMSynth(ctx, dest);

    const p = {
      ratio: 2, index: 3, algorithm: 'sine', feedback: 0,
      env: { attack: 0.005, decay: 1.2, sustain: 0.5, release: 0.8 },
      modEnv: { attack: 0.002, decay: 0.35, sustain: 0.25, release: 0.3 },
      filter: { type: 'lowpass', cutoff: 5200, resonance: 1.2, envAmount: 0 },
    };

    synth.noteOn(69, 0, 0.9, p, 'n1');
    synth.noteOn(72, 0.5, 0.9, p, 'n2');
    // t=1.0：释放 n1。noteOff 实现后应只释放 n1，n2 继续 sustain。
    // 修复前 FM 无 noteOff，engine.ts 会调 releaseAll 把 n2 也掐掉。
    if (synth.noteOff) synth.noteOff('n1', 1.0);
    else synth.releaseAll(1.0);

    const buf = await ctx.startRendering();
    const data = buf.getChannelData(0);

    const both = rmsRange(data, 0.6, 0.9);     // n1+n2 都在
    // releaseAll 在 t=1.0 触发，release=0.8s → t=1.8 衰减完毕。
    // afterRelease 测 2.0~2.5（衰减已结束）：
    //   若 n2 被正确保留（sustain=0.5），此时应显著有声
    //   若 n2 被 releaseAll 一起掐掉，此时已归零
    const afterRelease = rmsRange(data, 2.0, 2.5);

    // n2 存活：afterRelease 应有显著能量（n2 还在 sustain 阶段）
    // n2 被掐：afterRelease 接近 0（release 已衰减完毕）
    const n2Survived = afterRelease > 0.01;
    out.push({
      case: 'Bug B: FMSynth 缺 noteOff，releaseAll 掐断重叠音符',
      expect: 'n2 在 n1 释放后继续 sustain，2.0~2.5s 显著有声',
      bothRMS: +both.toFixed(4),
      afterReleaseRMS: +afterRelease.toFixed(4),
      n2Survived,
      pass: n2Survived,
      note: 'afterRelease 窗口放在 release 衰减（1.8s）之后，排除余音干扰',
    });
  }

  return out;
})()