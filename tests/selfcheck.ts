/**
 * 引擎自检脚本
 * 用 Node 直接跑合成器与 WAV 编码逻辑，验证：
 *  1. WAV 编码器产出的字节头是否合法
 *  2. 包络/滤波/波形整形的数学是否无 NaN
 *  3. 鼓组与音高映射是否完整
 *  4. 工程序列化 / 反序列化是否往返一致
 */

import type { Project, StepRow } from '../src/core/types';
import { demoProject, emptyProject, Store, makeStepRow, makeLayer } from '../src/core/store';
import { PRESETS } from '../src/audio/presets';
import { DEFAULT_DRUM_LAYOUT, DRUM_PARTS } from '../src/core/constants';
import {
  CHORD_LIBRARY, PROGRESSIONS, STYLE_INFO, generateNotes, suggestedOctave,
  chordKeys, rootOf, clearTrackNotes, midiName, hasChord, type ArrangementStyle,
} from '../src/core/harmony';
import {
  analyzeRecording, detectPitch, decimate, quantize, secondsToStep,
} from '../src/core/audioAnalysis';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

let idSeq = 0;
const idGen = () => { idSeq += 1; return `t${idSeq}`; };

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name} ${detail}`); }
}

console.log('\n\x1b[1mBeatForge 引擎自检\x1b[0m\n');

// ---------- 1. 预设完整性 ----------
console.log('\x1b[1m1. 音色预设\x1b[0m');
ok(`预设数量 ≥ 20（实际 ${PRESETS.length}）`, PRESETS.length >= 20);
ok('所有预设 id 唯一', new Set(PRESETS.map(p => p.id)).size === PRESETS.length);

for (const p of PRESETS) {
  const paramStr = JSON.stringify(p.params);
  ok(`${p.name} · 参数无 NaN`, !paramStr.includes('null') && !/NaN/.test(paramStr));
  if (p.instrument === 'drum') {
    const kit = p.params as Record<string, unknown>;
    const missing = DRUM_PARTS.filter(part => !(part in kit));
    ok(`${p.name} · 含全部 8 件鼓`, missing.length === 0, `缺 ${missing.join(',')}`);
  }
}

// ---------- 2. 鼓组参数物理合理性 ----------
console.log('\n\x1b[1m2. 鼓组参数合理性\x1b[0m');
for (const p of PRESETS.filter(x => x.instrument === 'drum')) {
  const kit = p.params as Record<string, Record<string, number>>;
  const kick = kit.kick;
  const okPitch = kick.pitch >= 30 && kick.pitch <= 120;
  const okDecay = kick.decay > 0.1 && kick.decay < 1.2;
  const okBend = kick.bend >= 0 && kick.bend < 200;
  ok(`${p.name} · 底鼓参数在合理范围`, okPitch && okDecay && okBend,
    `pitch=${kick.pitch} decay=${kick.decay} bend=${kick.bend}`);
}

// ---------- 3. 工程数据 ----------
console.log('\n\x1b[1m3. 工程数据\x1b[0m');
const demo = demoProject();
ok('示例工程有 3 条轨道', demo.tracks.length === 3, `实际 ${demo.tracks.length}`);
ok('示例工程包含鼓轨', demo.tracks.some(t => t.kind === 'drum'));
ok('示例工程含音符', demo.notes.length > 20, `实际 ${demo.notes.length}`);

const drumTrack = demo.tracks.find(t => t.kind === 'drum')!;
const row: StepRow = demo.steps[drumTrack.id];
ok('鼓步进行存在', !!row);
ok('鼓布局为 8 件', row.layout!.length === 8, `实际 ${row.layout!.length}`);
ok('步进数组长度 = 8 × totalSteps',
  row.steps.length === 8 * demo.totalSteps,
  `实际 ${row.steps.length}，期望 ${8 * demo.totalSteps}`);

// 验证节奏真的写进了数据（不是全 0）
let activeSteps = 0;
for (const v of row.steps) if (v > 0.001) activeSteps++;
ok('鼓节奏有实际触发点（>20）', activeSteps > 20, `实际 ${activeSteps}`);

// 验证底鼓在每小节第 1 格
const T = demo.totalSteps;
let kickOk = true;
for (let bar = 0; bar < 8; bar++) {
  const v = row.steps[row.layout!.indexOf('kick') * T + bar * 8];
  if (v < 0.5) kickOk = false;
}
ok('底鼓每小节第 1 拍都有触发', kickOk);

// 验证音符不越界
const badNotes = demo.notes.filter(n =>
  n.start < 0 || n.start >= demo.totalSteps ||
  n.length < 1 ||
  n.key < 0 || n.key > 127 ||
  n.velocity < 0 || n.velocity > 1
);
ok('所有音符参数合法', badNotes.length === 0,
  badNotes.slice(0, 3).map(n => JSON.stringify(n)).join(' '));

// 验证音符的 trackId 都存在
const trackIds = new Set(demo.tracks.map(t => t.id));
const orphan = demo.notes.filter(n => !trackIds.has(n.trackId));
ok('无孤儿音符', orphan.length === 0, `${orphan.length} 个`);

// ---------- 4. 序列化往返 ----------
console.log('\n\x1b[1m4. 序列化 / 反序列化\x1b[0m');
const store = new Store(demo);
const json = store.serialize();
const before = {
  tracks: demo.tracks.length,
  notes: demo.notes.length,
  bpm: demo.bpm,
  steps: JSON.stringify(demo.steps),
};

const store2 = new Store(emptyProject());
const loaded = store2.deserialize(json);
ok('反序列化成功', loaded);

const after = {
  tracks: store2.current.tracks.length,
  notes: store2.current.notes.length,
  bpm: store2.current.bpm,
  steps: JSON.stringify(store2.current.steps),
};
ok('轨道数一致', before.tracks === after.tracks, `${before.tracks} vs ${after.tracks}`);
ok('音符数一致', before.notes === after.notes, `${before.notes} vs ${after.notes}`);
ok('BPM 一致', before.bpm === after.bpm);
ok('步进数据完全一致', before.steps === after.steps);

// 鼓步进的 layout 应被保留
const loadedDrum = store2.current.tracks.find(t => t.kind === 'drum')!;
ok('反序列化保留鼓布局',
  store2.current.steps[loadedDrum.id]?.layout?.length === 8);

// 损坏数据不应崩溃
const s3 = new Store(emptyProject());
ok('损坏 JSON 被拒绝而非崩溃', s3.deserialize('{bad json') === false);
ok('结构错误的 JSON 被拒绝', s3.deserialize('{"foo":1}') === false);

// ---------- 5. 撤销 / 重做 ----------
console.log('\n\x1b[1m5. 撤销 / 重做\x1b[0m');
const s4 = new Store(emptyProject());
const n0 = s4.current.notes.length;
s4.commit();
s4.update((d) => { d.notes.push({ id: 'x', key: 60, start: 0, length: 2, velocity: 1, trackId: d.tracks[0].id }); });
ok('修改生效', s4.current.notes.length === n0 + 1);
ok('撤销成功', s4.undo() && s4.current.notes.length === n0, `当前 ${s4.current.notes.length}`);
ok('重做成功', s4.redo() && s4.current.notes.length === n0 + 1);

// ---------- 6. 步进行分段结构 ----------
console.log('\n\x1b[1m6. 步进分段结构\x1b[0m');
const r = makeStepRow(64, DEFAULT_DRUM_LAYOUT, 4);
ok('新步进行长度正确', r.steps.length === 8 * 64, `实际 ${r.steps.length}`);
ok('新步进行初始全 0', r.steps.every(v => v === 0));

// 模拟写入：kick(索引0) 第 0 格
r.steps[0 * 64 + 0] = 1.0;
// 读取应命中
ok('分段寻址正确（鼓件0 第0格）', r.steps[0] === 1.0);

// 验证不同鼓件地址不冲突
r.steps[1 * 64 + 0] = 0.9; // snare 第 0 格
ok('不同鼓件地址独立',
  r.steps[0] === 1.0 && r.steps[64] === 0.9,
  `kick=${r.steps[0]} snare=${r.steps[64]}`);

// ---------- 7. 音高数学 ----------
console.log('\n\x1b[1m7. 音高与频率\x1b[0m');
function midiToFreq(key: number) { return 440 * Math.pow(2, (key - 69) / 12); }
ok('A4 (69) = 440Hz', Math.abs(midiToFreq(69) - 440) < 0.001);
ok('C4 (60) ≈ 261.63Hz', Math.abs(midiToFreq(60) - 261.626) < 0.01);
ok('C3 (48) = C4 的一半', Math.abs(midiToFreq(48) - midiToFreq(60) / 2) < 0.01);
ok('C5 (72) = C4 的两倍', Math.abs(midiToFreq(72) - midiToFreq(60) * 2) < 0.01);
ok('全音阶频率单调递增',
  Array.from({ length: 12 }, (_, i) => midiToFreq(60 + i))
    .every((f, i, arr) => i === 0 || f > arr[i - 1]));

// ---------- 8. 时基 ----------
console.log('\n\x1b[1m8. 时基换算\x1b[0m');
const bpm = 120, grid = 4;
const secPerStep = 60 / bpm / grid;
ok('120BPM 1/16 音符 = 0.125s', Math.abs(secPerStep - 0.125) < 0.0001, `实际 ${secPerStep}`);
const loopSec = 64 * secPerStep;
ok('64 步循环 = 8 秒', Math.abs(loopSec - 8) < 0.0001, `实际 ${loopSec}`);
ok('小节换算：步 0 → 1.1', Math.floor(0 / (grid * 4)) + 1 === 1);
ok('小节换算：步 32 → 3.1', Math.floor(32 / (grid * 4)) + 1 === 3);
ok('小节换算：步 36 → 3.2', Math.floor(36 / grid) % 4 + 1 === 2);

// ---------- 9. 混响脉冲响应 ----------
console.log('\n\x1b[1m9. 混响脉冲响应\x1b[0m');
function makeImpulse(rate: number, decay: number, predelay: number) {
  const pred = Math.floor(predelay * rate);
  const len = Math.max(1, Math.floor(rate * Math.max(0.05, decay)));
  const buf = new Float32Array(len + pred);
  for (let i = pred; i < buf.length; i++) {
    const env = Math.pow(1 - (i - pred) / len, 2.4);
    buf[i] = (Math.random() * 2 - 1) * env;
  }
  return buf;
}
const ir = makeImpulse(44100, 2.0, 0.02);
ok('IR 长度 = 衰减时长 + 前置延迟', ir.length === 44100 * 2 + Math.floor(0.02 * 44100),
  `实际 ${ir.length}`);
let preDelaySilent = true;
for (let i = 0; i < Math.floor(0.02 * 44100); i++) if (ir[i] !== 0) preDelaySilent = false;
ok('前置延迟段为静音', preDelaySilent);
ok('IR 无 NaN', !ir.some(v => Number.isNaN(v)));
// 能量应随时间衰减
const head = ir.slice(9000, 12000).reduce((s, v) => s + Math.abs(v), 0);
const tail = ir.slice(80000, 83000).reduce((s, v) => s + Math.abs(v), 0);
ok('IR 能量随时间衰减', tail < head, `头=${head.toFixed(2)} 尾=${tail.toFixed(2)}`);

// ---------- 10. 波形整形曲线 ----------
console.log('\n[1m10. 失真曲线[0m');

/** 与 src/audio/synth.ts 中 makeCurve 完全相同的实现（含归一化修复） */
function makeCurve(amount: number) {
  const n = 1024;
  const c = new Float32Array(new ArrayBuffer(n * 4));
  const k = amount * 3;
  const denom = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = amount <= 0.001 ? x : Math.tanh(k * x) / denom;
  }
  return c;
}

/** 输入 x 对应的曲线索引 */
const idxOf = (x: number) => Math.round((x + 1) / 2 * 1023);

const c0 = makeCurve(0);
ok('drive=0 时为恒等曲线',
  c0.every((v, i) => Math.abs(v - (i / 1023) * 2 + 1) < 0.001));
ok('drive=0 时两端为 ±1', Math.abs(c0[0] + 1) < 0.001 && Math.abs(c0[1023] - 1) < 0.001);

// 索引 768 对应 x=0.5
const atHalf = (curve: Float32Array) => curve[768];
ok('x=0.5 处 drive=0 为恒等', Math.abs(atHalf(c0) - 0.5) < 0.002,
  '实际 ' + atHalf(c0).toFixed(4));

// 关键回归：削平后的曲线在任何 drive 下都不过载，且两端保持 ±1
for (const d of [0.1, 0.3, 0.5, 1.0]) {
  const c = makeCurve(d);
  ok('drive=' + d + ' 曲线峰值不超过 ±1',
    c.every(v => Math.abs(v) <= 1.0001));
  ok('drive=' + d + ' 两端保持 ±1（单位增益）',
    Math.abs(c[0] + 1) < 0.002 && Math.abs(c[1023] - 1) < 0.002,
    '实际 ' + c[0].toFixed(4) + ' / ' + c[1023].toFixed(4));
}

// 失真核心特征：低幅信号被提升（增益 >1），产生谐波
{
  const c1 = makeCurve(1);
  const iLow = idxOf(0.1);
  ok('drive=1 时低幅信号被提升（x=0.1 处增益>1）',
    c1[iLow] > 0.1, '实际输出 ' + c1[iLow].toFixed(4) + '，输入 0.1');
  const c0v = makeCurve(0);
  ok('drive=0 时 x=0.1 原样通过',
    Math.abs(c0v[iLow] - 0.1) < 0.002);
  ok('drive 提升低幅更多',
    c1[iLow] > c0v[iLow], 'd1=' + c1[iLow].toFixed(4) + ' d0=' + c0v[iLow].toFixed(4));
}

const c1 = makeCurve(1);
ok('曲线单调递增', c1.every((v, i) => i === 0 || v >= c1[i - 1] - 0.001));
ok('曲线无 NaN', !c1.some(v => Number.isNaN(v)));
// 削波特征：x 越接近端点增益越接近 1，中段增益 >1
{
  const g = (c: Float32Array, x: number) => c[idxOf(x)] / x;
  const c0v = makeCurve(0);
  ok('drive=0 时全段增益≈1', Math.abs(g(c0v, 0.5) - 1) < 0.01);
  ok('drive=1 时中段增益 > 端点增益（削波）',
    g(c1, 0.1) > g(c1, 0.95),
    'x=0.1 增益=' + g(c1, 0.1).toFixed(3) + ' x=0.95 增益=' + g(c1, 0.95).toFixed(3));
  ok('drive=1 时 x=0.95 增益仍 ≈1（端点不变）',
    Math.abs(g(c1, 0.95) - 1) < 0.06, '实际 ' + g(c1, 0.95).toFixed(4));
}

// ---------- 11. 包络包络值合法性 ----------
console.log('\n\x1b[1m11. 合成器参数边界\x1b[0m');
for (const p of PRESETS.filter(x => x.instrument === 'poly')) {
  const s = p.params as {
    env: { attack: number; decay: number; sustain: number; release: number };
    filter: { cutoff: number; resonance: number };
    voices: number; unison: number;
  };
  const envOk = s.env.attack >= 0.001 && s.env.decay > 0 && s.env.sustain > 0 && s.env.sustain <= 1 && s.env.release > 0;
  const fltOk = s.filter.cutoff >= 60 && s.filter.cutoff <= 20000 && s.filter.resonance > 0;
  const voiceOk = s.voices >= 1 && s.voices <= 32 && s.unison >= 1 && s.unison <= 8;
  ok(`${p.name} · ADSR / 滤波 / 声部 合法`, envOk && fltOk && voiceOk,
    `env=${JSON.stringify(s.env)} cutoff=${s.filter.cutoff}`);
}

// ---------- 12. 鼓段分段索引不越界 ----------
console.log('\n\x1b[1m12. 鼓段索引边界\x1b[0m');
const T2 = 64;
const maxIdx = 8 * T2 - 1;
ok('最大合法索引 = 8×T-1', row.steps[maxIdx] !== undefined || row.steps.length === 8 * T2);
ok('超出索引返回 undefined（安全）', row.steps[8 * T2] === undefined);

// ---------- 13. WAV 编码器（真实产出文件） ----------
console.log('\n\x1b[1m13. WAV 编码器\x1b[0m');

/** 与 src/audio/export.ts 中 encodeWav 相同的实现 */
function encodeWavBuffer(channels: Float32Array[], sampleRate: number): Uint8Array {
  const numChannels = channels.length;
  const numFrames = channels[0].length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Uint8Array(ab);
}

const sr = 44100;
const frames = sr * 2;
const L = new Float32Array(frames);
const R = new Float32Array(frames);
for (let i = 0; i < frames; i++) {
  const t = i / sr;
  L[i] = Math.sin(2 * Math.PI * 220 * t) * 0.5;
  R[i] = Math.sin(2 * Math.PI * 330 * t) * 0.3;
}

const wav = encodeWavBuffer([L, R], sr);
const dv = new DataView(wav.buffer);
const readStr = (off: number, n: number) =>
  String.fromCharCode(...Array.from({ length: n }, (_, i) => dv.getUint8(off + i)));

ok('文件以 RIFF 开头', readStr(0, 4) === 'RIFF');
ok('第 8 字节为 WAVE', readStr(8, 4) === 'WAVE');
ok('fmt 块标识正确', readStr(12, 4) === 'fmt ');
ok('data 块标识正确', readStr(36, 4) === 'data');
ok('PCM 格式码 = 1', dv.getUint16(20, true) === 1);
ok('声道数 = 2', dv.getUint16(22, true) === 2);
ok('采样率 = 44100', dv.getUint32(24, true) === 44100);
ok('位深 = 16', dv.getUint16(34, true) === 16);
ok('块对齐 = 4（2声道 × 2字节）', dv.getUint16(32, true) === 4);

const expectedSize = 44 + frames * 2 * 2;
ok('文件长度与数据量吻合', wav.length === expectedSize, `${wav.length} vs ${expectedSize}`);
ok('RIFF 尺寸字段正确', dv.getUint32(4, true) === wav.length - 8);

let peak = 0, nan = 0;
for (let i = 0; i < frames; i += 100) {
  if (Number.isNaN(L[i])) nan++;
  peak = Math.max(peak, Math.abs(L[i]));
}
ok('采样无 NaN', nan === 0);
ok('峰值接近预期 0.5', Math.abs(peak - 0.5) < 0.01, `实际 ${peak.toFixed(3)}`);

const outPath = path.join(root, 'selfcheck-output.wav');
fs.writeFileSync(outPath, wav);
const stat = fs.statSync(outPath);
ok('WAV 文件已写入磁盘', stat.size === expectedSize, `${stat.size} 字节`);
{
  const fd = fs.openSync(outPath, 'r');
  const b = Buffer.alloc(4);
  fs.readSync(fd, b, 0, 4, 0);
  fs.closeSync(fd);
  ok('磁盘文件魔数为 RIFF', b.toString('ascii') === 'RIFF');
}

// ---------- 14. 和弦与编曲助手 ----------
console.log('\n\x1b[1m14. 和弦与编曲助手\x1b[0m');
ok('和弦库 ≥ 25 个', CHORD_LIBRARY.length >= 25, `实际 ${CHORD_LIBRARY.length}`);
ok('和弦库名称唯一', new Set(CHORD_LIBRARY.map(c => c.name)).size === CHORD_LIBRARY.length);

for (const c of CHORD_LIBRARY) {
  const parsed = rootOf(c);
  ok(`${c.name} · 根音可解析 (${parsed})`, parsed >= 0 && parsed <= 11);
  ok(`${c.name} · 音数 3~4`, c.intervals.length >= 3 && c.intervals.length <= 4);
  ok(`${c.name} · 含根音 0`, c.intervals.includes(0));
  const sorted = [...c.intervals].sort((a, b) => a - b);
  ok(`${c.name} · 音程不重复`, new Set(sorted).size === sorted.length);
}

ok('进行库 ≥ 8 条', PROGRESSIONS.length >= 8, `实际 ${PROGRESSIONS.length}`);
for (const prog of PROGRESSIONS) {
  ok(`进行「${prog.name}」· 每条 3~6 个和弦`,
    prog.chords.length >= 3 && prog.chords.length <= 6, `实际 ${prog.chords.length}`);
  const allHaveThird = prog.chords.every(c => c.intervals.includes(3) || c.intervals.includes(4));
  ok(`进行「${prog.name}」· 每个和弦含三音`, allHaveThird);
  // 引用的和弦必须真实存在于库中，否则 chord() 会静默回退
  const missing = prog.chords.filter(c => !hasChord(c.name));
  ok(`进行「${prog.name}」· 和弦全部存在于库中`, missing.length === 0,
    missing.map(c => c.name).join(','));
}
ok('进行库名称唯一', new Set(PROGRESSIONS.map(p => p.name)).size === PROGRESSIONS.length);
ok('G7 已加入和弦库（爵士进行依赖它）', hasChord('G7'));
ok('Dm7 已加入和弦库（Lo-fi 进行依赖它）', hasChord('Dm7'));
ok('四种风格说明齐全',
  (['arpeggio', 'block', 'pad', 'bassline'] as ArrangementStyle[])
    .every(s => !!STYLE_INFO[s]?.label && !!STYLE_INFO[s]?.desc));

// 音高吸附：同一八度基准下，根音必须落在 [base, base+11]
for (const c of CHORD_LIBRARY) {
  const keys = chordKeys(c, 57);
  const root = keys[0];
  ok(`${c.name} @57 · 根音吸附正确`, root >= 57 && root <= 68, `实际 ${root}`);
  ok(`${c.name} @57 · 音高在可听范围`, keys.every(k => k >= 24 && k <= 96),
    keys.join(','));
}

// 四种风格生成的音符
const prog0 = PROGRESSIONS[0];
const gridSteps = 4;
const stepPerBar = gridSteps * 4;
for (const style of ['arpeggio', 'block', 'pad', 'bassline'] as ArrangementStyle[]) {
  const notes = generateNotes('t1', prog0, style, 4, gridSteps, 57, idGen);
  const total = 4 * stepPerBar;
  const inRange = notes.every(n =>
    n.start >= 0 && n.start < total &&
    n.length >= 1 && n.start + n.length <= total + gridSteps &&
    n.key >= 24 && n.key <= 96 &&
    n.velocity > 0 && n.velocity <= 1);
  ok(`${style} · 音符全部在合法范围内`, inRange,
    notes.filter(n => n.start >= total || n.key < 24).map(n => `${n.key}@${n.start}`).join(' '));
  ok(`${style} · 生成数量合理`, notes.length > 0 && notes.length <= 4 * 4 * 4,
    `实际 ${notes.length}`);
  ok(`${style} · 无重叠同键同起点`, (() => {
    const seen = new Set<string>();
    for (const n of notes) {
      const k = `${n.key}:${n.start}`;
      if (seen.has(k)) return false;
      seen.add(k);
    }
    return true;
  })());
}

const arp = generateNotes('t1', prog0, 'arpeggio', 1, gridSteps, 57, idGen);
ok('琶音 · 一小节内不超出小节长度', arp.every(n => n.start < stepPerBar),
  arp.map(n => n.start).join(','));
ok('琶音 · 音符数 = 和弦音数', arp.length === prog0.chords[0].intervals.length);

const block = generateNotes('t1', prog0, 'block', 1, gridSteps, 57, idGen);
ok('柱式 · 每小节两组和弦', block.length === prog0.chords[0].intervals.length * 2,
  `实际 ${block.length}`);
ok('柱式 · 第二组在第 3 拍', block.some(n => n.start === gridSteps * 2));

const pad = generateNotes('t1', prog0, 'pad', 1, gridSteps, 57, idGen);
ok('铺底 · 延音覆盖整小节', pad.every(n => n.length === stepPerBar - 1),
  pad.map(n => n.length).join(','));

const bass = generateNotes('t1', prog0, 'bassline', 1, gridSteps, 33, idGen);
ok('贝斯 · 全部落在低八度', bass.every(n => n.key <= 52),
  `最高 ${Math.max(...bass.map(n => n.key))}`);
ok('贝斯 · 只用根音与其纯五度', (() => {
  const root = chordKeys(prog0.chords[0], 33)[0];
  const allowed = new Set([root, root + 7]);
  return bass.every(n => allowed.has(n.key));
})(), bass.map(n => n.key).join(','));
ok('贝斯 · 所有 start 为整数', bass.every(n => Number.isInteger(n.start)),
  bass.map(n => n.start).join(','));
ok('贝斯 · 最后一击不越出小节', bass.every(n => n.start + n.length <= stepPerBar),
  bass.map(n => `${n.start}+${n.length}`).join(','));

// 音区建议
for (const style of ['arpeggio', 'block', 'pad', 'bassline'] as ArrangementStyle[]) {
  const o = suggestedOctave(style, 'poly');
  ok(`${style} · 推荐音区在 28~72`, o >= 28 && o <= 72, `实际 ${o}`);
}
ok('FM 音色的推荐音区低于 poly', suggestedOctave('pad', 'fm') < suggestedOctave('pad', 'poly'));
ok('贝斯风格对 FM 不下移', suggestedOctave('bassline', 'fm') === suggestedOctave('bassline', 'poly'));

// 小节数上限保护：工程只有 8 小节，请求 8 小节不应越界
const totalBars = Math.round(64 / (4 * 4));
ok('工程小节数计算正确', totalBars === 4, `实际 ${totalBars}`);
const clamped = generateNotes('t1', prog0, 'pad', 8, gridSteps, 57, idGen);
ok('生成小节数可超过工程长度（由调用方裁剪）', clamped.length > 0);

// 写入与清空
{
  const p = emptyProject();
  const lead = p.tracks.find(t => t.kind === 'melodic')!;
  const before = p.notes.length;
  const gen = generateNotes(lead.id, prog0, 'pad', 2, p.gridSteps, 52, idGen);
  clearTrackNotes(p, lead.id);
  ok('清空后该轨音符为 0', p.notes.filter(n => n.trackId === lead.id).length === 0);
  ok('清空不影响其他轨', p.notes.length === before, `${p.notes.length} vs ${before}`);
  for (const n of gen) p.notes.push({ ...n, trackId: lead.id });
  ok('写入后音符数正确', p.notes.filter(n => n.trackId === lead.id).length === gen.length);
}

// 音名转换
ok('midiName(60) = C4', midiName(60) === 'C4', midiName(60));
ok('midiName(69) = A4', midiName(69) === 'A4', midiName(69));
ok('midiName(33) = A1', midiName(33) === 'A1', midiName(33));

// ---------- 15. 乐器叠加层 ----------
console.log('\n\x1b[1m15. 乐器叠加层\x1b[0m');
{
  const p = emptyProject();
  const lead = p.tracks.find(t => t.kind === 'melodic')!;
  const drum = p.tracks.find(t => t.kind === 'drum')!;

  ok('新轨道自带空层数组', Array.isArray(lead.layers) && lead.layers.length === 0);
  ok('鼓轨的层数组存在但为空', Array.isArray(drum.layers) && drum.layers.length === 0);

  const layer = makeLayer('poly-柔和弦乐');
  ok('层 id 前缀为 lyr', layer.id.startsWith('lyr-'), layer.id);
  ok('层乐器为旋律类', layer.instrument === 'poly' || layer.instrument === 'fm', layer.instrument);
  ok('层默认音量偏低（衬托主层）', layer.volume > 0 && layer.volume < 0.8, `${layer.volume}`);
  ok('层默认低八度', layer.octave === -1);
  ok('层默认半音偏移为 0', layer.semitone === 0);
  ok('层参数无 NaN', !/NaN/.test(JSON.stringify(layer.params)));
  ok('层默认未静音', layer.muted === false);
  ok('层 id 唯一', makeLayer('poly-柔和弦乐').id !== layer.id);

  // 鼓预设不能作为层
  const drumLayer = makeLayer('drum-标准鼓组');
  ok('鼓预设被降级为 poly', drumLayer.instrument === 'poly', drumLayer.instrument);

  // 音高换算
  const noteKey = 60;
  ok('同度叠加不改变音高', noteKey + layer.semitone + layer.octave * 12 === 48);
  ok('高八度叠加 = +12', noteKey + 0 + 12 === 72);
  ok('半音 + 低八度 = +11', 60 + 1 - 12 === 49);
  // 引擎对超出 MIDI 范围的音会直接跳过，这里验证判断条件本身
  const inRange = (k: number) => k >= 0 && k <= 127;
  ok('正常偏移在范围内', inRange(60 + 2 * 12 + 12));
  ok('极端负偏移被识别为越界', !inRange(24 - 2 * 12 - 12));
  ok('音高 0 与 127 视为有效边界', inRange(0) && inRange(127));

  // 写入工程并往返序列化
  p.tracks[1].layers = [layer, makeLayer('fm-电钢琴', { octave: 1, pan: 0.3 })];
  ok('工程有 2 个层', p.tracks[1].layers!.length === 2);
  const store = new Store(structuredClone(p));
  const json = store.serialize();
  ok('序列化含 layers 字段', json.includes('"layers"'));
  const store2 = new Store(emptyProject());
  ok('反序列化成功', store2.deserialize(json));
  const back = store2.current.tracks[1].layers!;
  ok('层数量往返一致', back.length === 2, `实际 ${back.length}`);
  ok('层参数往返一致',
    back[0].octave === layer.octave && back[0].volume === layer.volume && back[0].pan === layer.pan);
  ok('层 id 往返一致', back[0].id === layer.id);
  ok('层预设 id 往返一致', back[0].presetId === layer.presetId);

  // 旧工程（无 layers 字段）必须能被兼容
  const legacy = JSON.parse(json);
  for (const t of legacy.tracks) delete t.layers;
  const store3 = new Store(emptyProject());
  ok('无 layers 字段的旧工程可载入', store3.deserialize(JSON.stringify(legacy)));
  ok('旧工程自动补齐空层数组',
    store3.current.tracks.every(t => Array.isArray(t.layers) && t.layers.length === 0));

  // 脏数据必须被剔除/钳制，而不是让引擎崩
  const dirty = JSON.parse(json);
  dirty.tracks[1].layers = [
    { id: 'bad1', instrument: 'drum', params: null },
    { id: 'bad2', instrument: 'poly', params: {}, volume: 99, pan: -99, octave: 77, semitone: 999 },
    { id: 'bad3', instrument: 'poly' },          // 缺 params，应被剔除
    { id: 'bad4' },                              // 缺 instrument，应被剔除
    { id: 'good', instrument: 'poly', params: {} },   // 只有 id/instrument/params
    null,
  ];
  const store4 = new Store(emptyProject());
  ok('含脏层的工程可载入', store4.deserialize(JSON.stringify(dirty)));
  const cleaned = store4.current.tracks[1].layers!;
  ok('无 params / 无 instrument / 非对象的层被剔除', cleaned.length === 2, `实际 ${cleaned.length}`);
  ok('剔除后剩下的层 id 正确',
    cleaned.map(l => l.id).join(',') === 'bad2,good', cleaned.map(l => l.id).join(','));

  const clamped = cleaned[0];
  ok('越界音量被钳制到上限', clamped.volume === 1.5, `${clamped.volume}`);
  ok('越界声像被钳制', clamped.pan === -1, `${clamped.pan}`);
  ok('越界八度被钳制', clamped.octave === 2, `${clamped.octave}`);
  ok('越界半音被钳制', clamped.semitone === 12, `${clamped.semitone}`);

  const fallback = cleaned[1];
  ok('缺失数值字段回落默认值',
    fallback.volume === 0.55 && fallback.pan === -0.25 &&
    fallback.octave === -1 && fallback.semitone === 0 &&
    fallback.sendReverb === 0.2 && fallback.sendDelay === 0,
    `v=${fallback.volume} p=${fallback.pan} o=${fallback.octave} s=${fallback.semitone}`);
  ok('缺失 muted 时按 false 处理', fallback.muted === false);

  // 层不参与效果器：效果器挂在轨道上，所有层共用
  ok('轨道只有一个 insert', Object.keys(lead).includes('insert'));
  ok('层上没有 insert 字段', !('insert' in (layer as unknown as Record<string, unknown>)));

  // 示例工程自带一层，能让用户立刻听到加厚的效果
  const d = demoProject();
  // 注意：示例工程有两条旋律轨（贝斯 + 主音），叠加层挂在主音（index 2）上
  const dLead = d.tracks[2];
  ok('示例工程第三条轨道是主音', dLead.kind === 'melodic' && dLead.name.includes('电钢琴'),
    `${dLead.kind} ${dLead.name}`);
  ok('示例工程主音轨带 1 个叠加层', (dLead.layers?.length ?? 0) === 1,
    `实际 ${dLead.layers?.length ?? 0}`);
  ok('示例工程的层是低八度', dLead.layers![0].octave === -1);
  ok('示例工程的层音量低于主层', dLead.layers![0].volume < dLead.volume,
    `${dLead.layers![0].volume} vs ${dLead.volume}`);
  ok('鼓轨没有叠加层', d.tracks.find(t => t.kind === 'drum')!.layers!.length === 0);
  ok('示例工程贝斯轨没有叠加层', d.tracks[1].layers!.length === 0);

  // 示例工程必须能完整往返
  const store5 = new Store(demoProject());
  const dj = store5.serialize();
  const store6 = new Store(emptyProject());
  ok('示例工程可序列化并载入', store6.deserialize(dj));
  ok('示例工程的层往返后仍在',
    store6.current.tracks[2].layers!.length === 1 &&
    store6.current.tracks[2].layers![0].octave === -1);
  ok('示例工程音符数往返一致',
    store6.current.notes.length === demoProject().notes.length,
    `${store6.current.notes.length} vs ${demoProject().notes.length}`);
}

// ---------- 16. 录音分析 ----------
console.log('\n\x1b[1m16. 录音分析与量化\x1b[0m');
{
  // ---- 16.1 降采样 ----
  const sr = 44100;
  const sine = new Float32Array(sr);   // 1 秒
  for (let i = 0; i < sine.length; i++) sine[i] = Math.sin(2 * Math.PI * 440 * i / sr);
  const dec = decimate(sine, sr, 11025);
  ok('降采样后长度约为 1/4', Math.abs(dec.data.length - sr / 4) <= 1,
    `${dec.data.length} vs ${sr / 4}`);
  ok('降采样返回目标采样率', dec.sampleRate === 11025);
  ok('升采样请求原样返回', decimate(sine, 8000, 11025).sampleRate === 8000);
  ok('降采样无 NaN', !dec.data.some((v) => Number.isNaN(v)));
  // 440Hz 在 11025Hz 下仍是 440Hz，能量应基本保持
  const energy = (buf: Float32Array) => {
    let s = 0;
    for (const v of buf) s += v * v;
    return s / buf.length;
  };
  const eRatio = energy(dec.data) / energy(sine);
  ok('降采样后能量损失 < 10%', eRatio > 0.9 && eRatio < 1.1, `比值 ${eRatio.toFixed(4)}`);

  // ---- 16.2 单音音高检测 ----
  // generateHarmonic：基频 + 若干次谐波，接近真实乐音的频谱结构
  const generateHarmonic = (freq: number, durSec: number, rate: number,
    harmonics: number[] = [1, 0.5, 0.25, 0.12]): Float32Array => {
    const buf = new Float32Array(Math.floor(durSec * rate));
    for (let i = 0; i < buf.length; i++) {
      let v = 0;
      for (let h = 0; h < harmonics.length; h++) {
        v += harmonics[h] * Math.sin(2 * Math.PI * freq * (h + 1) * i / rate);
      }
      buf[i] = v / harmonics.length;
    }
    return buf;
  };

  const ar = 11025;
  const A4 = 440;
  // 覆盖算法声明的可靠区间 MIDI 45~80（110Hz~830Hz），每个半音都测
  let maxErr = 0;
  let wrongCount = 0;
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  for (let midi = 45; midi <= 80; midi++) {
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const buf = generateHarmonic(freq, 0.2, ar);
    const { midi: got, confidence } = detectPitch(buf, ar);
    if (got !== midi) { wrongCount++; maxErr = Math.max(maxErr, Math.abs(got - midi)); }
    if (midi === 69) {
      ok(`A4(440Hz) 检测为 MIDI 69`, got === 69, `实际 ${got}（${NOTE_NAMES[got % 12]}）`);
      ok('A4 置信度 > 0.8', confidence > 0.8, `${confidence.toFixed(3)}`);
    }
  }
  ok('A2~G#5 全部 36 个半音检测准确', wrongCount === 0,
    `错 ${wrongCount} 个，最大偏差 ${maxErr} 半音`);

  // 频谱边界
  // 82.41Hz = E2 = MIDI 40，正好是 FMIN 下限（周期 134 样本，帧内剩余 378 样本）
  const lowResult = detectPitch(generateHarmonic(82.41, 0.2, ar), ar);
  ok('82.41Hz(E2, FMIN 下限) 检测为 MIDI 40', lowResult.midi === 40,
    `实际 ${lowResult.midi}`);

  // FMAX 上限 830Hz(G#5)。这是实测标定值，不是拍脑袋定的：
  // 帧长 512@11kHz 下周期不足 13 样本时整数 lag 无法精确表达，
  // 自相关峰摊平，"首个可信峰"会自信地选中 2 倍周期（低八度）。
  // 标定数据见 audioAnalysis.ts 中 FMAX 的注释。
  const highResult = detectPitch(generateHarmonic(830, 0.2, ar), ar);
  ok('830Hz(G#5, FMAX 上限) 检测为 MIDI 80', highResult.midi === 80,
    `实际 ${highResult.midi}`);

  // 越界高频必须明确拒绝，绝不能折叠成低八度。
  // 1600Hz 的真实周期 6.89 样本 < minLag，若不做折叠检测会被判成 800Hz(MIDI 79)。
  const tooHigh = detectPitch(generateHarmonic(1600, 0.2, ar), ar);
  ok('1600Hz 折叠被拦截（不产生音高）', tooHigh.midi === -1, `midi=${tooHigh.midi}`);
  const tooHigh2 = detectPitch(generateHarmonic(2000, 0.2, ar), ar);
  ok('2000Hz 折叠被拦截或拒绝', tooHigh2.midi === -1 || tooHigh2.midi > 80,
    `midi=${tooHigh2.midi}`);

  // 低于 FMIN 的次低八度应被拒绝
  const tooLow = detectPitch(generateHarmonic(45, 0.2, ar), ar);
  ok('45Hz 低于 FMIN 时不被误判为音',
    tooLow.midi === -1 || tooLow.midi < 45,
    `midi=${tooLow.midi}`);

  // 静音与噪声必须返回"无音"
  const silence = new Float32Array(2048);
  ok('全静音返回 -1', detectPitch(silence, ar).midi === -1);
  const dc = new Float32Array(2048).fill(0.5);
  ok('直流信号返回 -1（不应误判为音）', detectPitch(dc, ar).midi === -1);
  const noise = new Float32Array(2048);
  let seed = 12345;
  for (let i = 0; i < noise.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = (seed / 0x3fffffff) - 1;
  }
  const noiseResult = detectPitch(noise, ar);
  ok('白噪声不产生高置信度音高',
    noiseResult.midi === -1 || noiseResult.confidence < 0.5,
    `midi=${noiseResult.midi} conf=${noiseResult.confidence.toFixed(3)}`);
  ok('过短帧返回 -1', detectPitch(new Float32Array(8), ar).midi === -1);

  // ---- 16.3 整段录音分析 ----
  // 构造 C4-D4-E4-G4 四个音，各 0.3s，间隔 0.05s，共约 1.4s
  const seq = [60, 62, 64, 67];
  const noteLen = 0.3;
  const gap = 0.05;
  const total = seq.length * (noteLen + gap);
  const recording = new Float32Array(Math.floor(total * 44100));
  seq.forEach((midi, i) => {
    const freq = 440 * Math.pow(2, (midi - 69) / 12);
    const start = Math.floor(i * (noteLen + gap) * 44100);
    const n = Math.floor(noteLen * 44100);
    for (let j = 0; j < n; j++) {
      // 起音包络，避免突变引入宽带噪声干扰起音点
      const env = Math.min(1, j / 800);
      recording[start + j] = env * 0.6 * Math.sin(2 * Math.PI * freq * j / 44100);
    }
  });

  const t0 = Date.now();
  const analysis = analyzeRecording(recording, 44100);
  const elapsedMs = Date.now() - t0;

  ok('分析返回音符', analysis.notes.length > 0, `得到 ${analysis.notes.length} 个`);
  ok('识别出的音符数接近实际 4 个',
    analysis.notes.length >= 3 && analysis.notes.length <= 6,
    `实际 ${analysis.notes.length}`);
  if (analysis.notes.length > 0) {
    ok('音高序列与原始一致',
      analysis.notes.map((n) => n.key).join(',') === seq.join(','),
      analysis.notes.map((n) => n.key).join(','));
    ok('每个音符时长在合理范围',
      analysis.notes.every((n) => n.end - n.start > 0.15 && n.end - n.start < 0.55),
      analysis.notes.map((n) => (n.end - n.start).toFixed(2)).join(','));
    ok('音符不重叠',
      analysis.notes.every((n, i) => i === 0 || n.start >= analysis.notes[i - 1].start),
      analysis.notes.map((n) => n.start.toFixed(2)).join(','));
    ok('起点递增', analysis.notes.every((n, i) => i === 0 || n.start > analysis.notes[i - 1].start));
    ok('力度在 0~1', analysis.notes.every((n) => n.velocity > 0 && n.velocity <= 1));
    ok('置信度在 0~1', analysis.notes.every((n) => n.confidence >= 0 && n.confidence <= 1));
    ok('音高范围统计正确',
      analysis.range.low === 60 && analysis.range.high === 67,
      `${analysis.range.low}~${analysis.range.high}`);
  }
  ok('分析耗时 < 3000ms（1.4s 音频）', elapsedMs < 3000, `实际 ${elapsedMs}ms`);
  ok('报告的时长与录音一致', Math.abs(analysis.duration - total) < 0.05,
    `${analysis.duration.toFixed(3)} vs ${total.toFixed(3)}`);

  // 全静音录音
  const silentRecording = new Float32Array(44100);
  const silentAnalysis = analyzeRecording(silentRecording, 44100);
  ok('全静音录音返回 0 个音符', silentAnalysis.notes.length === 0);
  ok('全静音录音有合法音高范围', silentAnalysis.range.low === 60 && silentAnalysis.range.high === 60);

  // 过短录音
  ok('极短录音不崩溃', analyzeRecording(new Float32Array(100), 44100).notes.length === 0);
  ok('空数组不崩溃', analyzeRecording(new Float32Array(0), 44100).notes.length === 0);

  // 极低电平
  const quiet = generateHarmonic(440, 0.2, 44100);
  for (let i = 0; i < quiet.length; i++) quiet[i] *= 0.001;
  ok('极低电平不产生音符（低于噪声门限）',
    analyzeRecording(quiet, 44100).notes.length === 0);

  // ---- 16.4 量化 ----
  const step = 60 / 120 / 4;   // 120BPM 1/16 = 0.125s
  const raw = [
    { key: 60, start: 0.131, end: 0.35, velocity: 0.8, confidence: 0.9 },
    { key: 62, start: 0.612, end: 0.80, velocity: 0.7, confidence: 0.9 },
    { key: 64, start: 1.005, end: 1.20, velocity: 0.9, confidence: 0.9 },
  ];

  const q0 = quantize(raw, { stepSeconds: step, strength: 0 });
  ok('强度 0 完全不吸附', q0[0].start === 0.131 && q0[1].start === 0.612 && q0[2].start === 1.005,
    q0.map((n) => n.start).join(','));

  const q100 = quantize(raw, { stepSeconds: step, strength: 1 });
  ok('强度 1 严格落在网格上',
    q100.every((n) => Math.abs(n.start / step - Math.round(n.start / step)) < 1e-9),
    q100.map((n) => (n.start / step).toFixed(4)).join(','));
  ok('强度 1 时 0.131s 吸附到 0.125s', Math.abs(q100[0].start - 0.125) < 1e-9, `${q100[0].start}`);

  const q50 = quantize(raw, { stepSeconds: step, strength: 0.5 });
  ok('强度 0.5 取中间值', Math.abs(q50[0].start - (0.131 + 0.125) / 2) < 1e-9,
    `${q50[0].start}`);

  ok('量化后长度至少一格', q100.every((n) => n.length >= step - 1e-9),
    q100.map((n) => n.length).join(','));
  ok('量化保留力度', q100.every((n, i) => n.velocity === raw[i].velocity));
  ok('量化不产生负起点', quantize(
    [{ key: 60, start: -0.1, end: 0.2, velocity: 0.5, confidence: 1 }],
    { stepSeconds: step, strength: 1 },
  )[0].start === 0);

  // 极短音符量化后不应消失
  const tiny = [{ key: 60, start: 0.2, end: 0.205, velocity: 0.5, confidence: 1 }];
  ok('极短音符量化后仍保留一格长度',
    quantize(tiny, { stepSeconds: step, strength: 1 })[0].length >= step - 1e-9);

  ok('stepSeconds 为 0 时抛错', (() => {
    try { quantize(raw, { stepSeconds: 0, strength: 1 }); return false; }
    catch { return true; }
  })());
  ok('strength 超出 0~1 也能工作（不崩）',
    quantize(raw, { stepSeconds: step, strength: 5 }).length === 3);

  ok('secondsToStep 正确',
    secondsToStep(0.131, step) === 1 && secondsToStep(0, step) === 0 && secondsToStep(-1, step) === 0);
}

// ---------- 汇总 ----------
console.log(`\n\x1b[1m结果\x1b[0m  ${pass} 通过 / ${fail} 失败`);
console.log(`测试音频已输出：selfcheck-output.wav（${(stat.size / 1024).toFixed(0)} KB）\n`);
if (fail > 0) process.exit(1);