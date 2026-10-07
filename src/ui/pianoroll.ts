/**
 * 钢琴卷帘（Piano Roll）
 * ============================================
 * FL 的第二个标志性界面。横轴时间，纵轴音高。
 * 操作：拖空白画音符、拖音符移动、拖右边缘改长度、双击删除。
 */

import { el, segmented } from './dom';
import type { Project } from '../core/types';
import { keyToName } from '../core/constants';

export interface PianoRollCallbacks {
  /** 创建新音符，返回生成的 id 供后续拖动修改 */
  onAdd: (trackId: string, key: number, start: number, length: number, velocity: number) => string;
  onMove: (noteId: string, key: number, start: number, length: number) => void;
  onDelete: (noteId: string) => void;
  onBeginEdit: () => void;
  onPreviewKey: (trackId: string, key: number, isDown: boolean) => void;
}

type DragMode = 'create' | 'move' | 'resize';

export class PianoRoll {
  readonly root: HTMLElement;
  private trackId: string | null = null;
  private cellWidth = 24;
  private rowHeight = 15;
  private lowKey = 24;
  private highKey = 84;

  /** 拖拽会话状态 */
  private drag: {
    mode: DragMode;
    noteId: string | null;
    startX: number;
    startY: number;
    originKey: number;
    originStart: number;
    originLength: number;
    velocity: number;
  } | null = null;

  private activePreviewKeys = new Set<number>();

  constructor(private cb: PianoRollCallbacks) {
    this.root = el('div', { class: 'pianoroll' });
  }

  setTrack(id: string | null) {
    if (this.trackId !== id) {
      this.trackId = id;
      this.autoScrollToNotes();
    }
  }

  get activeTrackId() { return this.trackId; }

  /** 重新渲染 */
  render(project: Project) {
    const track = project.tracks.find((t) => t.id === this.trackId);

    if (!track || track.kind === 'drum') {
      this.root.replaceChildren(
        el('div', { class: 'browser-empty' },
          track ? '鼓通道请使用「步进」标签页。' : '先从左侧选择一条乐器通道。'),
      );
      return;
    }

    const total = project.totalSteps;
    const rows = this.highKey - this.lowKey + 1;
    const gridWidth = total * this.cellWidth;
    const gridHeight = rows * this.rowHeight;

    // ---- 工具栏 ----
    const toolbar = el('div', { class: 'pr-toolbar' });
    const dot = el('span', { class: 'step-label-dot' });
    dot.style.background = track.color;
    toolbar.append(
      el('div', { class: 'stepper-title' }, dot, track.name),
      segmented(
        [
          { value: '24', label: '低' },
          { value: '48', label: '中' },
          { value: '72', label: '高' },
        ],
        String(this.lowKey < 40 ? '24' : this.lowKey < 60 ? '48' : '72'),
        (v) => {
          this.lowKey = parseInt(v, 10);
          this.highKey = this.lowKey + 60;
          this.render(project);
        },
      ),
      segmented(
        [
          { value: '16', label: '紧凑' },
          { value: '24', label: '标准' },
          { value: '34', label: '宽松' },
        ],
        String(this.cellWidth),
        (v) => {
          this.cellWidth = parseInt(v, 10);
          this.render(project);
        },
      ),
      el('span', { class: 'pr-hint' },
        '拖动空白画音符 · 拖右端改长度 · 双击删除 · 顶排琴键可试听'),
    );

    // ---- 键盘列 ----
    const keys = el('div', { class: 'pr-keys', style: `height:${gridHeight}px` });
    // 从高到低绘制（视觉上高音在上）
    for (let k = this.highKey; k >= this.lowKey; k--) {
      const isBlack = [1, 3, 6, 8, 10].includes(((k % 12) + 12) % 12);
      const keyEl = el('div', {
        class: `pr-key${isBlack ? ' is-black' : ''}`,
        'data-key': String(k),
        style: `height:${this.rowHeight}px`,
      }, isBlack ? '' : keyToName(k));

      keyEl.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.cb.onPreviewKey(track.id, k, true);
        keyEl.classList.add('is-active');
      });
      const release = () => {
        this.cb.onPreviewKey(track.id, k, false);
        keyEl.classList.remove('is-active');
      };
      keyEl.addEventListener('pointerup', release);
      keyEl.addEventListener('pointerleave', release);

      keys.append(keyEl);
    }

    // ---- 网格 ----
    const grid = el('div', {
      class: 'pr-grid',
      style: `width:${gridWidth}px;height:${gridHeight}px`,
    });

    // 行背景（黑键行加深）
    for (let k = this.highKey; k >= this.lowKey; k--) {
      const rowIndex = this.highKey - k;
      const isBlack = [1, 3, 6, 8, 10].includes(((k % 12) + 12) % 12);
      const y = rowIndex * this.rowHeight;
      const isBeatLine = k % 12 === 0; // C 线加强

      const rowEl = el('div', {
        class: `pr-row${isBlack ? ' is-black' : ''}${isBeatLine ? ' is-beat' : ''}`,
        style: `position:absolute;left:0;top:${y}px;width:${gridWidth}px`,
      });
      grid.append(rowEl);
    }

    // 竖线（拍线与小节线）
    const overlay = el('div', {
      style: `position:absolute;inset:0;pointer-events:none`,
    });
    const stepsPerBeat = project.gridSteps;
    for (let s = 0; s <= total; s++) {
      const x = s * this.cellWidth;
      const isBeat = s % stepsPerBeat === 0;
      const isBar = s % (stepsPerBeat * 4) === 0;
      overlay.append(el('div', {
        style: `position:absolute;left:${x}px;top:0;bottom:0;width:1px;` +
          `background:${isBar ? 'var(--line-strong)' : isBeat ? 'rgba(58,66,78,0.5)' : 'rgba(44,51,61,0.28)'}`,
      }));
    }
    grid.append(overlay);

    // ---- 音符 ----
    const notes = project.notes.filter((n) => n.trackId === track.id);
    for (const note of notes) {
      const rowIndex = this.highKey - note.key;
      const y = rowIndex * this.rowHeight;
      const x = note.start * this.cellWidth;
      const w = Math.max(4, note.length * this.cellWidth - 1);

      const noteEl = el('div', {
        class: 'pr-note',
        'data-note': note.id,
        style: `left:${x}px;top:${y}px;width:${w}px;height:${this.rowHeight - 1}px;` +
          `background:${track.color};opacity:${0.45 + note.velocity * 0.55}`,
        title: `${keyToName(note.key)} · 力度 ${Math.round(note.velocity * 100)}%`,
      });
      noteEl.append(el('div', { class: 'pr-note-handle', 'data-resize': note.id }));

      grid.append(noteEl);
    }

    // ---- 组装 ----
    const body = el('div', { class: 'pr-body' }, keys, grid);
    this.root.replaceChildren(toolbar, body);

    this.bindInteraction(project, track.id, grid);
  }

  /** 绑定鼠标交互 */
  private bindInteraction(project: Project, trackId: string, grid: HTMLElement) {
    const stepAt = (clientX: number): number => {
      const rect = grid.getBoundingClientRect();
      return Math.floor((clientX - rect.left) / this.cellWidth);
    };
    const keyAt = (clientY: number): number => {
      const rect = grid.getBoundingClientRect();
      const rowIndex = Math.floor((clientY - rect.top) / this.rowHeight);
      return this.highKey - rowIndex;
    };

    // ---- 拖动音符 ----
    grid.addEventListener('pointerdown', (e) => {
      const target = e.target as HTMLElement;
      const noteEl = target.closest('.pr-note') as HTMLElement | null;

      this.cb.onBeginEdit();

      if (noteEl) {
        const noteId = noteEl.dataset.note!;
        const isResize = !!target.closest('[data-resize]');
        const note = project.notes.find((n) => n.id === noteId);
        if (!note) return;

        this.drag = {
          mode: isResize ? 'resize' : 'move',
          noteId,
          startX: e.clientX,
          startY: e.clientY,
          originKey: note.key,
          originStart: note.start,
          originLength: note.length,
          velocity: note.velocity,
        };
        noteEl.classList.add('is-dragging');
      } else {
        // 创建新音符：只建一次，后续拖动改为修改它
        const step = stepAt(e.clientX);
        const key = keyAt(e.clientY);
        if (key < 0 || key > 127) return;
        const clampedStep = Math.max(0, Math.min(project.totalSteps - 1, step));
        const newId = this.cb.onAdd(trackId, key, clampedStep, 1, 0.8);
        this.drag = {
          mode: 'create',
          noteId: newId,
          startX: e.clientX,
          startY: e.clientY,
          originKey: key,
          originStart: clampedStep,
          originLength: 1,
          velocity: 0.8,
        };
      }
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    });

    grid.addEventListener('pointermove', (e) => {
      if (!this.drag) return;

      if (this.drag.mode === 'create' && this.drag.noteId) {
        const step = stepAt(e.clientX);
        const key = keyAt(e.clientY);
        const length = Math.max(
          1,
          Math.min(project.totalSteps - this.drag.originStart, step - this.drag.originStart + 1),
        );
        const clampedKey = Math.max(0, Math.min(127, key));
        if (clampedKey !== this.drag.originKey || length !== this.drag.originLength) {
          this.drag.originKey = clampedKey;
          this.drag.originLength = length;
          // 修改同一个音符，而非重复创建
          this.cb.onMove(this.drag.noteId, clampedKey, this.drag.originStart, length);
        }
      } else if (this.drag.mode === 'move' && this.drag.noteId) {
        const dStep = Math.round((e.clientX - this.drag.startX) / this.cellWidth);
        const dKey = -Math.round((e.clientY - this.drag.startY) / this.rowHeight);
        const newStart = Math.max(0, Math.min(project.totalSteps - this.drag.originLength, this.drag.originStart + dStep));
        const newKey = Math.max(0, Math.min(127, this.drag.originKey + dKey));
        this.cb.onMove(this.drag.noteId, newKey, newStart, this.drag.originLength);
      } else if (this.drag.mode === 'resize' && this.drag.noteId) {
        const step = stepAt(e.clientX);
        const length = Math.max(1, Math.min(project.totalSteps - this.drag.originStart, step - this.drag.originStart));
        this.cb.onMove(this.drag.noteId, this.drag.originKey, this.drag.originStart, length);
      }
    });

    const endDrag = () => { this.drag = null; };
    grid.addEventListener('pointerup', endDrag);
    grid.addEventListener('pointercancel', endDrag);

    // ---- 双击删除 ----
    grid.addEventListener('dblclick', (e) => {
      const noteEl = (e.target as HTMLElement).closest('.pr-note') as HTMLElement | null;
      if (noteEl?.dataset.note) {
        this.cb.onBeginEdit();
        this.cb.onDelete(noteEl.dataset.note);
      }
    });
  }

  /** 滚到有音符的位置 */
  private autoScrollToNotes() {
    // 需要 project 数据，延迟到下次渲染后执行
  }
}