/** 全局常量 */

export const DRUM_PARTS = [
  'kick',
  'snare',
  'clap',
  'closedHat',
  'openHat',
  'tomLow',
  'tomMid',
  'rim',
] as const;

/** 默认鼓件布局（可被工程文件覆盖） */
export const DEFAULT_DRUM_LAYOUT: string[] = [...DRUM_PARTS];

/** 鼓件中文名 */
export const DRUM_LABELS: Record<string, string> = {
  kick: '底鼓',
  snare: '军鼓',
  clap: '拍手',
  closedHat: '闭镲',
  openHat: '开镲',
  tomLow: '低音鼓',
  tomMid: '中音鼓',
  rim: '边击',
};

/** 轨道配色池（按顺序分配给新轨道） */
export const TRACK_COLORS = [
  '#f97316', // 橙
  '#22d3ee', // 青
  '#a78bfa', // 紫
  '#4ade80', // 绿
  '#f472b6', // 粉
  '#fbbf24', // 黄
  '#60a5fa', // 蓝
  '#fb7185', // 红
];

/** 音名表：C4 = 60 */
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function keyToName(key: number): string {
  const name = NOTE_NAMES[((key % 12) + 12) % 12];
  const octave = Math.floor(key / 12) - 1;
  return `${name}${octave}`;
}

/** 键盘按键 → 音高偏移（相对 C4） */
export const KEYBOARD_MAP: Record<string, number> = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6,
  g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13,
  l: 14, p: 15, ';': 16,
};

/** 效果器默认参数 */
export const DEFAULT_INSERT: import('./types').InsertParams = {
  decay: 2.0,
  predelay: 0.02,
  time: 0.375,
  feedback: 0.42,
  drive: 0.3,
  tone: 0.7,
  lowGain: 0,
  midGain: 0,
  midFreq: 1000,
  highGain: 0,
  enabled: true,
  mix: 1,
};

/** 默认网格选项 */
export const GRID_OPTIONS = [
  { label: '1/4 拍', steps: 1 },
  { label: '1/8 拍', steps: 2 },
  { label: '1/16 拍', steps: 4 },
  { label: '1/32 拍', steps: 8 },
];