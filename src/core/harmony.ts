/**
 * 和弦与编曲助手
 * ============================================
 * 提供和弦库、和弦进行库，以及"按进行自动铺音"的三种编排策略：
 *  - arpeggio：琶音，逐个音依次落下
 *  - block：柱式，整个和弦同时响
 *  - pad：长音铺底，延音拉满
 *
 * 目标：让用户点几下就得到一段结构合理的编曲骨架，而不是从零划音符。
 */

import type { Project } from './types';

export interface Chord {
  /** 和弦名，如 Am、F、Cmaj7 */
  name: string;
  /** 相对根音的半音偏移，如 [0,3,7] */
  intervals: number[];
}

/** 音阶偏移 → 音名 */
const NAMES: Record<string, number> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

/**
 * 常用和弦库。
 * intervals 一律是「相对根音的半音偏移」，第一个元素必须是 0。
 * 音程取值：0 根音 / 2 九度 / 3 小三度 / 4 大三度 / 5 纯四度 /
 *7 纯五度 / 9 大六度 / 10 小七度 / 11 大七度
 */
export const CHORD_LIBRARY: Chord[] = [
  // 三和弦
  { name: 'C',    intervals: [0, 4, 7] },
  { name: 'Cm',   intervals: [0, 3, 7] },
  { name: 'C#m',  intervals: [0, 3, 7] },
  { name: 'D',    intervals: [0, 4, 7] },
  { name: 'Dm',   intervals: [0, 3, 7] },
  { name: 'Eb',   intervals: [0, 4, 7] },
  { name: 'E',    intervals: [0, 4, 7] },
  { name: 'Em',   intervals: [0, 3, 7] },
  { name: 'F',    intervals: [0, 4, 7] },
  { name: 'Fm',   intervals: [0, 3, 7] },
  { name: 'F#',   intervals: [0, 4, 7] },
  { name: 'G',    intervals: [0, 4, 7] },
  { name: 'Gm',   intervals: [0, 3, 7] },
  { name: 'Ab',   intervals: [0, 4, 7] },
  { name: 'A',    intervals: [0, 4, 7] },
  { name: 'Am',   intervals: [0, 3, 7] },
  { name: 'A#',   intervals: [0, 4, 7] },
  { name: 'Bb',   intervals: [0, 4, 7] },
  { name: 'B',    intervals: [0, 4, 7] },
  { name: 'Bm',   intervals: [0, 3, 7] },
  // 七和弦与挂留
  { name: 'Cmaj7', intervals: [0, 4, 7, 11] },
  { name: 'Dmaj7', intervals: [0, 4, 7, 11] },
  { name: 'Emaj7', intervals: [0, 4, 7, 11] },
  { name: 'Fmaj7', intervals: [0, 4, 7, 11] },
  { name: 'Gmaj7', intervals: [0, 4, 7, 11] },
  { name: 'Amaj7', intervals: [0, 4, 7, 11] },
  { name: 'Dm7',   intervals: [0, 3, 7, 10] },
  { name: 'Em7',   intervals: [0, 3, 7, 10] },
  { name: 'Am7',   intervals: [0, 3, 7, 10] },
  { name: 'G7',    intervals: [0, 4, 7, 10] },
  { name: 'Dsus4', intervals: [0, 5, 7] },
  { name: 'Asus2', intervals: [0, 2, 7] },
];

export interface Progression {
  name: string;
  /** 每个和弦在几拍上出现（相对 4/4 拍一小节） */
  chords: Chord[];
}

/** 常见进行。每小节一个和弦 */
export const PROGRESSIONS: Progression[] = [
  { name: '经典流行 Am-F-C-G', chords: [chord('Am'), chord('F'), chord('C'), chord('G')] },
  { name: '抒情 C-G-Am-F', chords: [chord('C'), chord('G'), chord('Am'), chord('F')] },
  { name: '小调 i-VI-III-VII', chords: [chord('Am'), chord('F'), chord('C'), chord('G')] },
  { name: '爵士 ii-V-I-VI', chords: [chord('Dm7'), chord('G7'), chord('Cmaj7'), chord('Am7')] },
  { name: '摇滚 I-V-vi-IV', chords: [chord('C'), chord('G'), chord('Am'), chord('F')] },
  { name: 'Lo-fi Am7-Dm7-G7-Cmaj7', chords: [chord('Am7'), chord('Dm7'), chord('G7'), chord('Cmaj7')] },
  { name: '抒情 Ballad F-G-Em-Am', chords: [chord('F'), chord('G'), chord('Em'), chord('Am')] },
  { name: '中国风 C-G-Am-F', chords: [chord('C'), chord('G'), chord('Am'), chord('F')] },
  { name: 'EDM 铺底 Am-F-C-G', chords: [chord('Am'), chord('F'), chord('C'), chord('G')] },
  { name: 'Blues vi-ii-V-I', chords: [chord('Dm'), chord('Eb'), chord('G'), chord('C')] },
];

/** 判断和弦名是否在库中 */
export function hasChord(name: string): boolean {
  return CHORD_LIBRARY.some((c) => c.name === name);
}

/**
 * 取库中的和弦。名字写错时回退到大三和弦，
 * 但调用方应先用 hasChord() 校验，避免静默产生错误内容。
 */
function chord(name: string): Chord {
  const found = CHORD_LIBRARY.find((c) => c.name === name);
  if (found) return found;
  console.warn(`[harmony] 和弦库中不存在「${name}」，已回退为大三和弦`);
  return { name, intervals: [0, 4, 7] };
}

/** 解析和弦名为根音半音值 */
export function rootOf(c: Chord): number {
  const m = c.name.match(/^[A-G][b#]?/);
  if (!m) return 0;
  return NAMES[m[0]] ?? 0;
}

export type ArrangementStyle = 'arpeggio' | 'block' | 'pad' | 'bassline';

/** 风格中文名与说明，UI 直接读取 */
export const STYLE_INFO: Record<ArrangementStyle, { label: string; desc: string }> = {
  arpeggio: { label: '琶音', desc: '和弦音依次落下，像分解和弦，适合铺旋律' },
  block: { label: '柱式', desc: '每小节响两次的和弦，重拍明确，适合 hooking' },
  pad: { label: '铺底', desc: '整个小节持续的长音，营造氛围与空间感' },
  bassline: { label: '贝斯', desc: '只用根音与五度的跳动节奏型，专为低音设计' },
};

/**
 * 为一条 melodic 轨道按进行生成音符。
 * @param trackId 目标轨道
 * @param prog 和弦进行
 * @param style 编排风格
 * @param bars 生成多少小节
 * @param gridSteps 每拍几格（用于算步长）
 * @param baseOctave 根音所在的八度（MIDI：36=C2，48=C3，60=C4）
 */
export function generateNotes(
  trackId: string,
  prog: Progression,
  style: ArrangementStyle,
  bars: number,
  gridSteps: number,
  baseOctave: number,
  idGen: () => string,
): Array<{ id: string; key: number; start: number; length: number; velocity: number; trackId: string }> {
  const out: Array<{ id: string; key: number; start: number; length: number; velocity: number; trackId: string }> = [];
  const stepPerBar = gridSteps * 4;

  for (let bar = 0; bar < bars; bar++) {
    const c = prog.chords[bar % prog.chords.length];
    const rootPc = rootOf(c);
    const barStart = bar * stepPerBar;
    // 把根音吸附到选定八度上最近的那个音
    const rootMidi = baseOctave + ((((rootPc - baseOctave) % 12) + 12) % 12);
    const notes = c.intervals.map((iv) => rootMidi + iv);

    switch (style) {
      case 'arpeggio': {
        // 把和弦音均分到整小节，避免末尾留空拍
        const gap = Math.max(1, Math.round(stepPerBar / notes.length));
        notes.forEach((key, i) => {
          out.push({
            id: idGen(), trackId, key,
            start: barStart + i * gap,
            length: Math.max(1, gap - 1),
            velocity: i === 0 ? 0.95 : 0.68,
          });
        });
        break;
      }
      case 'block': {
        // 第 1 拍和第 3 拍各一个柱式和弦
        for (const offset of [0, gridSteps * 2]) {
          notes.forEach((key, i) => {
            out.push({
              id: idGen(), trackId, key,
              start: barStart + offset,
              length: gridSteps * 2 - 1,
              // 根音更响，其他音轻一些，这是混音的基本原则
              velocity: i === 0 ? 0.95 : 0.7,
            });
          });
        }
        break;
      }
      case 'pad': {
        // 全小节铺满，起点慢起
        notes.forEach((key, i) => {
          out.push({
            id: idGen(), trackId, key,
            start: barStart,
            length: stepPerBar - 1,
            velocity: i === 0 ? 0.8 : 0.6,
          });
        });
        break;
      }
      case 'bassline': {
        // 只用根音与五度，节奏型 1-3-1-4
        const bass = [rootMidi, rootMidi + 7];
        const pattern: Array<[number, number]> = [
          [0, 2], [gridSteps * 2, 2],
          [gridSteps * 3, 1], [gridSteps * 3 + Math.round(gridSteps / 2), 1],
        ];
        pattern.forEach(([off, len], i) => {
          out.push({
            id: idGen(), trackId,
            key: i % 2 === 0 ? bass[0] : bass[1],
            start: barStart + off,
            length: len,
            velocity: i === 0 ? 1 : 0.72,
          });
        });
        break;
      }
    }
  }

  return out;
}

/**
 * 推荐风格对应的合适八度（半音绝对值）。
 * instrument 用于微调：FM 类音色在高频区容易发干，故整体下移。
 */
export function suggestedOctave(style: ArrangementStyle, instrument = 'poly'): number {
  let base: number;
  switch (style) {
    case 'bassline': base = 33; break; // A1
    case 'pad': base = 52; break;      // E3
    case 'block': base = 52; break;
    default: base = 57; break;         // A3
  }
  // 音域修正只在非 bassline 时生效。
  // bassline 本来就要低音，套上乐器的音域偏移反而会把竹笛推到 E2 ——
  // 那个音区吹管基本发不出声，生成出来是一条哑轨。
  if (style !== 'bassline') base += INSTRUMENT_OCTAVE_SHIFT[instrument] ?? 0;
  return base;
}

/**
 * 各乐器的音域偏移（半音）。
 *
 * 为什么要这张表：用同一个 base 生成旋律时，
 * A1(33) 对古筝是低音区边缘（勉强能响），
 * 对竹笛却低了三个八度 —— 吹管在那个音区基本发不出声，
 * 生成出来是一条"哑轨"。用户看到的不是"音域不匹配"，而是"和弦助手坏了"。
 *
 * 数值为经验值（未经实测标定）：按各乐器常用音域的中位数与 A3(57) 的差。
 * 标记为经验判断，不是从物理模型或文献推出的精确值。
 */
const INSTRUMENT_OCTAVE_SHIFT: Record<string, number> = {
  poly: 0,
  fm: -3,       // FM 音色高八度刺耳，下移三度
  pluck: 0,
  bow: 5,       // 二胡/板胡常用音区在 A3 以上
  wind: 7,      // 笛箫常用 D4~D5，比合成器主音高
  yangle: 5,    // 扬琴常用音区与二胡相近
};

/** 清空某轨道的现有音符（生成前调用） */
export function clearTrackNotes(p: Project, trackId: string) {
  p.notes = p.notes.filter((n) => n.trackId !== trackId);
}

/** 当前小节对应的和弦名，用于 UI 显示 */
export function chordAtBar(prog: Progression, bar: number): string {
  return prog.chords[bar % prog.chords.length].name;
}

/** 把 MIDI 音高转成音名，用于预览表 */
const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function midiName(key: number): string {
  return `${PC_NAMES[((key % 12) + 12) % 12]}${Math.floor(key / 12) - 1}`;
}

/**
 * 把一个和弦展开成绝对 MIDI 音高。
 * baseOctave 是"参考音高"，根音会吸附到离它最近的那个同名音，
 * 保证不同和弦生成出来的音区不会上下乱跳。
 */
export function chordKeys(c: Chord, baseOctave: number): number[] {
  const rootPc = rootOf(c);
  const rootMidi = baseOctave + ((((rootPc - baseOctave) % 12) + 12) % 12);
  return c.intervals.map((iv) => rootMidi + iv);
}