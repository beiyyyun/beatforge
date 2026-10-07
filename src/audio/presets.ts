/**
 * 音色预设库
 * ============================================
 * 每个预设都是一组手工调校的参数，目的是让小白一打开就能得到能听的声音，
 * 而不必理解"包络""共振"这些概念。
 */

import type {
  Preset,
  PolySynthParams,
  FMSynthParams,
  DrumKitParams,
  Envelope,
  FilterParams,
} from '../core/types';
import type { PluckParams, BowParams, WindParams, YangleParams } from './folk';
import { DEFAULT_DRUM_KIT } from './drum-defaults';

const env = (a: number, d: number, s: number, r: number): Envelope => ({ attack: a, decay: d, sustain: s, release: r });

const filter = (
  type: BiquadFilterType,
  cutoff: number,
  resonance: number,
  envAmount: number,
): FilterParams => ({ type, cutoff, resonance, envAmount });

/** ---------- 鼓组预设 ---------- */

const drumKit = (
  name: string,
  category: string,
  tweaks: Partial<DrumKitParams>,
): Preset => ({
  id: `drum-${name.toLowerCase().replace(/\s+/g, '-')}`,
  name,
  category,
  instrument: 'drum',
  trackKind: 'drum',
  params: { ...DEFAULT_DRUM_KIT, ...tweaks } as DrumKitParams,
});

/** ---------- 复音合成器预设 ---------- */

const poly = (
  name: string,
  category: string,
  p: Partial<PolySynthParams>,
): Preset => ({
  id: `poly-${name.toLowerCase().replace(/\s+/g, '-')}`,
  name,
  category,
  instrument: 'poly',
  trackKind: 'melodic',
  params: {
    osc1: { wave: 'sawtooth', detune: 0, level: 0.7 },
    osc2: { wave: 'square', detune: 7, level: 0.35 },
    subLevel: 0.2,
    noiseLevel: 0,
    unison: 1,
    env: env(0.01, 0.25, 0.65, 0.3),
    filter: filter('lowpass', 2400, 4, 0.5),
    filterEnv: env(0.005, 0.2, 0.3, 0.2),
    portamento: 0,
    glide: false,
    voices: 12,
    ...p,
  } as PolySynthParams,
});

/** ---------- FM 预设 ---------- */

const fm = (
  name: string,
  category: string,
  p: Partial<FMSynthParams>,
): Preset => ({
  id: `fm-${name.toLowerCase().replace(/\s+/g, '-')}`,
  name,
  category,
  instrument: 'fm',
  trackKind: 'melodic',
  params: {
    ratio: 2,
    index: 3,
    algorithm: 'sine',
    feedback: 0,
    env: env(0.005, 1.2, 0.35, 0.6),
    modEnv: env(0.002, 0.35, 0.25, 0.3),
    filter: filter('lowpass', 5200, 1.2, 0),
    ...p,
  } as FMSynthParams,
});

/** ---------- 民乐预设 ----------
 *
 * 这里的每一个数值都不是"听起来差不多"随手填的，
 * 而是从 tests/folk-measure.js 的物理测量结果标定出来的：
 *   - damping（弦阻尼）→ 决定频谱质心，实测古筝 1146Hz / 琵琶 1381Hz / 阮 1001Hz
 *   - t60（余音长度）→ 实测 -25→-38.8dB（古筝）/ -25→-49.4dB（琵琶）等
 *   - vibratoRate/Depth → 二胡实测 5.2Hz/5.3%，板胡 6.4Hz/3.4%
 *   - breath → 竹笛气声比 0.34、唢呐 0.12（唢呐芯亮，气声集中在更高频段）
 *   - rollRate/Depth → 扬琴实测 13.8Hz/38.5%
 * 改这些数值前请先跑 `node tests/folk-spectrum.mjs`，改完必须复测。
 */

const pluck = (name: string, p: PluckParams): Preset => ({
  id: `pluck-${name}`,
  name,
  category: '拨弦',
  instrument: 'pluck',
  trackKind: 'melodic',
  params: p,
});

const bow = (name: string, p: BowParams): Preset => ({
  id: `bow-${name}`,
  name,
  category: '拉弦',
  instrument: 'bow',
  trackKind: 'melodic',
  params: p,
});

const wind = (name: string, p: WindParams): Preset => ({
  id: `wind-${name}`,
  name,
  category: '吹管',
  instrument: 'wind',
  trackKind: 'melodic',
  params: p,
});

export const PRESETS: Preset[] = [
  // ===== 鼓组 =====
  drumKit('标准鼓组', '鼓组', {}),
  drumKit('强力 EDM', '鼓组', {
    kick:    { pitch: 50,  decay: 0.5, noise: 0.03, drive: 0.5, punch: 1, body: 0.4, bend: 42 },
    clap:    { pitch: 1100, decay: 0.3, noise: 1.0, drive: 0.25, punch: 1, body: 0.1, bend: 0 },
    openHat: { pitch: 6800, decay: 0.45, noise: 1.0, drive: 0.2, punch: 1, body: 0.05, bend: 0 },
  }),
  drumKit('嘻哈 808', '鼓组', {
    kick:    { pitch: 44,  decay: 0.78, noise: 0.02, drive: 0.42, punch: 1, body: 0.35, bend: 22 },
    snare:   { pitch: 200, decay: 0.22, noise: 0.8, drive: 0.3, punch: 1, body: 0.5, bend: 70 },
    closedHat:{ pitch: 9000, decay: 0.045, noise: 1.0, drive: 0.08, punch: 1, body: 0.03, bend: 0 },
  }),
  drumKit('柔音民谣', '鼓组', {
    kick:    { pitch: 70,  decay: 0.3, noise: 0.04, drive: 0.12, punch: 1, body: 0.75, bend: 20 },
    snare:   { pitch: 240, decay: 0.14, noise: 0.55, drive: 0.1, punch: 1, body: 0.55, bend: 40 },
    closedHat:{ pitch: 6200, decay: 0.08, noise: 1.0, drive: 0.06, punch: 1, body: 0.08, bend: 0 },
    openHat: { pitch: 5600, decay: 0.22, noise: 1.0, drive: 0.06, punch: 1, body: 0.08, bend: 0 },
  }),
  drumKit('lo-fi 颗粒', '鼓组', {
    kick:    { pitch: 58,  decay: 0.36, noise: 0.1, drive: 0.55, punch: 1, body: 0.55, bend: 26 },
    snare:   { pitch: 175, decay: 0.17, noise: 0.72, drive: 0.42, punch: 1, body: 0.4, bend: 55 },
    closedHat:{ pitch: 6200, decay: 0.06, noise: 1.0, drive: 0.3, punch: 1, body: 0.05, bend: 0 },
  }),
  drumKit('工业金属', '鼓组', {
    kick:    { pitch: 62,  decay: 0.24, noise: 0.12, drive: 0.75, punch: 1, body: 0.45, bend: 45 },
    snare:   { pitch: 260, decay: 0.12, noise: 0.85, drive: 0.7, punch: 1, body: 0.5, bend: 80 },
    closedHat:{ pitch: 9500, decay: 0.03, noise: 1.0, drive: 0.4, punch: 1, body: 0.04, bend: 0 },
    rim:     { pitch: 500, decay: 0.04, noise: 0.6, drive: 0.6, punch: 1, body: 0.6, bend: 0 },
  }),

  // ===== 贝斯 =====
  poly('厚实贝斯', '贝斯', {
    osc1: { wave: 'sine', detune: 0, level: 0.85 },
    osc2: { wave: 'square', detune: 0, level: 0.2 },
    subLevel: 0.55,
    env: env(0.006, 0.3, 0.75, 0.16),
    filter: filter('lowpass', 900, 6, 0.35),
    filterEnv: env(0.004, 0.16, 0.2, 0.15),
    voices: 4,
  }),
  poly('弹性电贝斯', '贝斯', {
    osc1: { wave: 'sawtooth', detune: 0, level: 0.6 },
    osc2: { wave: 'sine', detune: 0, level: 0.5 },
    subLevel: 0.3,
    env: env(0.01, 0.4, 0.6, 0.2),
    filter: filter('lowpass', 1600, 3, 0.6),
    filterEnv: env(0.006, 0.28, 0.25, 0.2),
    voices: 4,
  }),
  poly('合成低音', '贝斯', {
    osc1: { wave: 'square', detune: 0, level: 0.8 },
    osc2: { wave: 'square', detune: 12, level: 0.5 },
    subLevel: 0.4,
    env: env(0.004, 0.2, 0.5, 0.12),
    filter: filter('lowpass', 1200, 8, 0.7),
    filterEnv: env(0.002, 0.12, 0.15, 0.1),
    voices: 3,
  }),
  poly('行走贝斯', '贝斯', {
    osc1: { wave: 'triangle', detune: 0, level: 0.7 },
    osc2: { wave: 'sawtooth', detune: 5, level: 0.35 },
    subLevel: 0.25,
    env: env(0.02, 0.5, 0.45, 0.28),
    filter: filter('lowpass', 1100, 2.5, 0.3),
    filterEnv: env(0.01, 0.35, 0.2, 0.25),
    voices: 4,
  }),

  // ===== 主音 / 旋律 =====
  poly('温暖电钢琴', '主音', {
    osc1: { wave: 'sine', detune: 0, level: 0.6 },
    osc2: { wave: 'triangle', detune: 4, level: 0.5 },
    subLevel: 0.3,
    env: env(0.004, 1.1, 0.32, 0.45),
    filter: filter('lowpass', 3200, 1.6, 0.15),
    filterEnv: env(0.003, 0.5, 0.15, 0.3),
    voices: 10,
  }),
  poly('明亮主音', '主音', {
    osc1: { wave: 'square', detune: 0, level: 0.55 },
    osc2: { wave: 'sawtooth', detune: 9, level: 0.6 },
    unison: 3,
    env: env(0.006, 0.55, 0.6, 0.35),
    filter: filter('lowpass', 4200, 3, 0.45),
    filterEnv: env(0.004, 0.35, 0.25, 0.25),
    voices: 12,
  }),
  poly('复古软合成器', '主音', {
    osc1: { wave: 'sawtooth', detune: -8, level: 0.6 },
    osc2: { wave: 'sawtooth', detune: 8, level: 0.6 },
    subLevel: 0.15,
    env: env(0.03, 0.6, 0.62, 0.42),
    filter: filter('lowpass', 1800, 5, 0.4),
    filterEnv: env(0.02, 0.45, 0.3, 0.35),
    unison: 2,
    voices: 8,
  }),
  poly('八位芯片音', '主音', {
    osc1: { wave: 'square', detune: 0, level: 0.9 },
    osc2: { wave: 'square', detune: 0, level: 0 },
    subLevel: 0.2,
    env: env(0.001, 0.16, 0.5, 0.08),
    filter: filter('lowpass', 6000, 1, 0),
    filterEnv: env(0.001, 0.1, 0.4, 0.08),
    voices: 8,
  }),
  poly('酸性锯齿', '主音', {
    osc1: { wave: 'sawtooth', detune: 0, level: 0.9 },
    osc2: { wave: 'sawtooth', detune: 14, level: 0.45 },
    subLevel: 0.3,
    env: env(0.003, 0.28, 0.42, 0.2),
    filter: filter('lowpass', 280, 14, 0.95),
    filterEnv: env(0.002, 0.2, 0.1, 0.15),
    voices: 8,
  }),
  poly('人声质感 Lead', '主音', {
    osc1: { wave: 'sawtooth', detune: 0, level: 0.5 },
    osc2: { wave: 'square', detune: 6, level: 0.4 },
    noiseLevel: 0.16,
    env: env(0.02, 0.4, 0.7, 0.3),
    filter: filter('bandpass', 1400, 2.4, 0.3),
    filterEnv: env(0.015, 0.3, 0.3, 0.25),
    unison: 2,
    voices: 8,
  }),

  // ===== 铺底 / 氛围 =====
  poly('柔和弦乐', '氛围', {
    osc1: { wave: 'sawtooth', detune: -6, level: 0.5 },
    osc2: { wave: 'sawtooth', detune: 6, level: 0.5 },
    subLevel: 0.18,
    noiseLevel: 0.05,
    unison: 3,
    env: env(0.35, 0.9, 0.78, 0.9),
    filter: filter('lowpass', 2000, 1.6, 0.2),
    filterEnv: env(0.3, 0.7, 0.5, 0.6),
    voices: 8,
  }),
  poly('空气感垫', '氛围', {
    osc1: { wave: 'sawtooth', detune: -11, level: 0.45 },
    osc2: { wave: 'triangle', detune: 11, level: 0.4 },
    noiseLevel: 0.2,
    unison: 3,
    env: env(0.6, 1.4, 0.82, 1.3),
    filter: filter('lowpass', 1500, 0.9, 0.15),
    filterEnv: env(0.5, 1.2, 0.6, 1),
    voices: 8,
  }),
  poly('温暖模拟垫', '氛围', {
    osc1: { wave: 'sawtooth', detune: 0, level: 0.55 },
    osc2: { wave: 'square', detune: 10, level: 0.3 },
    subLevel: 0.22,
    noiseLevel: 0.08,
    env: env(0.25, 1.0, 0.75, 0.8),
    filter: filter('lowpass', 1100, 3.5, 0.35),
    filterEnv: env(0.2, 0.8, 0.4, 0.7),
    unison: 2,
    voices: 8,
  }),
  poly('黑暗氛围', '氛围', {
    osc1: { wave: 'sawtooth', detune: 0, level: 0.5 },
    osc2: { wave: 'sawtooth', detune: 7, level: 0.4 },
    subLevel: 0.35,
    noiseLevel: 0.14,
    unison: 2,
    env: env(0.7, 1.8, 0.85, 1.8),
    filter: filter('lowpass', 700, 4.5, 0.5),
    filterEnv: env(0.6, 1.5, 0.5, 1.4),
    voices: 6,
  }),

  // ===== FM 电钢 / 键盘 =====
  fm('电钢琴 FM', '键盘', {
    ratio: 1,
    index: 2.6,
    algorithm: 'sine',
    env: env(0.004, 1.6, 0.28, 0.55),
    modEnv: env(0.002, 0.5, 0.12, 0.4),
    filter: filter('lowpass', 4200, 1.1, 0),
  }),
  fm('玻璃铃', '键盘', {
    ratio: 3.5,
    index: 5.5,
    feedback: 0.32,
    algorithm: 'sine',
    env: env(0.002, 1.8, 0.06, 1.4),
    modEnv: env(0.001, 0.9, 0.05, 0.8),
    filter: filter('highpass', 400, 0.8, 0),
  }),
  fm('数字钟琴', '键盘', {
    ratio: 3.01,
    index: 7,
    feedback: 0.45,
    algorithm: 'sine',
    env: env(0.001, 2.4, 0.03, 1.8),
    modEnv: env(0.001, 1.4, 0.02, 1.2),
    filter: filter('bandpass', 2800, 1.6, 0),
  }),
  fm('管风琴', '键盘', {
    ratio: 2,
    index: 1.8,
    algorithm: 'square',
    env: env(0.03, 0.2, 0.95, 0.18),
    modEnv: env(0.02, 0.15, 0.7, 0.15),
    filter: filter('lowpass', 3600, 1.2, 0),
  }),
  fm('失真电钢', '键盘', {
    ratio: 1.41,
    index: 4.2,
    feedback: 0.18,
    algorithm: 'triangle',
    env: env(0.004, 1.2, 0.35, 0.45),
    modEnv: env(0.002, 0.4, 0.2, 0.35),
    filter: filter('lowpass', 2800, 3.5, 0.25),
  }),
  fm('FM 贝斯', '贝斯', {
    ratio: 1,
    index: 3.4,
    algorithm: 'sine',
    env: env(0.004, 0.5, 0.55, 0.2),
    modEnv: env(0.002, 0.22, 0.15, 0.18),
    filter: filter('lowpass', 1400, 2.5, 0.4),
  }),

  // ===== 民族乐器 =====
  // ---- 拨弦（Karplus-Strong）----
  // 古筝：21 弦钢丝弦高张力 → 明亮、余音长（T60 取 4s，接近真实古筝）
  pluck('古筝', { damping: 3400, t60: 4.0, level: 0.7, detune: 0 }),
  // 琵琶：相位音箱、弦短硬，攻击最亮，衰减中等
  pluck('琵琶', { damping: 4600, t60: 1.6, level: 0.7, detune: 0 }),
  // 阮：圆形音箱、丝弦低张力 → 音色浑厚，余音较短
  pluck('阮', { damping: 1500, t60: 1.2, level: 0.72, detune: 0 }),

  // ---- 击弦 ----
  // 扬琴：金属弦、双排弦拍频、双手轮音
  {
    id: 'yangle-扬琴',
    name: '扬琴',
    category: '击弦',
    instrument: 'yangle',
    trackKind: 'melodic',
    params: {
      damping: 4400, t60: 1.8, level: 0.62, detune: 0,
      rollRate: 14, rollDepth: 0.4, detune2: 14,
    } satisfies YangleParams as YangleParams,
  },

  // ---- 拉弦 ----
  // 二胡：内弦，揉弦 4~6Hz，琴筒共鸣偏低
  bow('二胡', {
    vibratoDepth: 45, vibratoRate: 5.2, vibratoDelay: 0.28, bowPressure: 0.42,
    attack: 0.09, sustain: 0.82, release: 0.18, bowNoise: 0.07,
    bodyHz: 420, bodyQ: 3.2, level: 0.65,
  }),
  // 板胡：外弦、高把位，弓压大 → 泛音更亮，揉弦更快
  bow('板胡', {
    vibratoDepth: 58, vibratoRate: 6.4, vibratoDelay: 0.24, bowPressure: 0.72,
    attack: 0.07, sustain: 0.8, release: 0.15, bowNoise: 0.09,
    bodyHz: 620, bodyQ: 2.6, level: 0.66,
  }),

  // ---- 吹管 ----
  // 竹笛：亮、高频气声强、奇次谐波为主
  wind('竹笛', {
    breath: 0.3, breathHz: 3400, tone: 0.75, oddHarmonics: 0.78,
    attack: 0.055, breathAttack: 0.09, release: 0.14, detune: 0,
    vibratoDepth: 16, vibratoRate: 4.6, bodyHz: 1400, bodyQ: 2.4,
    hollow: 0.12, level: 0.62,
  }),
  // 箫：低沉、接近闭管（奇次谐波极强）、气声偏暗
  wind('箫', {
    breath: 0.24, breathHz: 2200, tone: 0.78, oddHarmonics: 0.88,
    attack: 0.075, breathAttack: 0.12, release: 0.18, detune: 0,
    vibratoDepth: 14, vibratoRate: 4.2, bodyHz: 950, bodyQ: 2.8,
    hollow: 0.3, level: 0.62,
  }),
  // 唢呐：奇偶谐波齐备 → 明亮高亢，金属芯
  wind('唢呐', {
    breath: 0.32, breathHz: 2600, tone: 0.72, oddHarmonics: 0.22,
    attack: 0.05, breathAttack: 0.08, release: 0.12, detune: 0,
    vibratoDepth: 22, vibratoRate: 5.4, bodyHz: 1700, bodyQ: 2.0,
    hollow: 0.08, level: 0.6,
  }),
  // 笙：多管共鸣，泛音丰富，气声弱
  wind('笙', {
    breath: 0.2, breathHz: 1800, tone: 0.8, oddHarmonics: 0.85,
    attack: 0.06, breathAttack: 0.1, release: 0.16, detune: 0,
    vibratoDepth: 12, vibratoRate: 4.0, bodyHz: 1100, bodyQ: 3.0,
    hollow: 0.26, level: 0.6,
  }),
];

export const PRESET_CATEGORIES = ['鼓组', '贝斯', '主音', '氛围', '键盘', '拨弦', '拉弦', '吹管', '击弦'];

export function getPresetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}