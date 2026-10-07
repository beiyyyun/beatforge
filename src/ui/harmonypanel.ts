/**
 * 编曲助手面板
 * ============================================
 * 目标：不会乐理的人也能在 10 秒内得到一段和谐的和弦伴奏。
 *
 * 交互路径：
 *   选进行 → 选风格 → 选目标轨道 → 点「生成」
 *
 * 设计取舍：
 *   - 不暴露"级数""罗马数字"等术语，只给"听起来是什么感觉"的描述
 *   - 生成前会显示将要写入的每个和弦的实际音高，不做黑箱
 *   - 生成是"覆盖该轨"而非"追加"，避免用户反复点生成叠出脏音符
 */

import { el, slider, dropdown, segmented } from './dom';
import {
  PROGRESSIONS, STYLE_INFO, generateNotes, suggestedOctave, chordKeys,
  type ArrangementStyle,
} from '../core/harmony';
import { keyToName } from '../core/constants';
import type { Project } from '../core/types';

export interface HarmonyCallbacks {
  /** 生成音符。notes 为空数组表示清空该轨 */
  onGenerate: (
    trackId: string,
    notes: Array<{ id: string; key: number; start: number; length: number; velocity: number }>,
  ) => void;
  /** 试听一个和弦；holdMs 为按住时长，组件负责松开 */
  onPreviewChord: (trackId: string, keys: number[], holdMs: number) => void;
  /** 需要一条新的旋律轨道 */
  onCreateTrack: (style: ArrangementStyle) => void;
}

const STYLE_ORDER: ArrangementStyle[] = ['arpeggio', 'block', 'pad', 'bassline'];

export class HarmonyPanel {
  readonly root: HTMLElement;

  private progIndex = 0;
  private style: ArrangementStyle = 'arpeggio';
  private bars = 4;
  private octave = 57;
  private targetId: string | null = null;

  constructor(private cb: HarmonyCallbacks) {
    this.root = el('div', { class: 'panel' });
  }

  /** 外部（如通道机架选中轨道）改变选择时同步 */
  setTarget(trackId: string | null) {
    this.targetId = trackId;
  }

  render(project: Project, selectedTrackId: string | null) {
    // 目标轨道必须是旋律轨；当前选择无效时自动找第一条
    const melodic = project.tracks.filter((t) => t.kind === 'melodic');
    if (!melodic.some((t) => t.id === this.targetId)) {
      this.targetId = selectedTrackId && melodic.some((t) => t.id === selectedTrackId)
        ? selectedTrackId
        : melodic[0]?.id ?? null;
    }
    const target = melodic.find((t) => t.id === this.targetId) ?? null;

    // 风格切换时把八度重置到该风格的推荐值
    if (target) this.octave = suggestedOctave(this.style, target.instrument);

    const layout = el('div', { class: 'harm-layout' });

    // ================= 左：和弦进行 =================
    const list = el('div', { class: 'harm-list' });
    list.append(el('div', { class: 'browser-section' }, '选一段和弦进行'));

    PROGRESSIONS.forEach((prog, i) => {
      const item = el('div', {
        class: `harm-item${i === this.progIndex ? ' is-active' : ''}`,
        title: `${prog.name} · 点击选用`,
      });
      const name = el('div', { class: 'harm-item-name' }, prog.name);
      const tags = el('div', { class: 'harm-item-tags' });
      // 只展示前 4 小节标签，超过则加省略号
      for (const c of prog.chords.slice(0, 6)) {
        tags.append(el('span', { class: 'harm-tag' }, c.name));
      }
      if (prog.chords.length > 6) tags.append(el('span', { class: 'harm-tag' }, '…'));
      item.append(name, tags);
      item.addEventListener('click', () => {
        this.progIndex = i;
        this.render(project, selectedTrackId);
      });
      list.append(item);
    });

    // ================= 右：参数与生成 =================
    const editor = el('div', { class: 'harm-editor' });

    if (melodic.length === 0) {
      editor.append(el('div', { class: 'fx-empty' },
        '还没有旋律轨道。', el('br'),
        '和弦必须落在旋律乐器上，先新建一条。'));
      const mk = el('button', { class: 'btn btn-primary', type: 'button' }, '新建一条旋律轨道');
      mk.addEventListener('click', () => this.cb.onCreateTrack(this.style));
      editor.append(el('div', { style: 'text-align:center;padding-bottom:20px' }, mk));
      layout.append(list, editor);
      this.root.replaceChildren(layout);
      return;
    }

    const prog = PROGRESSIONS[this.progIndex];

    // ---- 风格 ----
    const styleSeg = segmented<ArrangementStyle>(
      STYLE_ORDER.map((s) => ({ value: s, label: STYLE_INFO[s].label, title: STYLE_INFO[s].desc })),
      this.style,
      (v) => {
        this.style = v;
        this.render(project, selectedTrackId);
      },
    );

    const styleGroup = el('div', { class: 'harm-group' });
    styleGroup.append(
      el('div', { class: 'harm-group-title' }, '编配方式'),
      styleSeg,
      el('div', { class: 'harm-desc' }, STYLE_INFO[this.style].desc),
    );

    // ---- 目标轨道 ----
    const trackSelect = dropdown('写到哪条轨道', melodic.map((t) => ({
      value: t.id, label: t.name,
    })), this.targetId ?? '', (v) => {
      this.targetId = v;
      this.render(project, selectedTrackId);
    });

    // ---- 小节数 / 音区 ----
    const paramsGroup = el('div', { class: 'harm-group' });
    paramsGroup.append(
      el('div', { class: 'harm-group-title' }, '参数'),
      dropdown('生成小节数', [1, 2, 4, 8].map((n) => ({
        value: String(n), label: `${n} 小节`,
      })), String(this.bars), (v) => { this.bars = parseInt(v, 10); this.updatePreview(project); }),
      slider({
        label: '音区（根音）',
        min: 28, max: 72, step: 1,
        value: this.octave,
        onInput: (v) => { this.octave = v; this.updatePreview(project); },
        resetValue: suggestedOctave(this.style, target?.instrument),
      }),
      trackSelect,
    );

    // ---- 和弦预览表 ----
    const preview = el('div', { class: 'harm-preview' });
    paramsGroup.append(preview);

    // ---- 操作 ----
    const genBtn = el('button', { class: 'btn btn-primary', type: 'button', style: 'flex:1' }, '生成到这条轨道');
    genBtn.addEventListener('click', () => this.doGenerate(project));

    const playBtn = el('button', { class: 'btn', type: 'button' }, '试听');
    playBtn.addEventListener('click', () => this.doPreview(project));

    const clearBtn = el('button', { class: 'btn btn-ghost', type: 'button', title: '删除这条轨道上的全部音符' }, '清空该轨');
    clearBtn.addEventListener('click', () => {
      const id = this.targetId;
      if (!id) return;
      this.cb.onGenerate(id, []);
      this.render(project, selectedTrackId);
    });

    const actions = el('div', { class: 'harm-actions' }, playBtn, genBtn, clearBtn);
    paramsGroup.append(actions);

    const noteCount = this.previewNotes(project).length;
    paramsGroup.append(el('div', { class: 'harm-note' },
      `将写入 ${noteCount} 个音符，覆盖这条轨道原有内容。可用 Ctrl+Z 撤销。`));

    editor.append(styleGroup, paramsGroup);
    layout.append(list, editor);
    this.root.replaceChildren(layout);
    this.updatePreview(project);
  }

  /** 实际可生成的小节数：不能超过工程总长度 */
  private barCount(project: Project): number {
    const total = Math.max(1, Math.round(project.totalSteps / (project.gridSteps * 4)));
    return Math.min(this.bars, total);
  }

  /** 依据当前设置计算音符（不写入 store） */
  private previewNotes(project: Project) {
    if (!this.targetId) return [];
    return generateNotes(
      this.targetId,
      PROGRESSIONS[this.progIndex],
      this.style,
      this.barCount(project),
      project.gridSteps,
      this.octave,
      makeCounter(),
    );
  }

  /** 重绘和弦预览表（滑块拖动时只更新这一块，避免整页重建） */
  private updatePreview(project: Project) {
    const host = this.root.querySelector<HTMLElement>('.harm-preview');
    if (!host) return;
    const prog = PROGRESSIONS[this.progIndex];
    const bars = this.barCount(project);

    host.replaceChildren();
    for (let bar = 0; bar < bars; bar++) {
      const c = prog.chords[bar % prog.chords.length];
      const row = el('div', { class: 'harm-pv-row' });
      row.append(el('span', { class: 'harm-pv-bar' }, `${bar + 1}`));
      row.append(el('span', { class: 'harm-pv-name' }, c.name));
      const notes = el('span', { class: 'harm-pv-keys' });
      for (const key of chordKeys(c, this.octave)) {
        notes.append(el('span', { class: 'harm-pv-key' }, keyToName(key)));
      }
      row.append(notes);
      host.append(row);
    }
  }

  private doGenerate(project: Project) {
    if (!this.targetId) return;
    const notes = this.previewNotes(project);
    this.cb.onGenerate(this.targetId, notes);
    this.render(project, this.targetId);
  }

  /** 试听：逐个和弦按下再抬起，让用户听出进行 */
  private doPreview(project: Project) {
    if (!this.targetId) return;
    const prog = PROGRESSIONS[this.progIndex];
    const beats = 60 / project.bpm * 1000;
    prog.chords.forEach((c, i) => {
      setTimeout(() => {
        this.cb.onPreviewChord(this.targetId!, chordKeys(c, this.octave), beats * 0.9);
      }, i * beats);
    });
  }
}

/** 简单的 id 生成器，避免依赖 store 造成循环引用 */
let seq = 0;
function makeCounter(): () => string {
  seq += 1;
  const tag = seq;
  return () => `harm-${tag}-${Math.random().toString(36).slice(2, 7)}`;
}