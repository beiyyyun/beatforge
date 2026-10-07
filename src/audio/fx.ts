/**
 * 效果器与混音总线
 * ============================================
 * 复刻 FL 的混音台拓扑：
 *   轨道 → 音量/声像 → 轨道效果器(insert) → ┬→ 主总线(带限幅器)
 *                                            ├→ 混响发送 → 混响总线
 *                                            └→ 延迟发送 → 延迟总线
 */

import type { InsertParams, Track } from '../core/types';

/** 混响脉冲响应：用算法生成，不加载 IR 文件 */
function makeImpulseResponse(
  ctx: BaseAudioContext,
  decay: number,
  predelay: number,
): AudioBuffer {
  const rate = ctx.sampleRate;
  const predelaySamples = Math.floor(predelay * rate);
  const len = Math.max(1, Math.floor(rate * Math.max(0.05, decay)));
  const total = len + predelaySamples;
  const buf = ctx.createBuffer(2, total, rate);

  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    // 前置延迟段保持静音
    for (let i = 0; i < predelaySamples; i++) data[i] = 0;
    for (let i = 0; i < len; i++) {
      // 指数衰减包络 × 早期反射
      const env = Math.pow(1 - i / len, 2.4);
      const early = i < rate * 0.06 ? 1 + Math.sin(i * 0.05) * 0.35 : 1;
      data[predelaySamples + i] = (Math.random() * 2 - 1) * env * early;
    }
  }
  return buf;
}

/** 混响总线 */
export class ReverbBus {
  private input: GainNode;
  private convolver: ConvolverNode;
  private wet: GainNode;
  private dry: GainNode;
  private tone: BiquadFilterNode;

  constructor(private ctx: BaseAudioContext, destination: AudioNode) {
    this.input = ctx.createGain();
    this.convolver = ctx.createConvolver();
    this.wet = ctx.createGain();
    this.dry = ctx.createGain();
    this.tone = ctx.createBiquadFilter();

    this.tone.type = 'lowpass';
    this.tone.frequency.value = 7200; // 高频衰减，避免刺耳
    this.dry.gain.value = 1;
    this.wet.gain.value = 0.9;

    this.input.connect(this.dry);
    this.dry.connect(destination);
    this.input.connect(this.convolver);
    this.convolver.connect(this.tone);
    this.tone.connect(this.wet);
    this.wet.connect(destination);

    this.set(2.2, 0.02);
  }

  set(decay: number, predelay: number) {
    this.convolver.buffer = makeImpulseResponse(this.ctx, decay, predelay);
  }

  get node() { return this.input; }
}

/** 延迟总线（BPM 同步，模拟 FL 的拍值延迟） */
export class DelayBus {
  private input: GainNode;
  private delayL: DelayNode;
  private delayR: DelayNode;
  private feedback: GainNode;
  private wet: GainNode;
  private damp: BiquadFilterNode;
  private merger: ChannelMergerNode;

  constructor(private ctx: BaseAudioContext, destination: AudioNode) {
    this.input = ctx.createGain();
    this.delayL = ctx.createDelay(4);
    this.delayR = ctx.createDelay(4);
    this.feedback = ctx.createGain();
    this.wet = ctx.createGain();
    this.damp = ctx.createBiquadFilter();
    this.merger = ctx.createChannelMerger(2);

    this.damp.type = 'lowpass';
    this.damp.frequency.value = 4200; // 每次反馈衰减一点，模拟真实延迟
    this.feedback.gain.value = 0.42;
    this.wet.gain.value = 0.85;

    // 左右各加 12ms 偏移 → 立体声 ping-pong 感
    this.input.connect(this.delayL);
    this.delayL.connect(this.delayR);
    this.delayR.connect(this.damp);
    this.damp.connect(this.feedback);
    this.feedback.connect(this.delayL);
    this.delayL.connect(this.merger, 0, 0);
    this.delayR.connect(this.merger, 0, 1);
    this.merger.connect(this.wet);
    this.wet.connect(destination);

    this.setTime(0.375, 0.42);
  }

  setTime(seconds: number, fb: number) {
    const t = Math.max(0.01, Math.min(3.9, seconds));
    this.delayL.delayTime.setTargetAtTime(t, this.ctx.currentTime, 0.05);
    this.delayR.delayTime.setTargetAtTime(t + 0.012, this.ctx.currentTime, 0.05);
    this.feedback.gain.setTargetAtTime(
      Math.max(0, Math.min(0.95, fb)),
      this.ctx.currentTime,
      0.05,
    );
  }

  get node() { return this.input; }
}

/** 主总线：软限幅 + 高频轻微提升 + 输出增益 */
export class MasterBus {
  private input: GainNode;
  private limiter: DynamicsCompressorNode;
  private shelf: BiquadFilterNode;
  private output: GainNode;
  private analyser: AnalyserNode;

  constructor(ctx: BaseAudioContext, destination: AudioNode) {
    this.input = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.shelf = ctx.createBiquadFilter();
    this.output = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;

    // 限幅器参数：只压峰值，不明显影响动态
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 2;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;

    this.shelf.type = 'highshelf';
    this.shelf.frequency.value = 7200;
    this.shelf.gain.value = 2.5; // 输出轻微提亮

    this.input.connect(this.limiter);
    this.limiter.connect(this.shelf);
    this.shelf.connect(this.output);
    this.output.connect(this.analyser);
    this.analyser.connect(destination);
  }

  setVolume(v: number) {
    this.output.gain.value = v;
  }

  get node() { return this.input; }
  get meterData() { return this.analyser; }
}

/** 轨道效果器链：EQ → 失真 → 干湿输出 */
export function buildInsert(
  ctx: BaseAudioContext,
  params: InsertParams,
): { input: AudioNode; output: AudioNode; dispose: () => void } {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const nodes: AudioNode[] = [];
  let cursor: AudioNode = input;

  // --- EQ ---
  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 180;
  low.gain.value = params.lowGain;

  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = params.midFreq;
  mid.Q.value = 0.9;
  mid.gain.value = params.midGain;

  const high = ctx.createBiquadFilter();
  high.type = 'highshelf';
  high.frequency.value = 5200;
  high.gain.value = params.highGain;

  nodes.push(low, mid, high);

  // --- 失真 ---
  // 注意：软削波曲线在 drive>0 时中段增益 >1，需前后配对增益抵消，
  // 否则任何使用失真的通道都会过载。
  const preGain = ctx.createGain();
  preGain.gain.value = 1 + params.drive * 4;
  const shaper = ctx.createWaveShaper();
  const n = 1024;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  const k = params.drive * 3;
  const denom = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    // 归一化 tanh 软削波：两端 ±1 保持单位增益，中段产生谐波，永不过冲
    curve[i] = params.drive <= 0.001 ? x : Math.tanh(k * x) / denom;
  }
  shaper.curve = curve;
  shaper.oversample = '2x';
  const postGain = ctx.createGain();
  // 抵消 preGain 带来的增益；曲线本身已控制在 ±1 内
  postGain.gain.value = 1 / (1 + params.drive * 4);

  const toneFilter = ctx.createBiquadFilter();
  toneFilter.type = 'lowpass';
  toneFilter.frequency.value = 700 + (1 - params.tone) * 16000;

  nodes.push(preGain, shaper, postGain, toneFilter);

  cursor.connect(low);
  low.connect(mid);
  mid.connect(high);
  high.connect(preGain);
  preGain.connect(shaper);
  shaper.connect(postGain);
  postGain.connect(toneFilter);
  cursor = toneFilter;

  // --- 干湿混合 ---
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const mix = Math.max(0, Math.min(1, params.mix));
  dry.gain.value = mix;
  wet.gain.value = 1 - mix;

  cursor.connect(dry);
  cursor.connect(wet);
  dry.connect(output);
  wet.connect(output);

  const dispose = () => {
    for (const nd of nodes) { try { nd.disconnect(); } catch { /* noop */ } }
    try { dry.disconnect(); } catch { /* noop */ }
    try { wet.disconnect(); } catch { /* noop */ }
    try { output.disconnect(); } catch { /* noop */ }
  };

  return { input, output, dispose };
}