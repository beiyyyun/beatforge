/**
 * 民乐合成引擎
 * ============================================
 * 为什么不能用现成的减法合成/FM 冒充民乐：
 * 那些引擎是为持续音设计的，而民乐的核心特征全在一击即发或强烈揉弦上：
 *   拨弦（古筝/琵琶/阮）—— 噪声激励 + 短延迟线反馈，泛音列由弦长决定，
 *     拨弦位置决定泛音结构。用减法合成只能得到"快速衰减的锯齿"，听感是风琴不是古筝。
 *   拉弦（二胡/板胡）—— 持续激励 + 4~6Hz 颤音 + 高次谐波集中。
 *     没有 vibrato 的二胡是电锯。
 *   吹管（竹笛/箫/唢呐/笙）—— 气声噪声与谐波混合，靠共振峰塑形。
 *     没有气声的笛子是 Organ。
 *
 * 实现方式：全部用 Web Audio 的基础节点实时合成，不引入任何采样文件。
 * 拨弦用 Karplus-Strong 强算法，实现在 AudioWorklet 里（见 ks-worklet.ts）：
 *   噪声激励 → 固定延迟（= 1/基频 的周期）→ 一阶低通（模拟弦阻尼）→ 反馈回延迟
 *
 * 【关于 "Web Audio 延迟下限" 的说明 —— 这条早先的注释是错的】
 *   原先写的是"DelayNode 最小 128 采样，所以低音区改用梳状滤波"。
 *   两处都不成立，已被实测推翻：
 *   ① minDelay = 128/sampleRate 只约束"单次通过延迟"的节点，
 *      而反馈环是另一回事，纯 DelayNode 反馈环实测稳定衰减（trend 1e-11）；
 *   ② 梳状滤波原理上就不能替代阻尼：对周期 D 的信号 z^-D=1，增益恒为 1。
 *   真正的障碍是 BiquadFilter 放进反馈环会指数发散（每周期净增益 1.052），
 *   根因是 Chromium 给环内的 BiquadFilter 插入渲染量子导致系数失配。
 *   用 Worklet 把整条环搬进音频线程，彻底绕开这个问题，
 *   同时低音区音高也精确了（实测 MIDI 40 = 82Hz，误差 0.0%）。
 */

import type { InstrumentEngine, AnyParams, ParamsView } from './registry';
import { ensureKSWorklet } from './ks-worklet';

/* ============================================================
 * 共用工具
 * ============================================================ */

/** 确定性噪声源。种子固定，保证同一音高每次起音的噪声形态一致（可重复、无抖动） */
function makeNoise(ctx: BaseAudioContext, seconds = 2): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  // xorshift32：线性同余 seed*1103515245 在 JS 里会超出32 位安全整数导致
  // 随机性坍缩成准周期信号（曾因此让音高检测诊断得出完全错误的结论）。
  let s = 0x9e3779b9;
  for (let i = 0; i < len; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    d[i] = (s / 0xffffffff) * 2 - 1;
  }
  return buf;
}

/**
 * MIDI 音高 → Hz。
 */
function hz(key: number): number {
  return 440* Math.pow(2, (key - 69) / 12);
}

/** 量化到安全下限，避免算出 0 或负数延迟造成静音/异常 */
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/* ============================================================
 * 一、拨弦类（Karplus-Strong）—— 古筝 / 琵琶 / 阮 / 扬琴
 * ============================================================ */

export interface PluckParams {
  /** 弦阻尼：低通截止（Hz）。越大越亮 */
  damping: number;
  /**
   * 余音长度 T60：衰减 60dB 所需秒数。
   * 用物理量而非抽象系数，才能直接对照真实乐器：
   * 古筝 3~5s、琵琶 1.5~2s、阮 1~1.5s。
   */
  t60: number;
  /** 起音音量 0~1 */
  level: number;
  /** 音高微调（音分），用于补偿演奏上的"跑调感" */
  detune: number;
}

export const PLUCK_DEFAULTS: PluckParams = {
  damping: 3200,
  t60: 2.5,
  level: 0.7,
  detune: 0,
};

/**
 * 一个声部 = 一个 AudioWorkletNode。
 *
 * 为什么不能再用 DelayNode + BiquadFilter 搭Karplus-Strong：
 * 环里放 BiquadFilter 会指数发散（实测每周期净增益 1.052，
 * 发散到1e15 量级），根因是 Chromium 在反馈环中给 BiquadFilter
 * 插入一个渲染量子导致系数失配，440Hz 处增益 1.119 而非 1.0。
 * 梳状滤波替代也不行：对周期 D 的信号 z^-D=1，comb 增益恒为 1，不衰减。
 * 细节与实测数据见 ks-worklet.ts 文件头。
 */
class PluckVoice {
  readonly bornAt: number;
  readonly node: AudioWorkletNode;
  private alive = true;

  constructor(
    private ctx: BaseAudioContext,
    private dest: AudioNode,
    freq: number,
    vel: number,
    p: PluckParams,
    strings: number,
    detuneCents: number,
    seed: number,
    startTime: number,
  ) {
    this.bornAt = ctx.currentTime;
    this.node = new AudioWorkletNode(ctx, 'ks-string', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      // 参数只能走 processorOptions：实测离线路径下 postMessage 赶不上渲染，
      // 而 AudioParam 在本机OfflineAudioContext 里会让输出恒为 0。
      processorOptions: {
        freq,
        damping: p.damping,
        t60: p.t60,
        level: Math.max(0.0001, p.level * vel),
        strings,
        detuneCents,
        seed,
        // 起音时刻。AudioWorkletNode 没有 start(time)，
        // 不显式告诉它何时出声，离线导出的所有音符会在 t=0 齐响。
        startTime,
      },
    });
    this.node.connect(dest);
  }

  stop() {
    if (!this.alive) return;
    this.alive = false;
    try { this.node.port.postMessage({ type: 'kill' }); } catch { /* noop */ }
    try { this.node.disconnect(); } catch { /* noop */ }
  }
}

export class PluckSynth implements InstrumentEngine {
  readonly type = 'pluck';
  private voices: PluckVoice[] = [];
  private cfg: PluckParams = PLUCK_DEFAULTS;
  private ready: Promise<void>;
  /** 声部种子序列，保证同一音高每次起音的噪声形态可重复 */
  private seedState = 0x9e3779b9;
  private strings = 1;
  private detuneCents = 0;

  constructor(private ctx: BaseAudioContext, private dest: AudioNode) {
    this.ready = ensureKSWorklet(ctx);
  }

  /** Worklet 加载完成前 noteOn 会被暂存，加载完再补发 */
  private pending: Array<() => void> = [];

  /** Worklet 就绪后可安全创建节点。调用方 await 它可确保首个音符不丢。 */
  async ready_(): Promise<void> {
    await preparePluck(this.ctx);
    const q = this.pending;
    this.pending = [];
    for (const fn of q) fn();
  }

  noteOn(key: number, time: number, velocity: number, params: AnyParams): void {
    const p = { ...PLUCK_DEFAULTS, ...(params as Partial<PluckParams>) };
    this.cfg = p;
    // 拨弦引擎也接扬琴类的额外字段（多弦 / 双排弦失谐），
    // 这样同一套物理参数既能拨弦也能击弦，不必写两遍。
    const extra = params as ParamsView;
    const strings = Number(extra?.strings ?? 1);
    const detune2 = Number(extra?.detune2 ?? 0);
    if (strings !== this.strings || detune2 !== this.detuneCents) {
      this.strings = strings;
      this.detuneCents = detune2;
    }
    const build = () => {
      // 换种子：同一个键反复弹要每次略有不同，否则机械感极重。
      let s = this.seedState;
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      this.seedState = s >>> 0;
      const freq = hz(key) * Math.pow(2, p.detune / 1200);
      const v = new PluckVoice(
        this.ctx, this.dest, freq, Math.max(0.02, velocity),
        p, this.strings, this.detuneCents, s >>> 0, time,
      );
      this.voices.push(v);
      // 上限保护：极端情况（快速轮指）下别让声部无限堆积
      if (this.voices.length > 48) this.voices.shift()?.stop();
    };
    if (workletReady.has(this.ctx)) build();
    else {
      // 存成闭包而不是参数对象：补发时直接调用 build()，
      // 保证用的是补发那一刻的最新参数。
      const q = this.pending;
      q.push(build);
      pendingByCtx.set(this.ctx, q);
    }
  }

  noteOff(): void { /* 一击即发，无需松开 */ }

  /**
   * 释放所有发声。
   *
   * 拨弦的自然衰减由弦阻尼决定，正常演奏中不该主动切断。
   * 这里只清理"超过存活时间"的旧声部，让它们释放占用的 worklet 线程。
   *
   * 早先这里遍历调用 v.stop()，而 stop() 里对 Worklet 发的是 kill 消息，
   * 于是整条弦在 t=0 被掐断，离线渲染 RMS=0。
   */
  releaseAll(_time: number): void {
    const now = this.ctx.currentTime;
    const stillLive = this.voices.filter((v) => now - v.bornAt < 61);
    for (const v of this.voices) {
      if (!stillLive.includes(v)) v.stop();
    }
    this.voices = stillLive;
  }

  /** 立即切断所有声部。仅在用户主动"停止"时用（正常停止应保留自然余音） */
  stopAll(): void {
    for (const v of this.voices) v.stop();
    this.voices = [];
  }

  panic(): void {
    this.stopAll();
  }

  dispose(): void { this.stopAll(); }
}

/** 标记该 context 的 KS worklet 已加载完毕，noteOn 才能安全建节点 */
const workletReady = new WeakSet<BaseAudioContext>();

/**
 * 每个 context 上"等待 worklet 就绪"的补发回调队列。
 *
 * 用 WeakMap 按 context 存，context 销毁时队列自动回收 —— 否则长期运行的
 * 编辑器每次新建 AudioContext 都会留一份闭包数组，是明确的内存泄漏。
 */
const pendingByCtx = new WeakMap<BaseAudioContext, Array<() => void>>();

/**
 * 把 KS worklet 装到 context 上，并把 context 标记为就绪。
 * 引擎构造时自动调用；调用方可 await 返回值确保首个音符不丢。
 */
export async function preparePluck(ctx: BaseAudioContext): Promise<void> {
  await ensureKSWorklet(ctx);
  workletReady.add(ctx);
  // 排空暂存队列：worklet 加载完成前noteOn 存下来的音符必须补发，
  // 否则首个音符永久丢失（用户表现为"第一下没声音"）。
  const waiting = pendingByCtx.get(ctx);
  if (waiting) {
    pendingByCtx.delete(ctx);
    for (const fn of waiting) fn();
  }
}

/* ============================================================
 * 二、拉弦类—— 二胡 / 板胡
 * ============================================================ */

export interface BowParams {
  /** 颤音深度（音分）。二胡约±35~60，板胡更大更粗 */
  vibratoDepth: number;
  /** 颤音频率 Hz。二胡揉弦 4~6Hz 是其"灵魂" */
  vibratoRate: number;
  /** 颤音起音延迟（秒）。真实揉弦是逐渐加大的，不是从头就有 */
  vibratoDelay: number;
  /** 弓压：影响高次谐波浓度 */
  bowPressure: number;
  /** 起音速度（秒）。弓弦起音比拨弦慢 */
  attack: number;
  /** 持续音的稳定度 0~1 */
  sustain: number;
  /** 松开时的余音 */
  release: number;
  /** 弦鸣噪声 0~1，弓与弦的摩擦声 */
  bowNoise: number;
  /** 共鸣腔（琴筒）共振峰频率 Hz */
  bodyHz: number;
  /** 共鸣峰强度 0~1 */
  bodyQ: number;
  level: number;
}

export const BOW_DEFAULTS: BowParams = {
  vibratoDepth: 42,
  vibratoRate: 5.2,
  vibratoDelay: 0.28,
  bowPressure: 0.45,
  attack: 0.09,
  sustain: 0.82,
  release: 0.18,
  bowNoise: 0.07,
  bodyHz: 420,
  bodyQ: 3.2,
  level: 0.65,
};

class BowVoice {
  private osc: Array<OscillatorNode | AudioBufferSourceNode> = [];
  private vib: OscillatorNode;
  private vibGain: GainNode;
  private env: GainNode;
  private released = false;

  constructor(
    private ctx: BaseAudioContext,
    private dest: AudioNode,
    key: number,
    vel: number,
    private p: BowParams,
  ) {
    const freq = hz(key);
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = p.level * vel;

    // ---- 琴筒共鸣：带通滤波器模拟胡琴筒的共振 ----
    const body = ctx.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = clamp(p.bodyHz, 120, 3000);
    body.Q.value = clamp(p.bodyQ, 0.5, 12);
    body.gain.value = 8;

    // 整体低通去掉刺耳的高频
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = clamp(2200 + p.bowPressure * 3800, 800, 12000);

    // ---- 揉弦（vibrato）----
    // 关键：延迟渐入。二胡的揉弦是拉长音时才加大的，短促音头几乎不揉。
    // 早先的引擎完全没有 vibrato，导致二胡听起来像锯齿琴。
    //
    // 深度换算：vibratoDepth 单位是音分，1 音分对应 freq*(2^(1/1200)-1) Hz。
    // 把它换算成 Hz 直接加到振荡器的 frequency 上，是Web Audio 唯一可行的做法。
    const vibMod = ctx.createOscillator();
    vibMod.frequency.value = clamp(p.vibratoRate, 1, 12);

    this.vibGain = ctx.createGain();
    const depthHz = freq * (Math.pow(2, p.vibratoDepth / 1200) - 1);
    this.vibGain.gain.setValueAtTime(0, t);
    this.vibGain.gain.linearRampToValueAtTime(depthHz, t + clamp(p.vibratoDelay, 0, 5));
    vibMod.connect(this.vibGain);
    this.vib = vibMod;

    // ---- 谐波层：拉弦的能量分布靠谐波堆叠 ----
    const harmonics = [
      { ratio: 1, gain: 1.0 },
      { ratio: 2, gain: 0.42 + p.bowPressure * 0.2 },
      { ratio: 3, gain: 0.22 },
      { ratio: 4, gain: 0.12 },
      { ratio: 6, gain: 0.06 },
    ];
    const total = harmonics.reduce((s, h) => s + h.gain, 0);
    for (const h of harmonics) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      // 谐波也要跟着颤音走，否则会互相干涉产生"金属味"
      this.vibGain.connect(o.frequency);
      o.frequency.value = freq * h.ratio;
      const g = ctx.createGain();
      g.gain.value = (h.gain / total) * 1.1;
      o.connect(g);
      g.connect(body);
      this.osc.push(o);
    }

    // ---- 弓弦摩擦噪声 ----
    if (p.bowNoise > 0.005) {
      const ns = ctx.createBufferSource();
      ns.buffer = makeNoise(this.ctx, 1.5);
      ns.loop = true;
      const nf = ctx.createBiquadFilter();
      nf.type = 'bandpass';
      nf.frequency.value = clamp(freq * 3, 300, 6000);
      nf.Q.value = 1.4;
      const ng = ctx.createGain();
      ng.gain.value = p.bowNoise * 0.16;
      ns.connect(nf); nf.connect(ng); ng.connect(body);
      this.osc.push(ns);
    }

    body.connect(tone);
    tone.connect(out);

    // ---- 包络 ----
    // 包络放在 out 之前，这样 out 只是静态音量，包络调制它。
    // 早先版本把 out.disconnect() 再重连，结果把 out 到 dest 的连接
    // 断开后又在 connect 顺序上出错，且 disconnect() 不带参数会切断
    // 该节点的所有下游连接 —— 这类"顺手写"的代码是隐蔽 bug 的来源。
    this.env = ctx.createGain();
    const tail = ctx.createGain();
    tail.gain.value = p.level * vel;
    tone.connect(this.env);
    this.env.connect(tail);
    tail.connect(dest);
    // out 保留给外部（本类内部不再使用），避免未使用变量
    void out;

    this.env.gain.setValueAtTime(0.0001, t);
    this.env.gain.exponentialRampToValueAtTime(1, t + clamp(p.attack, 0.005, 2));
    this.env.gain.setTargetAtTime(p.sustain, t + p.attack, 0.09);

    vibMod.start(t);
    for (const o of this.osc) o.start(t);
  }

  release(time: number) {
    if (this.released) return;
    this.released = true;
    const t = Math.max(time, this.ctx.currentTime);
    this.env.gain.cancelScheduledValues(t);
    this.env.gain.setValueAtTime(Math.max(0.0001, this.env.gain.value), t);
    this.env.gain.exponentialRampToValueAtTime(0.0001, t + clamp(this.p.release, 0.02, 3));
    const stopAt = t + this.p.release + 0.06;
    try { this.vib.stop(stopAt); } catch { /* noop */ }
    for (const o of this.osc) {
      try { o.stop(stopAt); } catch { /* noop */ }
    }
  }
}

export class BowSynth implements InstrumentEngine {
  readonly type = 'bow';
  private voices = new Map<string, BowVoice>();
  private cfg: BowParams = BOW_DEFAULTS;

  constructor(private ctx: BaseAudioContext, private dest: AudioNode) {}

  noteOn(key: number, _time: number, velocity: number, params: AnyParams, noteId = ''): void {
    const p = { ...BOW_DEFAULTS, ...(params as Partial<BowParams>) };
    this.cfg = p;
    const id = noteId || `bow${key}_${this.voices.size}`;
    // 同 id 重复触发先松开旧的，避免叠音
    this.voices.get(id)?.release(this.ctx.currentTime);
    this.voices.set(id, new BowVoice(this.ctx, this.dest, key, Math.max(0.02, velocity), p));
  }

  noteOff(noteId: string, time: number): void {
    this.voices.get(noteId)?.release(time);
    this.voices.delete(noteId);
  }

  releaseAll(time: number): void {
    for (const v of this.voices.values()) v.release(time);
    this.voices.clear();
  }

  dispose(): void { this.releaseAll(this.ctx.currentTime); }
}

/* ============================================================
 * 三、吹管类—— 竹笛 / 箫 / 唢呐 / 笙
 * ============================================================ */

export interface WindParams {
  /** 气声噪声占比 0~1。笛子的气息感全靠它 */
  breath: number;
  /** 噪声的带通中心Hz。吹管的高频气声集中在 2~5kHz */
  breathHz: number;
  /** 主谐波组占比 0~1（其余给气声） */
  tone: number;
  /** 谐波数量倾向：1=接近单簧管(奇次), 0=接近单簧管以外的音色 */
  oddHarmonics: number;
  /** 起音速度（秒）。吹管起音有明显的"吹起"过程 */
  attack: number;
  /** 气声包络攻击（比主音更慢，吹气先到） */
  breathAttack: number;
  release: number;
  /** 音域内音准修正（音分），笛子常偏低 */
  detune: number;
  /** 颤音。二胡最强，笛箫次之，唢呐可有可无 */
  vibratoDepth: number;
  vibratoRate: number;
  /** 筒身共振峰频率Hz */
  bodyHz: number;
  /** 共振峰强度 */
  bodyQ: number;
  /** 底音空洞（吹管低频区的"漏气"感）0~1 */
  hollow: number;
  level: number;
}

export const WIND_DEFAULTS: WindParams = {
  breath: 0.28,
  breathHz: 3200,
  tone: 0.75,
  oddHarmonics: 0.7,
  attack: 0.055,
  breathAttack: 0.09,
  release: 0.14,
  detune: 0,
  vibratoDepth: 18,
  vibratoRate: 4.8,
  bodyHz: 1200,
  bodyQ: 2.4,
  hollow: 0.15,
  level: 0.62,
};

class WindVoice {
  private osc: Array<OscillatorNode | AudioBufferSourceNode> = [];
  private vib: OscillatorNode;
  private vibGain: GainNode;
  private env: GainNode;
  private breathEnv: GainNode;
  private released = false;

  constructor(
    private ctx: BaseAudioContext,
    private dest: AudioNode,
    key: number,
    vel: number,
    private p: WindParams,
  ) {
    const freq = hz(key) * Math.pow(2, p.detune / 1200);
    const t = ctx.currentTime;

    const main = ctx.createGain();
    main.gain.value = p.tone;
    const breath = ctx.createGain();
    breath.gain.value = p.breath;

    // ---- 颤音 ----
    const vibMod = ctx.createOscillator();
    vibMod.frequency.value = clamp(p.vibratoRate, 1, 12);
    this.vibGain = ctx.createGain();
    const depthHz = freq * (Math.pow(2, p.vibratoDepth / 1200) - 1);
    this.vibGain.gain.value = depthHz;
    vibMod.connect(this.vibGain);
    this.vib = vibMod;

    // ---- 谐波堆叠 ----
    // oddHarmonics 接近 1 时只取奇次谐波（单簧管式，音色封闭、接近笛箫）；
    // 接近 0 时奇偶都有（更亮、更开阔，接近唢呐）。
    const count = 9;
    const harmonics: Array<{ ratio: number; gain: number }> = [];
    for (let i = 1; i <= count; i++) {
      const isOdd = i % 2 === 1;
      const oddWeight = p.oddHarmonics;
      if (isOdd) harmonics.push({ ratio: i, gain: 1 / Math.pow(i, 1 - oddWeight * 0.55) });
      else harmonics.push({ ratio: i, gain: (1 - oddWeight) * (0.6 / Math.pow(i, 0.9)) });
    }
    const total = harmonics.reduce((s, h) => s + h.gain, 0);

    for (const h of harmonics) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq * h.ratio;
      this.vibGain.connect(o.frequency);
      const g = ctx.createGain();
      g.gain.value = h.gain / total;
      o.connect(g);
      g.connect(main);
      this.osc.push(o);
    }

    // ---- 气声噪声 ----
    if (p.breath > 0.005) {
      const ns = ctx.createBufferSource();
      ns.buffer = makeNoise(ctx, 2);
      ns.loop = true;
      const nf = ctx.createBiquadFilter();
      nf.type = 'bandpass';
      nf.frequency.value = clamp(p.breathHz, 400, 12000);
      nf.Q.value = 0.8;
      const nh = ctx.createBiquadFilter();
      nh.type = 'highpass';
      nh.frequency.value = 400;
      ns.connect(nf); nf.connect(nh); nh.connect(breath);
      this.osc.push(ns);
    }

    // ---- 筒身共振峰 ----
    const body = ctx.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = clamp(p.bodyHz, 200, 6000);
    body.Q.value = clamp(p.bodyQ, 0.4, 10);
    body.gain.value = 9;

    // 底音空洞：吹管在音域低端有明显的"空心"感，
    // 用一个固定的低频共振峰模拟，比简单低通更像真的管子。
    if (p.hollow > 0.01) {
      const hollowF = ctx.createBiquadFilter();
      hollowF.type = 'peaking';
      hollowF.frequency.value = clamp(freq * 0.5, 90, 900);
      hollowF.Q.value = 4;
      hollowF.gain.value = p.hollow * 12;
      main.connect(hollowF);
      hollowF.connect(body);
    } else {
      main.connect(body);
    }
    breath.connect(body);

    // ---- 包络：气声比主音慢，模拟"先吹气后出声" ----
    this.env = ctx.createGain();
    this.breathEnv = ctx.createGain();
    this.env.gain.setValueAtTime(0.0001, t);
    this.env.gain.exponentialRampToValueAtTime(1, t + clamp(p.attack, 0.005, 1));
    this.breathEnv.gain.setValueAtTime(0.0001, t);
    this.breathEnv.gain.exponentialRampToValueAtTime(1, t + clamp(p.breathAttack, 0.005, 1));

    main.connect(this.env);
    this.env.connect(body);
    body.connect(dest);
    breath.connect(this.breathEnv);
    this.breathEnv.connect(body);

    vibMod.start(t);
    for (const o of this.osc) o.start(t);
  }

  release(time: number) {
    if (this.released) return;
    this.released = true;
    const t = Math.max(time, this.ctx.currentTime);
    const r = clamp(this.p.release, 0.02, 2);
    for (const g of [this.env, this.breathEnv]) {
      g.gain.cancelScheduledValues(t);
      g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + r);
    }
    try { this.vib.stop(t + r + 0.05); } catch { /* noop */ }
    for (const o of this.osc) {
      try { o.stop(t + r + 0.05); } catch { /* noop */ }
    }
  }
}

export class WindSynth implements InstrumentEngine {
  readonly type = 'wind';
  private voices = new Map<string, WindVoice>();
  private cfg: WindParams = WIND_DEFAULTS;

  constructor(private ctx: BaseAudioContext, private dest: AudioNode) {}

  noteOn(key: number, _time: number, velocity: number, params: AnyParams, noteId = ''): void {
    const p = { ...WIND_DEFAULTS, ...(params as Partial<WindParams>) };
    this.cfg = p;
    const id = noteId || `wind${key}_${this.voices.size}`;
    this.voices.get(id)?.release(this.ctx.currentTime);
    this.voices.set(id, new WindVoice(this.ctx, this.dest, key, Math.max(0.02, velocity), p));
  }

  noteOff(noteId: string, time: number): void {
    this.voices.get(noteId)?.release(time);
    this.voices.delete(noteId);
  }

  releaseAll(time: number): void {
    for (const v of this.voices.values()) v.release(time);
    this.voices.clear();
  }

  dispose(): void { this.releaseAll(this.ctx.currentTime); }
}

/* ============================================================
 * 四、击弦类 —— 扬琴 / 洋琴
 * ============================================================ */

/**
 * 扬琴：在拨弦基础上叠加两样东西。
 * 一是左右手交替快速敲击的"轮音"（单音内部的高频颤动），
 * 二是金属共鸣（扬琴弦是金属的，泛音明亮且带拍频）。
 */
export interface YangleParams extends PluckParams {
  /** 轮音速度（Hz）。0 表示不用轮音，单次敲击 */
  rollRate: number;
  /** 轮音深度 0~1 */
  rollDepth: number;
  /** 双排弦的失谐量（音分）。扬琴的拍频来源 */
  detune2: number;
}

export const YANGLE_DEFAULTS: YangleParams = {
  damping: 4400,
  t60: 1.8,
  level: 0.62,
  detune: 0,
  rollRate: 14,
  rollDepth: 0.4,
  detune2: 14,
};

/**
 * 扬琴：在拨弦基础上叠两样东西。
 * 一是双排弦拍频 —— 两根微失谐的弦各自独立成ring，产生真实频率差。
 *   这在 Worklet 里由 StringVoice 的多弦模式直接实现（strings + detuneCents）。
 * 二是双手轮音 —— 左右手交替快速敲击同一个音，听感上是高频音量起伏。
 *   用AM 调制实现，且调制后的瞬时增益必须恒在 [0,1]：
 *   早先把调制直接加到反馈增益上（基值 0.99 + 深度 0.175），
 *   瞬时值可超过 1 → 每周期能量增长 → 指数发散，实测 RMS 达 2.2e7。
 */
class YangleVoice {
  readonly bornAt: number;
  private node: AudioWorkletNode | null = null;
  private rollOsc: OscillatorNode | null = null;
  private rollGain: GainNode | null = null;
  private vca: GainNode | null = null;
  private alive = true;

  constructor(
    private ctx: BaseAudioContext,
    private dest: AudioNode,
    key: number,
    vel: number,
    private p: YangleParams,
    startTime: number,
  ) {
    this.bornAt = ctx.currentTime;
    const freq = hz(key) * Math.pow(2, p.detune / 1200);

    // 轮音在 Worklet 输出之后做，避免参与反馈环的稳定性计算。
    // 作用在增益上，基值保证最低点仍 > 0，不会把声音掐掉。
    const out = ctx.createGain();
    out.gain.value = 1;
    if (p.rollRate > 0.1 && p.rollDepth > 0.01) {
      const ro = ctx.createOscillator();
      ro.frequency.value = clamp(p.rollRate, 2, 40);
      // 轮音也要对齐起音时刻：OscillatorNode 有 start(time)，
      // 若用 start(0) 而弦在 t=0.5s 才响，轮音会提前 0.5s 空转，
      // 且离线导出时轮音调制会落在错误的相位上。
      ro.start(Math.max(0, startTime));
      const rg = ctx.createGain();
      rg.gain.value = Math.min(0.45, p.rollDepth * 0.45);
      const vca = ctx.createGain();
      vca.gain.value = 1 - rg.gain.value; // 基值，保证瞬时值 ≥ 0.1
      ro.connect(rg);
      rg.connect(vca.gain);
      out.connect(vca);
      vca.connect(this.dest);
      this.rollOsc = ro;
      this.rollGain = rg;
      this.vca = vca;
    } else {
      out.connect(this.dest);
    }

    this.node = new AudioWorkletNode(ctx, 'ks-string', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        freq,
        damping: p.damping,
        t60: p.t60,
        level: Math.max(0.0001, p.level * vel),
        // 双排弦：两根弦，间隔 detune2 音分 → 真实拍频
        strings: 2,
        detuneCents: p.detune2,
        seed: 0x9e3779b9,
        startTime,
      },
    });
    this.node.connect(out);
  }

  stop() {
    if (!this.alive) return;
    this.alive = false;
    try { this.node?.port.postMessage({ type: 'kill' }); } catch { /* noop */ }
    try { this.node?.disconnect(); } catch { /* noop */ }
    try { this.rollOsc?.stop(); } catch { /* noop */ }
    try { this.rollGain?.disconnect(); } catch { /* noop */ }
    try { this.vca?.disconnect(); } catch { /* noop */ }
  }
}

export class YangleSynth implements InstrumentEngine {
  readonly type = 'yangle';
  private voices: YangleVoice[] = [];
  private cfg: YangleParams = YANGLE_DEFAULTS;
  private pending: Array<() => void> = [];

  constructor(private ctx: BaseAudioContext, private dest: AudioNode) {}

  async ready_(): Promise<void> {
    await preparePluck(this.ctx);
    const q = this.pending;
    this.pending = [];
    for (const fn of q) fn();
  }

  noteOn(key: number, time: number, velocity: number, params: AnyParams): void {
    const p = { ...YANGLE_DEFAULTS, ...(params as Partial<YangleParams>) };
    this.cfg = p;
    const build = () => {
      const v = new YangleVoice(this.ctx, this.dest, key, Math.max(0.02, velocity), p, time);
      this.voices.push(v);
      if (this.voices.length > 48) this.voices.shift()?.stop();
    };
    if (workletReady.has(this.ctx)) build();
    else {
      const q = this.pending;
      q.push(build);
      pendingByCtx.set(this.ctx, q);
    }
  }

  noteOff(): void {}

  /**
   * 与 PluckSynth 同理：不能无条件掐断所有声部。
   * 扬琴是击弦，余音由弦阻尼决定，这里只给存活期外的声部收尾。
   */
  releaseAll(_time: number): void {
    const now = this.ctx.currentTime;
    const stillLive = this.voices.filter((v) => now - v.bornAt < 61);
    for (const v of this.voices) {
      if (!stillLive.includes(v)) v.stop();
    }
    this.voices = stillLive;
  }

  /** 立即切断所有声部，仅在用户主动"停止"时用 */
  stopAll(): void {
    for (const v of this.voices) v.stop();
    this.voices = [];
  }

  panic(): void { this.stopAll(); }

  dispose(): void { this.stopAll(); }
}