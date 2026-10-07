/**
 * 合成器引擎
 * ============================================
 * 全部声音由 Web Audio 的振荡器 + 包络实时合成，不使用任何采样文件。
 * 这样做的收益：零加载等待、零版权风险、参数可实时连续调节。
 */

import type {
  PolySynthParams,
  FMSynthParams,
  DrumVoiceParams,
} from '../core/types';
import type { InstrumentEngine, AnyParams } from './registry';

/** MIDI 音高 → 频率。69 = A4 = 440Hz */
export function midiToFreq(key: number): number {
  return 440 * Math.pow(2, (key - 69) / 12);
}

/** 复音合成器：一颗音符 = 一条独立的声音链 */
class PolyVoice {
  private oscs: AudioScheduledSourceNode[] = [];
  private gains: GainNode[] = [];
  private env: GainNode | null = null;
  private started = false;

  constructor(
    private ctx: BaseAudioContext,
    private dest: AudioNode,
    private p: PolySynthParams,
  ) {}

  start(time: number, freq: number, velocity: number) {
    const g = this.ctx.createGain();
    const { filter, filterEnv } = this.p;

    // ---- 滤波器 ----
    let node: AudioNode = g;
    const flt = this.ctx.createBiquadFilter();
    flt.type = filter.type;
    flt.Q.value = filter.resonance;
    // cutoff = 基础值 + 包络偏移。包络偏移让声音"有开头"
    const baseCut = Math.min(filter.cutoff, 18000);
    const envAmt = filter.envAmount;
    flt.frequency.setValueAtTime(
      Math.max(60, Math.min(18000, baseCut * (1 + envAmt))),
      time,
    );
    flt.frequency.exponentialRampToValueAtTime(
      Math.max(60, Math.min(18000, baseCut)),
      time + filterEnv.decay,
    );
    g.connect(flt);
    node = flt;

    // ---- 振荡器层 ----
    const vel = Math.max(0.02, velocity);
    const layers: Array<[AudioScheduledSourceNode, number]> = [];

    const o1 = this.ctx.createOscillator();
    o1.type = this.p.osc1.wave;
    o1.frequency.value = freq;
    o1.detune.value = this.p.osc1.detune;
    layers.push([o1, this.p.osc1.level]);

    if (this.p.osc2.level > 0.001) {
      const o2 = this.ctx.createOscillator();
      o2.type = this.p.osc2.wave;
      o2.frequency.value = freq;
      o2.detune.value = this.p.osc2.detune;
      layers.push([o2, this.p.osc2.level]);
    }

    if (this.p.subLevel > 0.001) {
      const sub = this.ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = freq / 2;
      layers.push([sub, this.p.subLevel]);
    }

    if (this.p.noiseLevel > 0.001) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = this.getNoiseBuffer();
      noise.loop = true;
      layers.push([noise, this.p.noiseLevel]);
    }

    // 复音展开：同音高加多个微失谐副本，声音更宽
    if (this.p.unison > 1) {
      const extra = this.p.unison - 1;
      for (let i = 0; i < extra; i++) {
        const u = this.ctx.createOscillator();
        u.type = this.p.osc1.wave;
        u.frequency.value = freq;
        // ±7 ~ ±18 音分，铺开但不跑调
        u.detune.value = (i % 2 === 0 ? 1 : -1) * (7 + i * 5);
        layers.push([u, this.p.osc1.level * 0.55]);
      }
    }

    // 归一化，避免复音叠加时爆音
    const totalLevel = layers.reduce((s, l) => s + l[1], 0) || 1;
    for (const [src, level] of layers) {
      const lg = this.ctx.createGain();
      lg.gain.value = (level / totalLevel) * vel * 0.25;
      src.connect(lg);
      lg.connect(g);
      this.oscs.push(src);
      this.gains.push(lg);
    }

    // ---- 音量包络 ADSR ----
    const env = this.ctx.createGain();
    const e = this.p.env;
    const peak = 1;
    env.gain.setValueAtTime(0.0001, time);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), time + e.attack);
    env.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, e.sustain),
      time + e.attack + e.decay,
    );
    // 信号链：g → flt → env → dest
    env.connect(this.dest);
    this.env = env;

    // 滑音：从上一个音高滑过来
    if (this.p.portamento > 0.001) {
      for (const osc of this.oscs) {
        if ('frequency' in osc) {
          const o = osc as OscillatorNode;
          if (this.p.subLevel > 0.001 && o.type === 'sine') continue;
          o.frequency.setValueAtTime(freq * 0.94, time);
          o.frequency.exponentialRampToValueAtTime(freq, time + this.p.portamento);
        }
      }
    }

    for (const osc of this.oscs) osc.start(time);
    this.started = true;
  }

  stop(time: number) {
    if (!this.started) return;
    const e = this.p.env;
    const end = time + e.release;
    if (this.env) {
      this.env.gain.cancelScheduledValues(time);
      this.env.gain.setValueAtTime(Math.max(0.0001, this.env.gain.value), time);
      this.env.gain.exponentialRampToValueAtTime(0.0001, end);
    }
    for (const osc of this.oscs) {
      try { osc.stop(end + 0.02); } catch { /* 已停止 */ }
    }
    setTimeout(() => this.cleanup(), (end + 0.2) * 1000);
  }

  cleanup() {
    for (const osc of this.oscs) {
      try { osc.disconnect(); } catch { /* noop */ }
    }
    for (const g of this.gains) {
      try { g.disconnect(); } catch { /* noop */ }
    }
    if (this.env) { try { this.env.disconnect(); } catch { /* noop */ } }
    this.oscs = [];
    this.gains = [];
    this.started = false;
  }

  private noiseBuf: AudioBuffer | null = null;
  private getNoiseBuffer(): AudioBuffer {
    if (this.noiseBuf) return this.noiseBuf;
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    return buf;
  }
}

/** 管理一台复音合成器的声音池 */
export class PolySynth implements InstrumentEngine {
  readonly type = 'poly';
  private active: Array<{ voice: PolyVoice; noteId: string }> = [];
  private lastFreq = 0;
  private counter = 0;

  constructor(private ctx: BaseAudioContext, private dest: AudioNode) {}

  noteOn(
    key: number,
    time: number,
    velocity: number,
    params: AnyParams,
    noteId?: string,
  ) {
    const p = params as PolySynthParams;
    const id = noteId ?? `p${this.counter++}`;
    // 声部上限保护：超出的释放最早的，避免 CPU 爆掉
    if (this.active.length >= p.voices) {
      const oldest = this.active.shift();
      oldest?.voice.stop(time);
    }
    const freq = midiToFreq(key);
    const voice = new PolyVoice(this.ctx, this.dest, p);
    voice.start(time, freq, velocity);
    this.active.push({ voice, noteId: id });
    this.lastFreq = freq;
  }

  /** 按音符 id 释放；找不到则不动作 */
  noteOff(noteId: string, time: number) {
    const idx = this.active.findIndex((a) => a.noteId === noteId);
    if (idx >= 0) {
      const a = this.active[idx];
      a.voice.stop(time);
      this.active.splice(idx, 1);
    }
  }

  /** 立即掐断所有声音（停止播放 / panic 用） */
  releaseAll(time: number) {
    for (const a of this.active) a.voice.stop(time);
    this.active = [];
  }

  dispose() { this.releaseAll(this.ctx.currentTime); }

  get voiceCount() { return this.active.length; }
  get lastFrequency() { return this.lastFreq; }
}

/** FM 合成器：载波 + 调制器，2 算子结构 */
export class FMSynth implements InstrumentEngine {
  readonly type = 'fm';
  private active: Array<{ stop: (t: number) => void }> = [];

  constructor(private ctx: BaseAudioContext, private dest: AudioNode) {}

  noteOn(key: number, time: number, velocity: number, params: AnyParams) {
    const p = params as FMSynthParams;
    const freq = midiToFreq(key);
    const vel = Math.max(0.02, velocity);

    const out = this.ctx.createGain();
    const flt = this.ctx.createBiquadFilter();
    flt.type = p.filter.type;
    flt.Q.value = p.filter.resonance;
    flt.frequency.value = Math.min(18000, Math.max(60, p.filter.cutoff));
    out.connect(flt);
    flt.connect(this.dest);

    const ampEnv = this.ctx.createGain();
    ampEnv.gain.setValueAtTime(0.0001, time);
    ampEnv.gain.exponentialRampToValueAtTime(vel * 0.35, time + p.env.attack);
    ampEnv.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, vel * 0.35 * p.env.sustain),
      time + p.env.attack + p.env.decay,
    );
    ampEnv.connect(out);

    // 载波
    const carrier = this.ctx.createOscillator();
    carrier.type = p.algorithm;
    carrier.frequency.value = freq;
    carrier.connect(ampEnv);

    // 调制器 → 调制增益 → 载波频率
    const mod = this.ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = freq * p.ratio;

    const modGain = this.ctx.createGain();
    const modDepth = freq * p.index;
    const m = p.modEnv;
    modGain.gain.setValueAtTime(modDepth, time);
    modGain.gain.exponentialRampToValueAtTime(
      Math.max(1, modDepth * Math.max(0.02, m.sustain)),
      time + m.attack + m.decay,
    );
    mod.connect(modGain);
    modGain.connect(carrier.frequency);

    // 自反馈 FM
    if (p.feedback > 0.01) {
      const fb = this.ctx.createGain();
      fb.gain.value = p.feedback * freq;
      const fbDelay = this.ctx.createDelay(0.05);
      fbDelay.delayTime.value = 0.001;
      mod.connect(fb);
      fb.connect(fbDelay);
      fbDelay.connect(carrier.frequency);
    }

    carrier.start(time);
    mod.start(time);

    const handle = {
      stop: (t: number) => {
        const e = p.env;
        ampEnv.gain.cancelScheduledValues(t);
        ampEnv.gain.setValueAtTime(Math.max(0.0001, ampEnv.gain.value), t);
        ampEnv.gain.exponentialRampToValueAtTime(0.0001, t + e.release);
        try { carrier.stop(t + e.release + 0.02); } catch { /* noop */ }
        try { mod.stop(t + e.release + 0.02); } catch { /* noop */ }
        setTimeout(() => {
          try { ampEnv.disconnect(); } catch { /* noop */ }
          try { flt.disconnect(); } catch { /* noop */ }
          try { out.disconnect(); } catch { /* noop */ }
          try { modGain.disconnect(); } catch { /* noop */ }
        }, (e.release + 0.2) * 1000);
      },
    };
    this.active.push(handle);
  }

  releaseAll(time: number, _params?: AnyParams) {
    for (const h of this.active) h.stop(time);
    this.active = [];
  }

  dispose() { this.releaseAll(this.ctx.currentTime); }
}

/** 鼓机：每件鼓用一套经典合成配方 */
export class DrumMachine implements InstrumentEngine {
  readonly type = 'drum';
  constructor(private ctx: BaseAudioContext, private dest: AudioNode) {}
  private noiseBuf: AudioBuffer | null = null;

  private noise(): AudioBuffer {
    if (this.noiseBuf) return this.noiseBuf;
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    return buf;
  }

  trigger(
    part: string,
    time: number,
    velocity: number,
    rawParams: AnyParams,
  ) {
    const p = rawParams as DrumVoiceParams;
    const ctx = this.ctx;
    const vel = Math.max(0.02, velocity);
    const out = ctx.createGain();
    out.gain.value = vel * 0.9;
    out.connect(this.dest);

    const shaper = ctx.createWaveShaper();
    const curve = this.makeCurve(p.drive);
    shaper.curve = curve;
    shaper.connect(out);

    const total = p.pitch + p.noise + p.body;
    if (total < 0.01) return;

    // ---- 基音层：正弦 + 音调下滑（鼓的灵魂）----
    if (p.pitch > 0) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const f0 = Math.max(20, p.pitch);
      osc.frequency.setValueAtTime(f0, time);
      if (p.bend > 0) {
        osc.frequency.exponentialRampToValueAtTime(
          Math.max(20, f0 - p.bend),
          time + p.decay * 0.35,
        );
      }
      const g = ctx.createGain();
      const peak = p.pitch * vel * 1.6;
      g.gain.setValueAtTime(Math.max(0.0001, peak), time);
      g.gain.exponentialRampToValueAtTime(0.0001, time + p.decay);
      osc.connect(g);
      g.connect(shaper);
      osc.start(time);
      osc.stop(time + p.decay + 0.05);
    }

    // ---- 泛音层：方波，给底鼓补厚度 ----
    if (p.body > 0) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(Math.max(30, p.pitch * 2), time);
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(20, p.pitch),
        time + p.decay * 0.2,
      );
      const g = ctx.createGain();
      g.gain.setValueAtTime(Math.max(0.0001, p.body * vel * 0.9), time);
      g.gain.exponentialRampToValueAtTime(0.0001, time + p.decay * 0.7);
      osc.connect(g);
      g.connect(shaper);
      osc.start(time);
      osc.stop(time + p.decay + 0.05);
    }

    // ---- 噪声层：军鼓/踩镲的成分 ----
    if (p.noise > 0) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      // 高频件用高通更亮
      bp.frequency.value = p.pitch > 900 || p.noise > 0.6 ? 6500 : 2200;
      bp.Q.value = 0.8;
      const g = ctx.createGain();
      g.gain.setValueAtTime(Math.max(0.0001, p.noise * vel * 0.8), time);
      g.gain.exponentialRampToValueAtTime(0.0001, time + p.decay);
      src.connect(bp);
      bp.connect(g);
      g.connect(shaper);
      src.start(time);
      src.stop(time + p.decay + 0.05);
    }

    setTimeout(() => {
      try { out.disconnect(); } catch { /* noop */ }
      try { shaper.disconnect(); } catch { /* noop */ }
    }, (p.decay + 0.3) * 1000);
  }

  /**
   * 触发一步里的所有鼓件。
   * layout[i] = 鼓件名，velocities[i] = 该鼓件在这一步的力度（0 表示不响）。
   * 鼓轨的 note 数组被用作"鼓件选择器"，真正的节奏存在 steps 里。
   */
  triggerStep(
    layout: string[],
    velocities: number[],
    time: number,
    params: AnyParams,
  ) {
    const kit = params as Record<string, DrumVoiceParams>;
    for (let i = 0; i < layout.length; i++) {
      const v = velocities[i] ?? 0;
      if (v <= 0.001) continue;
      const part = layout[i];
      const vp = kit[part];
      if (vp) this.trigger(part, time, v, vp);
    }
  }

  /**
   * 鼓机没有"旋律音高"的概念，但统一接口要求实现 noteOn。
   * 这里把 noteId 当鼓件名处理（钢琴卷帘里鼓件的 key 就是 36/38/42…），
   * 让鼓轨也能走与旋律轨相同的触发路径。
   */
  noteOn(_key: number, time: number, velocity: number, params: AnyParams, noteId?: string) {
    if (!noteId) return;
    const kit = params as Record<string, DrumVoiceParams>;
    const p = kit[noteId];
    if (p) this.trigger(noteId, time, velocity, p);
  }

  /** 鼓件是一击即发，没有延音，无需松开 */
  noteOff(): void { /* noop */ }

  /** 鼓节点都是即建即弃，没有需要统一释放的常驻声部 */
  releaseAll(): void { /* noop */ }

  dispose(): void { /* 无常驻资源 */ }

  /** 生成波形整形曲线，实现饱和/失真
   *
   * 采用归一化 tanh 软削波：f(x) = tanh(k·x) / tanh(k)
   * 选它的三个理由：
   *  1. f(±1) = ±1，两端严格保持单位增益，不改变整体音量；
   *  2. 中段增益 > 1（k=1 时 x=0.1 处增益约 1.31），产生谐波即失真；
   *  3. |f(x)| < 1 恒成立，任意输入都不会削顶爆音。
   */
  private makeCurve(amount: number): Float32Array<ArrayBuffer> {
    const n = 1024;
    const curve = new Float32Array(new ArrayBuffer(n * 4));
    const k = amount * 3; // 曲线斜率：amount=1 时 k=3，谐波丰富但不过分
    const denom = Math.tanh(k);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = amount <= 0.001 ? x : Math.tanh(k * x) / denom;
    }
    return curve;
  }
}