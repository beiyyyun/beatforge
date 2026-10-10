/**
 * 播放引擎与时基调度
 * ============================================
 * 关键设计：不能用 setInterval 直接发声，必须用"前瞻式调度"(lookahead scheduling)。
 * 原因：JavaScript 定时器有 10~50ms 抖动，且音频必须提前排入 Web Audio 的时间轴。
 * 做法：每 25ms 醒一次，把未来 100ms 内该响的声音立刻排进去。
 * 这是 Chrome/Web Audio 官方推荐的标准做法。
 */

import type {
  Project, Note, Track, TrackLayer,
} from '../core/types';
import { createInstrument, withDefaults, getInstrumentDef } from './registry';
import type { InstrumentEngine, AnyParams } from './registry';
// 副作用导入：注册所有内置乐器。放到这里而不是让每个调用方记得导入，
// 是因为漏导入的表现是"轨道完全没声音"，排查成本远高于导入成本。
import './register';
import { prepareInstrumentsFor } from './register';
import { ReverbBus, DelayBus, MasterBus, buildInsert } from './fx';
import { DEFAULT_DRUM_LAYOUT } from '../core/constants';

/** 一层叠加乐器的运行时链路 */
interface LayerRuntime {
  layerId: string;
  synth: InstrumentEngine | null;
  gain: GainNode;
  pan: StereoPannerNode;
  reverbSend: GainNode;
  delaySend: GainNode;
}

/** 每条轨道的运行时声音链 */
interface ChannelRuntime {
  track: Track;
  input: GainNode;      // 合成器输出到这里
  volume: GainNode;
  pan: StereoPannerNode;
  insertInput: AudioNode | null;
  insertOutput: AudioNode | null;
  insertDispose: (() => void) | null;
  reverbSend: GainNode;
  delaySend: GainNode;
  /** 未注册的乐器类型为 null，调度时跳过并由界面提示 */
  synth: InstrumentEngine | null;
  /** 叠加层（鼓轨为空） */
  layers: LayerRuntime[];
  /** 已按下但尚未释放的音符索引 */
  heldNotes: Note[];
}

/**
 * 构造引擎实例并补全参数。
 *
 * 参数补全放在这里而不是调用方，是因为漏掉任何一处都会让
 * undefined 进入算术运算变成 NaN，表现为"这条轨道没声音且无报错"。
 * 统一入口保证不存在漏掉的路径。
 */
function buildEngine(
  type: string,
  ctx: BaseAudioContext,
  dest: AudioNode,
  rawParams: unknown,
): InstrumentEngine | null {
  const engine = createInstrument(type, ctx, dest);
  if (!engine) return null;
  const def = getInstrumentDef(type);
  // 每个引擎在 noteOn 时自己会用默认值兜底，这里先把params 补全存回去，
  // 让 setParams / 导出路径拿到同一份完整数据
  (engine as { cfg?: unknown }).cfg = withDefaults(def, rawParams);
  return engine;
}

export class PlaybackEngine {
  private ctx: AudioContext | null = null;
  private channels = new Map<string, ChannelRuntime>();
  private master: MasterBus | null = null;
  private reverb: ReverbBus | null = null;
  private delay: DelayBus | null = null;

  private timer: number | null = null;
  private lookahead = 0.1;      // 前瞻窗口（秒）
  private interval = 25;        // 唤醒间隔（毫秒）

  private currentStep = 0;
  private nextNoteTime = 0;
  private startTime = 0;
  private running = false;

  /** 进度回调，供 UI 画播放头 */
  onProgress: ((step: number, time: number) => void) | null = null;
  onStop: (() => void) | null = null;

  /** 确保 AudioContext 存在（必须在用户手势里调用） */
  init() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.master = new MasterBus(this.ctx, this.ctx.destination);
      this.reverb = new ReverbBus(this.ctx, this.master.node);
      this.delay = new DelayBus(this.ctx, this.master.node);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  get context() { return this.ctx; }
  get isRunning() { return this.running; }

  /** 根据项目状态重建所有声道路由 */
  rebuild(project: Project) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    if (!this.master || !this.reverb || !this.delay) return;

    // 拨弦/击弦依赖 AudioWorklet 异步加载。这里不阻塞 rebuild ——
    // 引擎内部有补发队列，加载完成后会自动把暂存的音符发出去。
    void prepareInstrumentsFor(ctx, collectEngineTypes(project));

    // 销毁旧链路
    for (const ch of this.channels.values()) {
      ch.synth?.dispose?.();
      ch.insertDispose?.();
      for (const l of ch.layers) {
        l.synth?.dispose?.();
        try { l.gain.disconnect(); } catch { /* noop */ }
        try { l.pan.disconnect(); } catch { /* noop */ }
        try { l.reverbSend.disconnect(); } catch { /* noop */ }
        try { l.delaySend.disconnect(); } catch { /* noop */ }
      }
      try { ch.input.disconnect(); } catch { /* noop */ }
      try { ch.volume.disconnect(); } catch { /* noop */ }
      try { ch.pan.disconnect(); } catch { /* noop */ }
      try { ch.reverbSend.disconnect(); } catch { /* noop */ }
      try { ch.delaySend.disconnect(); } catch { /* noop */ }
    }
    this.channels.clear();

    for (const track of project.tracks) {
      const input = ctx.createGain();
      const volume = ctx.createGain();
      const pan = ctx.createStereoPanner();
      const reverbSend = ctx.createGain();
      const delaySend = ctx.createGain();

      // 链路：input → [insert] → volume → pan → master
      let tail: AudioNode = input;
      let insertInput: AudioNode | null = null;
      let insertOutput: AudioNode | null = null;
      let insertDispose: (() => void) | null = null;

      if (track.insert && track.insert.enabled) {
        const chain = buildInsert(ctx, track.insert);
        insertInput = chain.input;
        insertOutput = chain.output;
        insertDispose = chain.dispose;
        tail.connect(chain.input);
        tail = chain.output;
      }

      tail.connect(volume);
      volume.connect(pan);
      pan.connect(this.master.node);

      // 发送总线
      pan.connect(reverbSend);
      reverbSend.connect(this.reverb.node);
      pan.connect(delaySend);
      delaySend.connect(this.delay.node);

      reverbSend.gain.value = track.sendReverb;
      delaySend.gain.value = track.sendDelay;

      // 分配合成器。类型未注册时返回 null，调度阶段会跳过这条轨道
      const synth = buildEngine(track.instrument, ctx, input, track.params);

      // 叠加层：信号汇入主 input，因此在效果器之前混合，
      // 用户对整条轨道调效果器时所有层一起受影响。
      const layers: LayerRuntime[] = [];
      if (track.kind !== 'drum' && track.layers && track.layers.length > 0) {
        for (const layer of track.layers) {
          const lGain = ctx.createGain();
          const lPan = ctx.createStereoPanner();
          const lRev = ctx.createGain();
          const lDel = ctx.createGain();

          const lSynth = buildEngine(layer.instrument, ctx, lGain, layer.params);

          lGain.connect(lPan);
          lPan.connect(input);
          lPan.connect(lRev);
          lRev.connect(this.reverb.node);
          lPan.connect(lDel);
          lDel.connect(this.delay.node);

          layers.push({
            layerId: layer.id, synth: lSynth,
            gain: lGain, pan: lPan, reverbSend: lRev, delaySend: lDel,
          });
        }
      }

      this.channels.set(track.id, {
        track, input, volume, pan, reverbSend, delaySend,
        insertInput, insertOutput, insertDispose, synth, layers,
        heldNotes: [],
      });

      this.applyTrackState(track);
    }
  }

  /** 只更新音量/声像/发送等实时参数，不重建链路（用于拖动滑块） */
  applyTrackState(track: Track) {
    const ch = this.channels.get(track.id);
    if (!ch || !this.ctx) return;
    const t = this.ctx.currentTime;
    ch.volume.gain.setTargetAtTime(track.volume, t, 0.01);
    ch.pan.pan.setTargetAtTime(track.pan, t, 0.01);
    ch.reverbSend.gain.setTargetAtTime(track.sendReverb, t, 0.01);
    ch.delaySend.gain.setTargetAtTime(track.sendDelay, t, 0.01);

    // 叠加层
    const layers = track.layers ?? [];
    for (const l of ch.layers) {
      const def = layers.find((x) => x.id === l.layerId);
      if (!def) continue;
      l.gain.gain.setTargetAtTime(def.muted ? 0 : def.volume, t, 0.01);
      l.pan.pan.setTargetAtTime(def.pan, t, 0.01);
      l.reverbSend.gain.setTargetAtTime(def.sendReverb, t, 0.01);
      l.delaySend.gain.setTargetAtTime(def.sendDelay, t, 0.01);
    }
  }

  /** 判断某轨道当前是否应该发声（考虑静音/独奏） */
  private isAudible(track: Track, project: Project): boolean {
    if (track.muted) return false;
    const anySolo = project.tracks.some((t) => t.solo);
    if (anySolo && !track.solo) return false;
    return true;
  }

  setMasterVolume(v: number) {
    this.master?.setVolume(v);
  }

  /** BPM 变化时同步延迟时间（1/8 拍），这是 FL 的常见做法 */
  setBpm(bpm: number) {
    if (!this.delay || !this.ctx) return;
    const eighth = 60 / bpm / 2;
    this.delay.setTime(eighth, 0.42);
  }

  setReverb(decay: number, predelay: number) {
    this.reverb?.set(decay, predelay);
  }

  /** 步索引 → 秒。gridSteps 表示每拍几格 */
  private stepToSeconds(project: Project, step: number): number {
    const secPerStep = 60 / project.bpm / project.gridSteps;
    return step * secPerStep;
  }

  play(project: Project, fromStep = 0) {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.running) this.stop();

    this.running = true;
    this.currentStep = fromStep;
    this.startTime = this.ctx.currentTime + 0.06; // 极短预热，避免第一声被吃掉
    this.nextNoteTime = this.startTime;

    this.tick();
    this.timer = window.setInterval(() => this.tick(), this.interval);
  }

  stop() {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    // 立即掐断所有正在响的声音，避免"停止后还在响"
    if (this.ctx) {
      const now = this.ctx.currentTime;
      for (const ch of this.channels.values()) {
        this.silence(ch.synth, now, ch.track.params);
        for (const l of ch.layers) {
          const def = (ch.track.layers ?? []).find((x) => x.id === l.layerId);
          this.silence(l.synth, now, def?.params ?? ch.track.params);
        }
        ch.heldNotes = [];
      }
    }
    this.onStop?.();
  }

  /**
   * 立即掐断一个引擎的全部发声。
   *
   * 优先用 panic 而非 releaseAll：拨弦/击弦的 releaseAll 刻意保留自然余音
   * （正常演奏不该切断余音），但用户点了"停止"，期望的是立刻安静。
   * 持续音类引擎两者等价，不实现 panic 时退回 releaseAll。
   */
  private silence(synth: InstrumentEngine | null, time: number, params: AnyParams) {
    if (!synth) return;
    if (synth.panic) synth.panic();
    else synth.releaseAll(time, params);
  }

  /** 核心：前瞻式调度循环 */
  private tick() {
    if (!this.ctx) return;
    const project = this.currentProject;
    if (!project) return;

    const horizon = this.ctx.currentTime + this.lookahead;

    while (this.nextNoteTime < horizon) {
      const step = this.currentStep % project.totalSteps;

      // ① 调度这一格该响的声音
      this.scheduleStep(project, step, this.nextNoteTime);

      // ② 通知 UI（用实际音频时间反推视觉位置）
      const elapsed = this.nextNoteTime - this.startTime;
      this.onProgress?.(step, elapsed);

      this.nextNoteTime += this.stepToSeconds(project, 1);
      this.currentStep++;

      // ③ 到循环末尾的处理
      if (!project.loop && this.currentStep >= project.totalSteps) {
        this.stop();
        return;
      }
    }
  }

  /** 调度单步内所有音符 */
  private scheduleStep(project: Project, step: number, time: number) {
    // 先把上一格按下的持续音符在这里松开
    for (const ch of this.channels.values()) {
      const stillHeld = ch.heldNotes.filter((n) => n.start + n.length > step);
      for (const n of ch.heldNotes) {
        if (n.start + n.length <= step) {
          this.releaseNote(ch, n, time);
        }
      }
      ch.heldNotes = stillHeld;
    }

    // 触发本步开始的音符
    for (const note of project.notes) {
      if (note.start !== step) continue;
      const ch = this.channels.get(note.trackId);
      if (!ch || !ch.track) continue;
      if (!this.isAudible(ch.track, project)) continue;
      this.triggerNote(ch, note, time);
      ch.heldNotes.push(note);
    }

    // 鼓组步进：row.steps 按鼓件分段，每段长度 = totalSteps
    for (const [trackId, row] of Object.entries(project.steps)) {
      const chn = this.channels.get(trackId);
      if (!chn || chn.track.kind !== 'drum') continue;
      if (!this.isAudible(chn.track, project)) continue;
      // 用能力检测（有没有 triggerStep）而不是 instanceof ——
      // 这样以后加新打击乐器不需要改这里
      if (!chn.synth?.triggerStep) continue;

      const layout = row.layout ?? DEFAULT_DRUM_LAYOUT;
      const kit = withDefaults(getInstrumentDef(chn.track.instrument), chn.track.params);
      const total = project.totalSteps;
      const vels: number[] = [];
      for (let part = 0; part < layout.length; part++) {
        const params = kit[layout[part]];
        if (!params) { vels.push(0); continue; }
        vels.push(row.steps[part * total + step] ?? 0);
      }
      chn.synth.triggerStep(layout, vels, time, kit);
    }
  }

  /** 触发一个音符：主乐器 + 所有未静音的叠加层 */
  private triggerNote(ch: ChannelRuntime, note: Note, time: number) {
    const track = ch.track;
    const synth = ch.synth;
    if (!synth) return;   // 未注册的乐器类型，静默跳过
    const params = withDefaults(getInstrumentDef(track.instrument), track.params);
    synth.noteOn(note.key, time, note.velocity, params, note.id);

    for (const l of ch.layers) {
      const def = (track.layers ?? []).find((x) => x.id === l.layerId);
      if (!def || def.muted || !l.synth) continue;
      const key = note.key + def.semitone + def.octave * 12;
      if (key < 0 || key > 127) continue;   // 越界的音直接跳过，避免频率异常
      const id = `${note.id}@${def.id}`;
      const lParams = withDefaults(getInstrumentDef(def.instrument), def.params);
      l.synth.noteOn(key, time, note.velocity * layerGain(def), lParams, id);
    }
  }

  private releaseNote(ch: ChannelRuntime, note: Note, time: number) {
    if (ch.track.kind === 'drum') return;
    const track = ch.track;
    const synth = ch.synth;
    if (!synth) return;
    const params = withDefaults(getInstrumentDef(track.instrument), track.params);
    // noteOff 是可选能力：一击即发的乐器（拨弦/击弦/鼓）不实现它，
    // 它们的"松开"没有任何物理意义，强行调用只会报错
    if (synth.noteOff) synth.noteOff(note.id, time);
    else synth.releaseAll(time, params);

    for (const l of ch.layers) {
      const def = (track.layers ?? []).find((x) => x.id === l.layerId);
      if (!def || !l.synth) continue;
      const id = `${note.id}@${def.id}`;
      const lParams = withDefaults(getInstrumentDef(def.instrument), def.params);
      if (l.synth.noteOff) l.synth.noteOff(id, time);
      else l.synth.releaseAll(time, lParams);
    }
  }

  /** 实时试听：电脑键盘弹奏用 */
  previewNoteOn(track: Track, key: number, velocity: number) {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    const ch = this.channels.get(track.id);
    if (!ch || !ch.synth) return;
    const time = this.ctx.currentTime + 0.005;
    // previewId 必须含 key：同时按多个键时，每个键的预览音符是独立声部。
    // 不含 key 的话 Bow/Wind 引擎用 Map 存同 id 覆盖（第二个键顶掉第一个），
    // Poly 按 id 释放只命中一个 —— 和弦弹奏音符互相干扰。
    const previewId = `preview:${track.id}:${key}`;
    const params = withDefaults(getInstrumentDef(track.instrument), track.params);
    ch.synth.noteOn(key, time, velocity, params, previewId);
    // 试听时也要听到叠加层，否则用户判断不了叠加效果
    for (const l of ch.layers) {
      const def = (track.layers ?? []).find((x) => x.id === l.layerId);
      if (!def || def.muted || !l.synth) continue;
      const lk = key + def.semitone + def.octave * 12;
      if (lk < 0 || lk > 127) continue;
      const lid = `preview:${l.layerId}:${key}`;
      const lParams = withDefaults(getInstrumentDef(def.instrument), def.params);
      l.synth.noteOn(lk, time, velocity * layerGain(def), lParams, lid);
    }
    this.previewKey.set(track.id, key);
    let keys = this.previewKeys.get(track.id);
    if (!keys) { keys = new Set(); this.previewKeys.set(track.id, keys); }
    keys.add(key);
  }

  previewNoteOff(track: Track, key?: number) {
    if (!this.ctx) return;
    const ch = this.channels.get(track.id);
    if (!ch || !ch.synth) return;
    const time = this.ctx.currentTime;
    // key 不传时释放该轨道所有预览音符（兼容旧调用），
    // 传入时只释放对应的那一个 —— 弹和弦时互不干扰。
    const keys = key !== undefined ? [key] : [...(this.previewKeys.get(track.id) ?? [])];
    for (const k of keys) {
      const pid = `preview:${track.id}:${k}`;
      if (ch.synth.noteOff) ch.synth.noteOff(pid, time);
      else ch.synth.releaseAll(time, withDefaults(getInstrumentDef(track.instrument), track.params));
      for (const l of ch.layers) {
        const def = (track.layers ?? []).find((x) => x.id === l.layerId);
        if (!def || !l.synth) continue;
        const lid = `preview:${l.layerId}:${k}`;
        if (l.synth.noteOff) l.synth.noteOff(lid, time);
        else l.synth.releaseAll(time, withDefaults(getInstrumentDef(def.instrument), def.params));
      }
    }
    if (key !== undefined) this.previewKeys.get(track.id)?.delete(key);
    else this.previewKeys.delete(track.id);
    // 兼容旧字段：getPreviewKey 仍返回最近一个 key
    this.previewKey.set(track.id, key ?? 0);
  }

  /** 当前正在试听的音高，用于高亮琴键 */
  private previewKey = new Map<string, number>();
  /** 多键同时试听：每轨道一个 Set */
  private previewKeys = new Map<string, Set<number>>();
  getPreviewKey(trackId: string) { return this.previewKey.get(trackId); }

  /** 鼓件试听：part 名为鼓件名 */
  previewDrum(track: Track, part: string, velocity: number) {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    const ch = this.channels.get(track.id);
    if (!ch?.synth?.trigger) return;
    const kit = withDefaults(getInstrumentDef(track.instrument), track.params);
    const params = kit[part];
    if (!params) return;
    ch.synth.trigger(part, this.ctx.currentTime + 0.005, velocity, params);
    this.previewKey.set(track.id, partToKey(part));
  }

  /** 当前项目引用，调度时读取 */
  private currentProject: Project | null = null;
  setProject(p: Project) {
    this.currentProject = p;
  }

  /** 立即停止并复位播放头 */
  panic() {
    this.stop();
    this.currentStep = 0;
  }

  get position() { return this.currentStep; }

  /** 主输出分析节点，供波形/频谱可视化使用 */
  get analyserNode(): AnalyserNode | null {
    return this.master?.meterData ?? null;
  }
}

const PART_KEYS: Record<string, number> = {
  kick: 36, snare: 38, clap: 39, closedHat: 42,
  openHat: 46, tomLow: 41, tomMid: 45, rim: 37,
};
function partToKey(part: string): number {
  return PART_KEYS[part] ?? 36;
}

/**
 * 叠加层的力度系数。
 * 为什么不用 layer.volume：音量已经由 GainNode 控制了，
 * 在 noteOn 的 velocity 上再乘一次会导致两次衰减。
 * 这里只做一个温和的补偿，让叠加层天然地比主层弱一点，
 * 符合"层是衬托、主层是主角"的编曲惯例。
 */
function layerGain(layer: TrackLayer): number {
  return layer.octave < 0 ? 0.8 : 0.72;
}

/** 收集工程里用到的所有乐器类型（含叠加层），去重 */
export function collectEngineTypes(project: Project): string[] {
  const out = new Set<string>();
  for (const t of project.tracks) {
    out.add(t.instrument);
    for (const l of t.layers ?? []) out.add(l.instrument);
  }
  return [...out];
}