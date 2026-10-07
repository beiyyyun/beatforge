/**
 * 诊断 15：T60 衰减与阻尼衰减的叠加关系。
 *
 * 实测（t60=4, damping=3400, A4, 0.48s 窗口）：
 *   古筝 T60=4.0 damping=3400 → 降 6.5dB（理论 7.2）
 *   琵琶 T60=1.6 damping=4600 → 降 7.1dB（理论 18.0）
 *   阮   T60=1.2 damping=1500 → 降 3.9dB（理论 24.0）
 *
 * 阮的 damping 最低（1500）但衰减也最小，与"阻尼主导"矛盾。
 * 琵琶 damping 高（4600）衰减 7.1，阮 damping 低（1500）衰减 3.9，
 * 看起来阻尼越高衰减越快 —— 与一阶低通的行为一致。
 *
 * 但 T60 的影响也存在（A组：t60 0.3→10 时降 10.9→6.2）。
 * 两者是乘性叠加还是某种耦合？必须测出来。
 *
 * 做法：二维扫描 damping × t60，拟合出关系，再据此定标。
 */
(async () => {
  const SR = 44100;
  const F = window.FOLK;

  async function render(params, key, dur) {
    const ctx = new OfflineAudioContext(1, Math.ceil(SR * dur), SR);
    const e = new F.PluckSynth(ctx, ctx.destination);
    if (e.ready_) await e.ready_();
    e.noteOn(key, 0, 0.85, params, 'n1');
    e.releaseAll(dur - 0.2, params);
    const buf = await ctx.startRendering();
    return buf.getChannelData(0);
  }

  const segRms = (d, t0, t1) => {
    const a = Math.round(t0 * SR), b = Math.round(t1 * SR);
    let s = 0;
    for (let i = a; i < b; i++) s += d[i] * d[i];
    return Math.sqrt(s / Math.max(1, b - a));
  };

  const out = { grid: [], summary: '' };

  for (const damping of [800, 1500, 3400, 6000]) {
    const row = { damping, cells: [] };
    for (const t60 of [0.5, 1, 2, 4, 8]) {
      const d = await render({ damping, t60, level: 0.7, detune: 0 }, 69, 3);
      const e0 = segRms(d, 0.02, 0.08), e1 = segRms(d, 0.5, 0.56);
      const drop = 20 * Math.log10(e0 / Math.max(1e-30, e1));
      row.cells.push({ t60, drop: Number(drop.toFixed(2)), theory: Number((60 * 0.48 / t60).toFixed(1)) });
    }
    out.grid.push(row);
  }

  // 是否可分离：drop(d,t) - drop(d,∞) 应等于 t60 项
  out.summary =
    '若对每行（固定 damping），drop 随 t60 单调下降则 t60 有效；' +
    '若每列（固定 t60），drop 随 damping 单调上升则阻尼有效。';

  // 额外：把 damping 推到极低，看是否只剩 t60 的贡献
  const tiny = [];
  for (const t60 of [0.5, 1, 2, 4, 8]) {
    const d = await render({ damping: 200, t60, level: 0.7, detune: 0 }, 69, 3);
    const e0 = segRms(d, 0.02, 0.08), e1 = segRms(d, 0.5, 0.56);
    tiny.push({ t60, drop: Number((20 * Math.log10(e0 / Math.max(1e-30, e1))).toFixed(2)) });
  }
  out.lowDamping = tiny;

  return out;
})()