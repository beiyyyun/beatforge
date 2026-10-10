/**
 * 步进序列器（Step Sequencer）
 * ============================================
 * 小白的第一站。逻辑极简：点格子开/关，拖动可以连续刷。
 * 每个鼓件一行，横轴是时间，亮起来的格子 = 该时刻敲一下。
 */

import { el } from './dom';
import type { Project } from '../core/types';
import { DRUM_LABELS } from '../core/constants';

export interface StepperCallbacks {
  /** 单击切换格子。on 为 true 表示要打开 */
  onToggle: (trackId: string, part: number, step: number, on: boolean, velocity: number) => void;
  /** 提交一次撤销点（在开始拖动时调用） */
  onBeginEdit: () => void;
}

export class StepSequencer {
  readonly root: HTMLElement;
  private trackId: string | null = null;
  private painting: { part: number; value: number } | null = null;
  private lastToggled: string | null = null;
  private playheadIndex = 0;
  private cellWidth = 22;
  /**
   * 监听器生命周期控制器。bindPainting 每次 render 都会挂新监听器，
   * 不清理的话 this.root 上监听器会随渲染次数线性累积。
   * 用 AbortController 一次性撤销旧监听器，再挂新的。
   */
  private listenerCtl: AbortController | null = null;

  constructor(private cb: StepperCallbacks) {
    this.root = el('div', { class: 'stepper' });
  }

  setCellWidth(w: number) { this.cellWidth = w; }

  setTrack(id: string | null) { this.trackId = id; }

  setPlayhead(step: number) {
    this.playheadIndex = step;
    for (const cell of this.root.querySelectorAll<HTMLElement>('.step-cell')) {
      const s = parseInt(cell.dataset.step ?? '-1', 10);
      cell.classList.toggle('is-playhead', s === step);
    }
  }

  render(project: Project) {
    const track = project.tracks.find((t) => t.id === this.trackId);

    if (!track) {
      this.root.replaceChildren(
        el('div', { class: 'browser-empty' },
          '选择一条鼓通道后，这里会显示节奏编辑网格。'),
      );
      return;
    }

    const row = project.steps[track.id];
    if (!row) {
      this.root.replaceChildren(
        el('div', { class: 'browser-empty' }, '这条通道没有节奏数据。'),
      );
      return;
    }

    const layout = row.layout ?? [];
    const total = project.totalSteps;
    const stepsPerBeat = project.gridSteps;
    const barSteps = stepsPerBeat * 4;

    const wrap = el('div', {});
    const head = el('div', { class: 'stepper-head' });
    const dot = el('span', { class: 'step-label-dot' });
    dot.style.background = track.color;
    head.append(
      el('div', { class: 'stepper-title' }, dot, track.name),
      el('span', { class: 'stepper-hint' },
        '点击格子开关 · 按住拖动可连续刷 · 上下拖动改力度'),
    );

    const grid = el('div', { class: 'step-grid' });

    // ---- 时间刻度 ----
    const ruler = el('div', { class: 'step-ruler' });
    ruler.append(el('div', { class: 'step-ruler-spacer' }));
    for (let s = 0; s < total; s++) {
      const isBeat = s % stepsPerBeat === 0;
      const isBar = s % barSteps === 0;
      const cell = el('div', {
        class: `step-ruler-cell${isBeat ? ' is-beat' : ''}`,
        style: `width:${this.cellWidth}px`,
      }, isBar ? String(s / barSteps + 1) : (isBeat ? '·' : ''));
      ruler.append(cell);
    }
    grid.append(ruler);

    // ---- 各鼓件行 ----
    for (let part = 0; part < layout.length; part++) {
      const partName = layout[part];
      const rowEl = el('div', { class: 'step-row' });

      const label = el('div', { class: 'step-label' });
      const dot = el('span', { class: 'step-label-dot' });
      dot.style.background = track.color;
      label.append(dot, el('span', {}, DRUM_LABELS[partName] ?? partName));
      rowEl.append(label);

      for (let s = 0; s < total; s++) {
        const v = row.steps[part * total + s] ?? 0;
        const isOn = v > 0.001;
        const isBeat = s % stepsPerBeat === 0;
        const cell = el('div', {
          class: `step-cell${isBeat ? ' is-beat' : ''}${isOn ? ' is-on' : ''}`,
          style: `width:${this.cellWidth}px`,
          'data-part': String(part),
          'data-step': String(s),
          title: `${DRUM_LABELS[partName] ?? partName} · 第 ${Math.floor(s / barSteps) + 1} 小节`,
        });

        const bar = el('div', { class: 'cell-bar' });
        // 力度决定亮度，和高度
        bar.style.background = track.color;
        bar.style.opacity = isOn ? String(0.35 + v * 0.65) : '0';
        bar.style.transform = `scaleY(${0.4 + v * 0.6})`;
        cell.append(bar);

        rowEl.append(cell);
      }

      grid.append(rowEl);
    }

    wrap.append(head, el('div', { class: 'stepper-body' }, grid));
    this.root.replaceChildren(wrap);
    this.bindPainting(track.id);
    this.setPlayhead(this.playheadIndex);
  }

  /** 绑定绘制交互：点击切换 + 拖动刷 + 上下改力度 */
  private bindPainting(trackId: string) {
    // 先撤销旧监听器，再挂新的 —— 每次 render 调用一次本方法，
    // 不撤销的话 this.root 上的监听器会随渲染次数线性累积。
    this.listenerCtl?.abort();
    const ctl = new AbortController();
    this.listenerCtl = ctl;
    const sig = { signal: ctl.signal };

    const cells = this.root.querySelectorAll<HTMLElement>('.step-cell');

    const cellFromEvent = (e: Event): HTMLElement | null =>
      (e.target as HTMLElement)?.closest('.step-cell') as HTMLElement | null;

    const setCell = (cell: HTMLElement, e: PointerEvent) => {
      const part = parseInt(cell.dataset.part ?? '0', 10);
      const step = parseInt(cell.dataset.step ?? '0', 10);
      const key = `${part}:${step}`;

      const isOn = cell.classList.contains('is-on');
      let velocity = 1;

      // 已经开启的格子：上下拖动调力度
      if (isOn && this.painting?.value === 1) {
        const rect = cell.getBoundingClientRect();
        const ratio = 1 - (e.clientY - rect.top) / rect.height;
        velocity = Math.max(0.2, Math.min(1, Math.round(ratio * 5) / 5));
        this.cb.onToggle(trackId, part, step, true, velocity);
        this.lastToggled = key;
        return;
      }

      // 同一次拖动内不要来回翻转
      if (this.lastToggled === key && this.painting) return;
      this.lastToggled = key;

      const nextOn = !isOn;
      this.painting = { part, value: nextOn ? 1 : 0 };
      this.cb.onToggle(trackId, part, step, nextOn, nextOn ? velocity : 0);
    };

    this.root.addEventListener('pointerdown', (e) => {
      const cell = cellFromEvent(e);
      if (!cell) return;
      e.preventDefault();
      this.lastToggled = null;
      this.cb.onBeginEdit();
      setCell(cell, e as PointerEvent);
    }, sig);

    this.root.addEventListener('pointermove', (e) => {
      if (!this.painting) return;
      // 只处理当前指针下方的格子
      const target = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const cell = target?.closest('.step-cell') as HTMLElement | null;
      if (!cell) return;
      const part = parseInt(cell.dataset.part ?? '0', 10);
      const step = parseInt(cell.dataset.step ?? '0', 10);
      const key = `${part}:${step}`;
      if (this.lastToggled === key) return;
      this.lastToggled = key;
      const nextOn = this.painting.value === 1;
      this.cb.onToggle(trackId, part, step, nextOn, 1);
    }, sig);

    const endPaint = () => {
      this.painting = null;
      this.lastToggled = null;
    };
    this.root.addEventListener('pointerup', endPaint, sig);
    this.root.addEventListener('pointerleave', endPaint, sig);
    this.root.addEventListener('pointercancel', endPaint, sig);
  }
}

interface StepRowData {
  trackId: string;
}