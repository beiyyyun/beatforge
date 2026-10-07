/**
 * 全局数据类型定义
 *
 * 设计取向：优先"小白能懂"，所以概念数量刻意压缩。
 * FL Studio 有几十种概念，这里只保留 4 个：轨道(Track) / 音符(Note) / 乐器(Instrument) / 效果器(Insert)
 */

export type TrackKind = 'melodic' | 'drum';

/**
 * 民乐参数类型的定义放在 audio/folk.ts（与引擎实现同文件）。
 * 这里用 `import type` 引回来 —— 类型导入会被编译期擦除，
 * 不会产生 core → audio 的运行时依赖，循环引用风险为零。
 * 换来的是"参数结构与引擎实现永远同步"，不会各写一份然后走偏。
 */
import type {
  PluckParams, BowParams, WindParams, YangleParams,
} from '../audio/folk';

/** ADSR 包络参数 */
export interface Envelope {
  attack: number;   // 秒
  decay: number;    // 秒
  sustain: number;  // 0~1
  release: number;  // 秒
}

/** 滤波器参数 */
export interface FilterParams {
  type: BiquadFilterType;
  cutoff: number;   // Hz
  resonance: number; // Q
  envAmount: number; // -1 ~ 1，滤波器包络强度
}

/** 复音合成器（类 FL 的 3x Osc / Sytrus） */
export interface PolySynthParams {
  osc1: { wave: OscillatorType; detune: number; level: number };
  osc2: { wave: OscillatorType; detune: number; level: number };
  subLevel: number;    // 低八度正弦，撑底
  noiseLevel: number;  // 噪声层，打破纯音的呆板
  unison: number;      // 1~5 复音铺开宽度
  env: Envelope;
  filter: FilterParams;
  filterEnv: Envelope;
  portamento: number;  // 滑音时间（秒）
  glide: boolean;
  voices: number;      // 最大同时发声数
}

/** FM 合成器 —— 用来做电钢、钟、铃类音色 */
export interface FMSynthParams {
  ratio: number;       // 调制比
  index: number;       // 调制深度
  algorithm: 'sine' | 'triangle' | 'square';
  feedback: number;    // 自反馈 FM
  env: Envelope;
  modEnv: Envelope;
  filter: FilterParams;
}

/** 单个鼓件的声音参数 */
export interface DrumVoiceParams {
  /** 音高，Hz。0 表示按基频计算 */
  pitch: number;
  /** 衰减秒数 */
  decay: number;
  /** 起音噪声占比 0~1 */
  noise: number;
  /** 波形失真/饱和 */
  drive: number;
  /** 包络弯曲程度，>1 更紧的 punch */
  punch: number;
  /** 基音谐波层（鼓组常用于加厚） */
  body: number;
  /** 音调下滑量 Hz（kick 的关键特征） */
  bend: number;
}

/** 鼓组 —— 8 件套，FL 默认鼓组结构 */
export interface DrumKitParams {
  kick: DrumVoiceParams;
  snare: DrumVoiceParams;
  clap: DrumVoiceParams;
  closedHat: DrumVoiceParams;
  openHat: DrumVoiceParams;
  tomLow: DrumVoiceParams;
  tomMid: DrumVoiceParams;
  rim: DrumVoiceParams;
}

/** 效果器类型 */
export type InsertType = 'reverb' | 'delay' | 'distortion' | 'eq';

/** 效果器参数（所有效果器共用一个结构，未使用的字段忽略） */
export interface InsertParams {
  // reverb
  decay: number;
  predelay: number;
  // delay
  time: number;      // 反馈间隔（秒），由 BPM 同步
  feedback: number;
  // distortion
  drive: number;
  tone: number;
  // eq
  lowGain: number;
  midGain: number;
  midFreq: number;
  highGain: number;
  enabled: boolean;
  mix: number;       // 干湿比 0~1
}

/**
 * 乐器类型标识。
 *
 * 这是一个"开放联合"：新增乐器时在这里加一项，
 * 再到 audio/register.ts 注册引擎实现，调用方（engine/export/editor）
 * 不需要任何改动。老工程里存的字符串依旧能被识别。
 */
export type InstrumentType =
  | 'poly'    // 复音减法合成
  | 'fm'      // FM 合成
  | 'drum'    // 鼓组
  | 'pluck'   // 拨弦（Karplus-Strong）：古筝/琵琶/阮
  | 'bow'     // 拉弦：二胡/板胡
  | 'wind'    // 吹管：竹笛/箫/唢呐/笙
  | 'yangle';  // 击弦：扬琴

/** 可作为叠加层的乐器（鼓轨不用层，鼓件本身就是"层"） */
export type MelodicInstrumentType = Exclude<InstrumentType, 'drum'>;

/** 所有乐器参数对象的并集 */
export type AnyTrackParams =
  | PolySynthParams
  | FMSynthParams
  | DrumKitParams
  | PluckParams
  | BowParams
  | WindParams
  | YangleParams;

/**
 * 叠加层（Layer）
 * ============================================
 * 一条旋律轨道可以同时挂多个乐器，共享同一份音符。
 * 这是编曲里"加厚"最直接的手段：低八度的底鼓式贝斯 +
 * 中频的钢琴 + 高八度的铃声，比单纯调音量有效得多。
 *
 * 只支持旋律类乐器。鼓轨的"层"由鼓组内的鼓件承担，
 * 概念上重复，放到轨道层里只会让新手困惑。
 */
export interface TrackLayer {
  id: string;
  name: string;
  instrument: MelodicInstrumentType;
  params: AnyTrackParams;
  /** 预设 id，用于恢复出厂音色 */
  presetId: string;
  /** 层音量 0~1.5。叠加时通常要调低于主层，否则会盖掉主旋律 */
  volume: number;
  /** 层声像 -1~1。用低八度层做一点点左移，声场立刻变宽 */
  pan: number;
  muted: boolean;
  /** 八度偏移 -2~2，叠加低八度是加厚音轨的经典做法 */
  octave: number;
  /** 半音偏移 -12~12，做和声色彩（如大二度叠加） */
  semitone: number;
  sendReverb: number;
  sendDelay: number;
}

/** 单条轨道 */
export interface Track {
  id: string;
  name: string;
  kind: TrackKind;
  color: string;
  volume: number;      // 0~1.5
  pan: number;         // -1 ~ 1
  muted: boolean;
  solo: boolean;
  instrument: InstrumentType;
  params: AnyTrackParams;
  /** 音色预设 id，用于恢复出厂音色 */
  presetId: string;
  /** 主输出插入效果器 */
  insert: InsertParams | null;
  /** 发送到混响总线 0~1 */
  sendReverb: number;
  /** 发送到延迟总线 0~1 */
  sendDelay: number;
  /** 叠加的乐器层，共享本轨音符。旧工程可能没有此字段 */
  layers?: TrackLayer[];
  /**
   * 乐器类型未被当前版本识别。
   * 只在加载工程时设置，不参与保存 —— 目的是让界面能提示用户
   * "这条轨道的乐器来自更高版本"，而不是静默哑掉让人以为文件损坏。
   */
  unknownInstrument?: boolean;
}

/** 音符。start/length 单位是"步"(step)，步长由网格精度决定 */
export interface Note {
  id: string;
  /** MIDI 音高，60 = C4 */
  key: number;
  /** 起始步索引 */
  start: number;
  /** 长度（步数） */
  length: number;
  /** 力度 0~1 */
  velocity: number;
  /** 所属轨道 */
  trackId: string;
  /** 是否为音轨端口触发 */
  slide?: boolean;
}

/**
 * 步进序列器的数据行（一条鼓轨）。
 * steps 采用"分段存储"：每件鼓占据长度 totalSteps 的一段，
 * 第 part 件鼓的数据在 steps[part * totalSteps .. part*totalSteps + totalSteps)。
 * 这样每件鼓都能有独立节奏，而不需要嵌套数组。
 */
export interface StepRow {
  steps: number[];
  /** 每段对应的鼓件名，顺序即分段顺序 */
  layout?: string[];
  /** 缓存：totalSteps，便于 UI 计算 */
  length?: number;
}

/** 全局项目状态 */
export interface Project {
  name: string;
  bpm: number;
  /** 网格精度：每拍切成几格 */
  gridSteps: number;
  /** 总步数（一拍的 gridSteps 倍数） */
  totalSteps: number;
  /** 当前播放位置（步） */
  playhead: number;
  playing: boolean;
  loop: boolean;
  masterVolume: number;
  tracks: Track[];
  notes: Note[];
  /** 鼓组步进数据，key = trackId */
  steps: Record<string, StepRow>;
}

/** 音色预设 */
export interface Preset {
  id: string;
  name: string;
  category: string;
  instrument: InstrumentType;
  trackKind: TrackKind;
  params: AnyTrackParams;
}