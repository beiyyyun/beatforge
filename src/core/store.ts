/**
 * 状态管理
 * ============================================
 * 采用极简发布订阅 + 不可变快照，保证撤销/重做可靠。
 * 历史栈保存整个项目（工程体量小，几十兆以内完全可接受）。
 */

import type {
  Project, Track, Note, StepRow, InsertParams, TrackLayer,
  MelodicInstrumentType, AnyTrackParams,
} from './types';
import { PRESETS, getPresetById } from '../audio/presets';
import { isInstrumentKnown, withDefaults, getInstrumentDef } from '../audio/registry';
// 副作用导入：确保注册表已填充。
// 缺了它，deserialize 里的 getInstrumentDef 全部返回 undefined，
// 参数补全静默失效 —— 老工程打开后表现为"某些乐器没声音"，
// 没有任何报错，极难排查。
import '../audio/register';
import { TRACK_COLORS, DEFAULT_INSERT, DEFAULT_DRUM_LAYOUT } from './constants';

let uid = 0;
export function nextId(prefix = 'id'): string {
  uid += 1;
  return `${prefix}-${Date.now().toString(36)}-${uid}`;
}

type Listener = (p: Project) => void;

/**
 * 创建一个叠加层。
 * 默认值刻意保守：音量 0.55、低八度、稍偏左——
 * 这是"加厚但不糊"的最安全组合，新手不改参数也能得到好听的结果。
 */
export function makeLayer(presetId: string, opts: Partial<TrackLayer> = {}): TrackLayer {
  const preset = getPresetById(presetId) ?? PRESETS.find((p) => p.trackKind === 'melodic')!;
  // 鼓预设不能作为层——鼓组的"叠加"由鼓件本身承担。
  // 其余乐器类型原样带过去：以前这里硬写成 'poly' | 'fm'，
  // 结果民乐预设被降级成减法合成，加了竹笛却发出 Organ 声。
  const instrument: MelodicInstrumentType =
    preset.instrument === 'drum' ? 'poly' : preset.instrument;
  return {
    id: nextId('lyr'),
    name: preset.name,
    instrument,
    params: structuredClone(preset.params) as AnyTrackParams,
    presetId: preset.id,
    volume: 0.55,
    pan: -0.25,
    muted: false,
    octave: -1,
    semitone: 0,
    sendReverb: 0.2,
    sendDelay: 0,
    ...opts,
  };
}

/** 由预设创建轨道 */
export function makeTrack(presetId: string): Track {
  const preset = getPresetById(presetId) ?? PRESETS[0];
  const colorIndex = uid % TRACK_COLORS.length;
  const insert: InsertParams | null = preset.trackKind === 'melodic'
    ? { ...DEFAULT_INSERT }
    : null;

  return {
    id: nextId('trk'),
    name: preset.name,
    kind: preset.trackKind,
    color: TRACK_COLORS[colorIndex],
    volume: 0.8,
    pan: 0,
    muted: false,
    solo: false,
    instrument: preset.instrument,
    params: structuredClone(preset.params),
    presetId: preset.id,
    insert,
    sendReverb: preset.trackKind === 'melodic' ? 0.12 : 0.05,
    sendDelay: 0,
    layers: [],
  };
}

/** 生成空的鼓步进行（每件鼓一段） */
export function makeStepRow(totalSteps: number, layout?: string[], enabledParts = 4): StepRow {
  const parts = layout ?? DEFAULT_DRUM_LAYOUT;
  const steps = new Array(parts.length * totalSteps).fill(0);
  return { steps, layout: parts, length: totalSteps };
}

/** 生成空工程 */
export function emptyProject(): Project {
  const drum = makeTrack('drum-标准鼓组');
  const bass = makeTrack('poly-厚实贝斯');
  const lead = makeTrack('poly-温暖电钢琴');

  const totalSteps = 64;
  const steps: Record<string, StepRow> = {
    [drum.id]: makeStepRow(totalSteps, undefined, 4),
  };

  return {
    name: '未命名工程',
    bpm: 120,
    gridSteps: 4,      // 默认 1/16
    totalSteps,
    playhead: 0,
    playing: false,
    loop: true,
    masterVolume: 0.8,
    tracks: [drum, bass, lead],
    notes: [],
    steps,
  };
}

/** 生成示例工程：8 小节完整编排，让用户一键听到成品 */
export function demoProject(): Project {
  const p = emptyProject();
  p.name = '示例工程 · 完整示范';

  const [drum, bass, lead] = p.tracks;
  const layout = p.steps[drum.id].layout ?? DEFAULT_DRUM_LAYOUT;
  const T = p.totalSteps;

  // ---- 鼓：四踩底鼓 + 反拍军鼓 + 八分踩镲 ----
  const row = p.steps[drum.id];
  const K = layout.indexOf('kick');
  const S = layout.indexOf('snare');
  const C = layout.indexOf('clap');
  const H = layout.indexOf('closedHat');
  const set = (part: number, step: number, v: number) => {
    if (part < 0) return;
    row.steps[part * T + step] = v;
  };

  for (let bar = 0; bar < 8; bar++) {
    const off = bar * 8; // 每小节 8 个 1/16 格
    set(K, off + 0, 1.0);
    set(K, off + 4, 0.9);
    if (bar === 7) {
      set(K, off + 6, 0.85);
      set(K, off + 7, 0.7);
    }
    if (bar % 2 === 1) {
      set(S, off + 2, 0.95);
      set(S, off + 6, 0.95);
    }
    set(C, off + 7, Math.max(row.steps[C * T + off + 7] ?? 0, 0.6));
    // 八分踩镲
    for (let i = 0; i < 8; i += 2) {
      const v = i % 4 === 0 ? 0.75 : 0.45;
      set(H, off + i, Math.max(row.steps[H * T + off + i] ?? 0, v));
    }
  }

  // ---- 贝斯：每小节根音 + 走动 ----
  const bassRoot = [38, 38, 43, 45, 38, 38, 41, 43]; // D2 D2 G2 A2 ... 每 2 小节换
  for (let bar = 0; bar < 8; bar++) {
    const root = bassRoot[bar];
    const off = bar * 8;
    p.notes.push(
      { id: nextId('n'), key: root, start: off, length: 2, velocity: 1, trackId: bass.id },
      { id: nextId('n'), key: root, start: off + 3, length: 1, velocity: 0.7, trackId: bass.id },
      { id: nextId('n'), key: root + 12, start: off + 4, length: 2, velocity: 0.85, trackId: bass.id },
      { id: nextId('n'), key: root, start: off + 6, length: 1, velocity: 0.65, trackId: bass.id },
    );
  }

  // ---- 主音：简单和弦旋律 Am - F - C - G ----
  const chords: number[][] = [
    [57, 60, 64, 67],  // Am
    [53, 57, 60, 65],  // F
    [48, 55, 60, 64],  // C
    [55, 59, 62, 67],  // G
  ];
  for (let bar = 0; bar < 8; bar++) {
    const chord = chords[bar % 4];
    const off = bar * 8;
    // 每个和弦音在第 1 拍和第 3 拍各响一次，构成琶音感
    for (const k of chord) {
      p.notes.push(
        { id: nextId('n'), key: k, start: off, length: 3, velocity: 0.8, trackId: lead.id },
        { id: nextId('n'), key: k, start: off + 4, length: 3, velocity: 0.65, trackId: lead.id },
      );
    }
  }

  // 混音调整
  lead.volume = 0.62;
  lead.sendReverb = 0.34;
  lead.sendDelay = 0.22;
  lead.insert = { ...DEFAULT_INSERT, drive: 0.12, mix: 1 };
  bass.volume = 0.85;
  drum.volume = 0.9;

  // 叠加层：主音轨叠一层低八度的柔和弦乐，立刻变厚
  lead.layers = [makeLayer('poly-柔和弦乐', {
    volume: 0.42,
    pan: -0.3,
    octave: -1,
    sendReverb: 0.4,
  })];

  return p;
}

/** 状态仓库 */
export class Store {
  private state: Project;
  private listeners: Listener[] = [];
  private history: Project[] = [];
  private future: Project[] = [];
  private lastCommit = 0;

  constructor(initial: Project) {
    this.state = initial;
  }

  get current(): Project { return this.state; }

  subscribe(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private emit() {
    for (const fn of this.listeners) fn(this.state);
  }

  /**
   * 修改状态。
   * @param mutator 修改函数
   * @param history 是否记入撤销栈。连续拖动等高频操作应传 false
   */
  update(mutator: (draft: Project) => void, history = true) {
    if (history) {
      // 400ms 内的连续修改合并为一次撤销，避免撤销栈被拖动滑块塞满
      const now = Date.now();
      if (now - this.lastCommit > 400 || this.history.length === 0) {
        this.history.push(structuredClone(this.state));
        if (this.history.length > 80) this.history.shift();
        this.lastCommit = now;
      } else {
        // 仍需保留最初快照：若这是连续操作的第一笔，lastCommit 未更新，
        // 上面的分支已处理。此处不重复写入。
      }
      this.future = [];
    }

    const draft = structuredClone(this.state);
    mutator(draft);
    this.state = draft;
    this.emit();
  }

  /** 强制记录一次撤销点（用于"开始拖动"这类时刻） */
  commit() {
    this.history.push(structuredClone(this.state));
    if (this.history.length > 80) this.history.shift();
    this.future = [];
    this.lastCommit = Date.now();
  }

  undo() {
    const prev = this.history.pop();
    if (!prev) return false;
    this.future.push(structuredClone(this.state));
    this.state = prev;
    this.lastCommit = 0;
    this.emit();
    return true;
  }

  redo() {
    const next = this.future.pop();
    if (!next) return false;
    this.history.push(structuredClone(this.state));
    this.state = next;
    this.lastCommit = 0;
    this.emit();
    return true;
  }

  get canUndo() { return this.history.length > 0; }
  get canRedo() { return this.future.length > 0; }

  /** 高频更新但不入历史（播放头等） */
  silentUpdate(mutator: (draft: Project) => void) {
    const draft = structuredClone(this.state);
    mutator(draft);
    this.state = draft;
    this.emit();
  }

  replaceAll(p: Project) {
    this.state = p;
    this.emit();
  }

  // ---------- 序列化 ----------

  serialize(): string {
    return JSON.stringify(this.state, null, 2);
  }

  deserialize(json: string): boolean {
    try {
      const parsed = JSON.parse(json) as Project;
      if (!parsed.tracks || !Array.isArray(parsed.tracks)) return false;
      // 补齐缺失字段，兼容旧文件
      const total = parsed.totalSteps ?? 64;
      parsed.totalSteps = total;
      parsed.gridSteps = parsed.gridSteps ?? 4;
      parsed.bpm = parsed.bpm ?? 120;
      parsed.loop = parsed.loop ?? true;
      parsed.masterVolume = parsed.masterVolume ?? 0.8;
      parsed.notes = parsed.notes ?? [];
      parsed.steps = parsed.steps ?? {};
      for (const t of parsed.tracks) {
        // 参数补全：老工程存的 params 缺少后来新增的字段，
        // 直接用会让 undefined 进入算术运算变成 NaN，
        // 表现为"这条轨道没声音且无任何报错"。
        const def = getInstrumentDef(t.instrument);
        if (def) t.params = withDefaults(def, t.params) as typeof t.params;
        else t.unknownInstrument = true;   // 界面据此提示，工程本身仍可打开

        // 补齐叠加层：旧工程没有这个字段
        if (!Array.isArray(t.layers)) {
          t.layers = [];
        } else {
          // 逐个校验。用 isInstrumentKnown 而不是硬编码乐器列表——
          // 这样以后加新乐器，打开旧工程不需要改这里。
          t.layers = t.layers.filter((l): l is TrackLayer =>
            !!l && typeof l.id === 'string' &&
            isInstrumentKnown(l.instrument) &&
            getInstrumentDef(l.instrument)?.trackKind === 'melodic' &&
            !!l.params);
          for (const l of t.layers) {
            const ldef = getInstrumentDef(l.instrument);
            if (ldef) l.params = withDefaults(ldef, l.params) as typeof l.params;
            l.volume = clamp01(l.volume, 0.55);
            l.pan = clampRange(l.pan, -1, 1, -0.25);
            l.octave = clampRange(l.octave, -2, 2, -1);
            l.semitone = clampRange(l.semitone, -12, 12, 0);
            l.sendReverb = clamp01(l.sendReverb ?? 0.2, 0.2);
            l.sendDelay = clamp01(l.sendDelay ?? 0, 0);
            l.muted = !!l.muted;
          }
        }
        if (t.kind === 'drum') {
          if (!parsed.steps[t.id]) {
            parsed.steps[t.id] = makeStepRow(total, DEFAULT_DRUM_LAYOUT, 4);
          } else if (!parsed.steps[t.id].layout) {
            // 兼容旧版单段结构：自动扩展为分段
            const old = parsed.steps[t.id];
            const seg: number[] = [];
            const parts = DEFAULT_DRUM_LAYOUT;
            for (let i = 0; i < parts.length; i++) {
              const base = old.steps.slice(i * total, (i + 1) * total);
              for (let j = 0; j < total; j++) seg.push(base[j] ?? 0);
            }
            old.steps = seg;
            old.layout = parts;
            old.length = total;
          }
        }
      }
      this.replaceAll(parsed);
      this.commit();
      return true;
    } catch {
      return false;
    }
  }
}

/** 排序音符（按起始步），保证绘制顺序稳定 */
export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => a.start - b.start || a.key - b.key);
}

function clamp01(v: unknown, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.max(0, Math.min(1.5, n));
}

function clampRange(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.max(min, Math.min(max, n));
}