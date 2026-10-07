/**
 * Karplus-Strong 音频Worklet
 * ============================================
 *
 * 为什么必须用 Worklet，不能用 DelayNode + BiquadFilter 搭环：
 *
 * 【实测结论，本条推翻了我最初的判断】
 *   在反馈环里放 BiquadFilter(lowpass) 会指数发散。
 *   隔离实验（tests/folk-diag-delay.js）结果：
 *     纯DelayNode+Gain 反馈环 + 噪声激励 → 稳定衰减（trend = 1e-11）✓
 *     同样环路加一个 BiquadFilter        → 指数发散（trend = 1e15）  ✗
 *   反推增益：每周期净增益 1.052，fb=0.94 ⇒ 滤波器在 440Hz 处增益 1.119（+0.97dB）。
 *   RBJ 低通在截止频率以下增益应为 1.0，这个 +0.97dB 来自 Chromium
 *   在反馈环中对 BiquadFilter 插入一个渲染量子延迟所导致的系数失配。
 *
 * 【梳状滤波替代方案也不成立】
 *   对周期为 D 的信号，comb 的 z^-D = 1，增益恒为 (1-a)/(1-a) = 1，
 *   对所有谐波都不衰减 —— 原理上就不是阻尼。所以"短延迟走 comb"的写法是错的。
 *
 * 【为什么不用 AudioParam】
 *   实测（tests/folk-diag-bisect.js）本机 OfflineAudioContext 中，
 *   带 parameterDescriptors 的 WorkletNode 输出恒为 0，process() 一次都不被调用；
 *   不带 AudioParam 的则完全正常（peak=1，频率精确）。
 *   而 AudioParam 正是实时演奏时做平滑参数变化的常规手段。
 *
 *   折中方案（本文件采用）：
 *   · 不声明任何 AudioParam，参数全部走 processorOptions（同步、可靠）
 *   · 每个声部一个 WorkletNode 实例，参数在构造时确定
 *   · 实时路径靠创建新声部时传参；对已发声的声部改参数需要重建声部，
 *     所以 PluckWorkletSynth 在 setParams 时会标记待重建，
 *     下一次 noteOn 生效。拨弦是一击即发的乐器，这个延迟感知不到。
 *
 * 【离线渲染下 port.postMessage 赶不上】
 *   实测（tests/folk-diag-worklet2.js）：渲染前postMessage({gain:0.9})，
 *   输出峰值仍是构造时的 0.5。离线渲染一口气同步跑完，消息在渲染后才投递。
 *   所以离线路径绝不能靠 message 传参，必须用 processorOptions。
 *
 * 【起音时刻必须走 processorOptions.startTime】
 *   AudioWorkletNode 没有 start(time) 方法（那是 OscillatorNode 独有的），
 *   节点的出声时刻就是它被 connect 之后的第一个渲染量子。
 *   离线导出时所有音符是在渲染开始前一次性排入的，
 *   若不告诉 worklet 何时该出声，全部音符会挤在t=0 齐响 —— 导出结果是一声糊响。
 *   process() 里读全局 currentFrame 与 startFrame 比较即可，零成本。
 *
 * 【加载方式】
 *   用 Blob URL 内联注入，不依赖任何文件路径。
 *   正式包用 file:// 协议加载页面，file:// 下的 addModule 会被 CORS 拦，
 *   而 Blob URL 在任何协议下都可用。
 */

/**
 * Worklet 源码以字符串形式内联。
 *
 * 这段代码运行在 AudioWorkletGlobalScope 里，不能引用外部任何变量，
 * 也不能用 TypeScript 语法 —— 它是原样发给浏览器的字符串。
 */
export const KS_WORKLET_SOURCE = `
class StringVoice {
  constructor(sr, freq, damping, t60Sec, seed) {
    this.sr = sr;
    this.N = Math.max(2, Math.round(sr / Math.max(20, freq)));
    this.buf = new Float32Array(this.N);
    this.idx = 0;
    // 一阶低通系数。exp(-2*pi*fc/fs) 是单极点低通的标准形式，
    // fc 越高系数越接近 1（越亮、衰减越慢）。
    this.alpha = Math.exp((-2 * Math.PI * Math.min(16000, Math.max(120, damping))) / sr);
    // 每采样衰减系数。
    //
    // decay 的语义是 T60（衰减 60dB 所需秒数），可直接对应乐器的物理量：
    // 古筝余音 3~5s、琵琶 1.5~2s、阮 1~1.5s。比抽象的"衰减速度系数"可校准得多。
    //
    // 【换算公式 —— 这里的 20 曾写错过，必须实测确认】
    // T60 的定义：经过 T60 秒，幅度降为 1/1000（-60dB）。
    // 设每采样系数为 k，则 T60 秒（k^(T60*sr) 次）后：
    //     k^(T60*sr) = 10^(-3)
    //     k = 10^(-3 / (T60 * sr))
    //
    // 早先写成 10^(-3 / (20 * T60 * sr))，多了一个因子 20。
    // 实测（damping=200，阻尼几乎不起作用时）：
    //     t60=0.5 理论降 57.6dB，实测 2.88dB
    //     t60=1   理论降 28.8dB，实测 1.44dB
    //     t60=2   理论降 14.4dB，实测 0.72dB
    // 恒为理论值的 1/20 —— 正是那个多余的 20 造成的。
    //
    // 少掉的那个 20 从哪来的：把"幅度比 1/1000"误当成"功率比 1/1000"。
    // dB 有 20log（幅度）和 10log（功率）两种定义，幅度对应 20log，
    // 但这里要算的是幅度衰减系数本身，不能多带一次 20。
    const t60 = Math.max(0.05, Math.min(20, t60Sec));
    this.decayCoef = Math.pow(10, -3 / (t60 * sr));
    // env：T60 衰减的累积包络。每采样乘 decayCoef，实现与音高无关的时间常数。
    this.env = 1;
    this.gate = 1;
    this.gateTarget = 1;
    this.gateCoef = 0.0006;
    this.exciteLeft = Math.max(4, Math.round(this.N * 1.2));
    this.exciteAmp = 0.9;
    this.seed = seed >>> 0;
    this.dead = false;
    this.maxAbs = 0;
  }
  // xorshift32，与主线程 makeNoise 同一个算法。
  // 线性同余 seed*1103515245 在 JS 里会超出 32 位安全整数导致随机性坍缩成准周期信号。
  rand() {
    let s = this.seed;
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    this.seed = s;
    return (s / 0xffffffff) * 2 - 1;
  }
  // 拨弦一次。写入激励噪声。
  pluck(amp) {
    this.exciteAmp = amp;
    this.exciteLeft = Math.max(4, Math.round(this.N * 1.2));
    this.gate = 1;
    this.gateTarget = 1;
    this.env = 1;
    this.dead = false;
  }
  release() { this.gateTarget = 0; }
  kill() { this.gate = 0; this.gateTarget = 0; this.dead = true; }
  run(out, offset, count, level) {
    for (let i = 0; i < count; i++) {
      const o = this.buf[this.idx];
      // 弦阻尼：一阶低通，只负责"高频损失"（音色）。
      // 注意它在反馈环内每采样施加一次，累积衰减很强，
      // 所以它同时也是弦能量衰减的主要来源 —— 不能承担 T60 的控制职责。
      this.lp = (this.lp || 0) * this.alpha + o * (1 - this.alpha);
      let v = this.lp;
      if (this.exciteLeft > 0) {
        // 激励噪声不经过 decayCoef，也不经过低通：
        // 真实拨弦的激励能量与弦本身的衰减是独立的。
        v += this.rand() * this.exciteAmp;
        this.exciteLeft--;
      }
      // 释放包络（noteOff / kill 时才生效，正常演奏不参与）
      if (this.gateTarget === 0 && this.gate > 0) {
        this.gate *= (1 - this.gateCoef);
        if (this.gate < 0.0001) { this.gate = 0; this.dead = true; }
      }
      // T60 衰减：独立作用于总输出，不写回延迟线。
      //
      // 【位置为什么这样选 —— 实测踩出来的】
      // 早先把 decayCoef 乘在写回延迟线的值上（v = lp * decayCoef），
      // 结果 T60 参数完全失效：t60 从 0.3扫到 10，0.48s 衰减恒为 5.6dB。
      //
      // 反推原因：环内每采样施加一次一阶低通，其自身累积衰减已主导能量，
      // 且该低通把信号压缩到极小的量级（alpha=0.616 时每周期 N=100 次），
      // decayCoef 的相对影响被淹没到测不出来。
      //
      // 现在 decayCoef 只在输出端施加（this.env *= decayCoef），
      // 与阻尼完全解耦：T60 成为真正独立、可预测的余音控制。
      this.env *= this.decayCoef;
      // env 低于可闻阈值时停声部，省掉后续计算
      if (this.env < 1e-6) { this.dead = true; this.env = 0; }

      const y = v * this.gate * this.env * level;
      if (y > this.maxAbs) this.maxAbs = y;
      if (y < -this.maxAbs) this.maxAbs = -y;
      out[offset + i] = y;
      // 不再写回衰减后的值：写回的是"未经 T60 衰减的弦状态"，
      // 这样 T60 完全由 env 控制，与阻尼解耦。
      this.buf[this.idx] = v;
      this.idx = (this.idx + 1) % this.N;
    }
  }
}

class KSProcessor extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const po = (opts && opts.processorOptions) || {};
    this.voices = [];
    this.dying = 0;
    this.level = po.level === undefined ? 0.7 : po.level;
    this.seedBase = (po.seed || 0x9e3779b9) >>> 0;
    // strings>1 时模拟双排弦：每根弦一个独立 StringVoice，周期按 detuneCents 微移，
    // 于是产生真实的拍频（beating），而不是简单叠加同频信号。
    this.detuneCents = po.detuneCents || 0;
    this.stringCount = Math.max(1, Math.min(4, po.strings || 1));
    this.vFreq = po.freq || 440;
    this.vDamp = po.damping === undefined ? 3200 : po.damping;
    // 字段名必须是 t60 —— 与 StringVoice 的第 4 个参数（t60Sec）对上。
    // 曾经写成 po.decay，而主线程传的是 po.t60，
    // 于是 t60 被静默丢弃、恒取默认值 1。
    // 症状：实测 t60 从 0.3扫到 10，0.48s 衰减恒为 6.1dB，与设定完全无关。
    this.vT60 = po.t60 === undefined ? 2.5 : po.t60;
    // 起音时刻（秒）。AudioWorkletNode 没有 start(time)，
    // 必须自己在 process 里比对全局 currentFrame，否则离线导出的
    // 全部音符会在 t=0 齐响，导出结果糊成一团。
    this.startFrame = po.startTime === undefined ? 0 : Math.max(0, po.startTime * sampleRate);
    this.n = 0;
    this.makeVoices();

    // 实时路径用message；离线路径下消息赶不上渲染（见文件头说明），
    // 但保留它可以让实时演奏时复用同一个 processor。
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'pluck') { this.pluck(m.amp === undefined ? 1 : m.amp); }
      else if (m.type === 'release') { for (const v of this.voices) v.release(); }
      else if (m.type === 'kill') { for (const v of this.voices) v.kill(); }
    };
  }
  makeVoices() {
    this.voices = [];
    for (let s = 0; s < this.stringCount; s++) {
      // 音分→频率比
      const ratio = Math.pow(2, -(this.detuneCents * s) / 1200);
      const v = new StringVoice(sampleRate, this.vFreq * ratio, this.vDamp, this.vT60,
        (this.seedBase + s * 0x9e3779b9) >>> 0);
      v.lp = 0;
      this.voices.push(v);
    }
  }
  pluck(amp) {
    this.n++;
    let s = this.seedBase;
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    this.seedBase = s >>> 0;
    for (let i = 0; i < this.voices.length; i++) {
      // 多弦时逐次降低激励音量，模拟双排弦的力度差
      this.voices[i].pluck(amp * (i === 0 ? 1 : 0.72));
    }
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    const n = out.length;
    // 还没到起音时刻：保持活跃但输出静音。
    // 这里绝不能 return false —— 那样节点会被回收，之后再也等不到起音。
    if (currentFrame < this.startFrame) {
      out.fill(0);
      return true;
    }
    let alive = 0;
    for (let k = 0; k < this.voices.length; k++) {
      const v = this.voices[k];
      if (v.dead && v.gate === 0) continue;
      v.run(out, 0, n, this.level / Math.max(1, Math.sqrt(this.voices.length)));
      alive++;
    }
    if (alive === 0) {
      out.fill(0);
      return false; // 全部声部已停→ 让节点被回收
    }
    return true;
  }
}
registerProcessor('ks-string', KSProcessor);
`;

/**
 * Worklet 模块加载（每个 AudioContext 只需一次）。
 *
 * 注意：加载是异步的，而 OfflineAudioContext 必须 await addModule 之后
 * 才能创建节点。调用方（PluckWorkletSynth）通过 ready() 等待。
 */
const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

export function ensureKSWorklet(ctx: BaseAudioContext): Promise<void> {
  let p = loaded.get(ctx);
  if (!p) {
    const blob = new Blob([KS_WORKLET_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    p = ctx.audioWorklet.addModule(url).then(() => {
      // 用完立刻 revoke：模块已加载进worklet 线程，不再需要这个 URL。
      // 不 revoke 会一直持有 Blob，在长时间使用的编辑器里会累积内存。
      URL.revokeObjectURL(url);
    }).catch((e) => {
      // 加载失败时清掉缓存，否则这个 context 永远处于失败态，
      // 后续重试会直接拿到同一个 rejected promise。
      loaded.delete(ctx);
      throw e;
    });
    loaded.set(ctx, p);
  }
  return p;
}