/**
 * 效果器面板
 * ============================================
 * FL 的 Track FX 概念：每条轨道挂一个效果器链（EQ → 失真 → 干湿）。
 * 鼓轨不挂效果器（保持干净），旋律轨默认启用。
 */

import { el, slider, checkbox } from './dom';
import type { Project, InsertParams } from '../core/types';

export interface FXCallbacks {
  onParam: (trackId: string, path: string[], value: unknown) => void;
  onCommit: () => void;
  onEnable: (trackId: string, enabled: boolean) => void;
  onSelect: (trackId: string) => void;
}

export class FXPanel {
  readonly root: HTMLElement;
  private activeId: string | null = null;

  constructor(private cb: FXCallbacks) {
    this.root = el('div', { class: 'panel' });
  }

  render(project: Project, preferId: string | null) {
    this.activeId = preferId;

    const layout = el('div', { class: 'fx-layout' });

    // ---- 左侧：轨道列表 ----
    const list = el('div', { class: 'fx-list' });
    list.append(el('div', { class: 'browser-section' }, '选择轨道'));

    for (const track of project.tracks) {
      const isActive = track.id === this.activeId;
      const enabled = track.insert?.enabled ?? false;
      const item = el('div', {
        class: `fx-track-item${isActive ? ' is-active' : ''}${enabled ? '' : ' is-disabled'}`,
      });
      const dot = el('span', { class: 'channel-dot' });
      dot.style.background = track.color;
      item.append(dot, el('span', {}, track.name));

      if (track.kind === 'drum') {
        item.append(el('span', {
          style: 'margin-left:auto;font-size:10px;color:var(--text-mute)',
        }, '鼓轨不适用'));
      } else {
        const toggle = el('span', {
          class: `chip${enabled ? ' is-on' : ''}`,
          title: enabled ? '关闭效果器' : '开启效果器',
          style: 'margin-left:auto;width:20px;height:20px',
        }, enabled ? '开' : '关');
        toggle.addEventListener('click', (e) => {
          e.stopPropagation();
          this.cb.onEnable(track.id, !enabled);
        });
        item.append(toggle);
      }

      item.addEventListener('click', () => this.cb.onSelect(track.id));
      list.append(item);
    }

    // ---- 右侧：参数 ----
    const editor = el('div', { class: 'fx-editor' });
    const track = project.tracks.find((t) => t.id === this.activeId);

    if (!track) {
      editor.append(el('div', { class: 'fx-empty' }, '从左侧选择一条轨道'));
    } else if (track.kind === 'drum') {
      editor.append(
        el('div', { class: 'fx-empty' },
          '鼓轨不挂效果器。', el('br'),
          '如果想让鼓更亮或更闷，可以在「音色」页调整各个鼓件的音高与噪声。'),
      );
    } else if (!track.insert) {
      editor.append(
        el('div', { class: 'fx-empty' }, '这条轨道还没有效果器，点击左侧开关启用。'),
      );
    } else {
      editor.append(this.buildEditor(track.id, track.name, track.insert));
    }

    layout.append(list, editor);
    this.root.replaceChildren(layout);
  }

  private buildEditor(trackId: string, trackName: string, insert: InsertParams): HTMLElement {
    const wrap = el('div', {});
    const set = (path: string[], v: unknown) => this.cb.onParam(trackId, path, v);

    const head = el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:16px' });
    head.append(
      el('div', { style: 'font-size:14px;font-weight:500' }, trackName),
      checkbox('启用效果器', insert.enabled, (v) => this.cb.onEnable(trackId, v)),
    );
    wrap.append(head);

    // ---- 均衡器 ----
    const eqGroup = el('div', { class: 'fx-group' });
    eqGroup.append(el('div', { class: 'fx-group-title' }, '均衡器 · EQ'));
    const eqGrid = el('div', { class: 'fx-grid' });
    eqGrid.append(
      slider({ label: '低频增益 (180Hz)', min: -12, max: 12, step: 0.1, value: insert.lowGain, unit: 'dB', resetValue: 0, onInput: (v) => set(['lowGain'], v) }),
      slider({ label: '中频增益', min: -12, max: 12, step: 0.1, value: insert.midGain, unit: 'dB', resetValue: 0, onInput: (v) => set(['midGain'], v) }),
      slider({ label: '中频中心频率', min: 200, max: 6000, step: 10, value: insert.midFreq, unit: 'Hz', resetValue: 1000, onInput: (v) => set(['midFreq'], v) }),
      slider({ label: '高频增益 (5.2kHz)', min: -12, max: 12, step: 0.1, value: insert.highGain, unit: 'dB', resetValue: 0, onInput: (v) => set(['highGain'], v) }),
    );
    eqGroup.append(eqGrid);

    // ---- 失真 ----
    const distGroup = el('div', { class: 'fx-group' });
    distGroup.append(el('div', { class: 'fx-group-title' }, '失真 · Distortion'));
    const distGrid = el('div', { class: 'fx-grid' });
    distGrid.append(
      slider({ label: '驱动量 (Drive)', min: 0, max: 1, step: 0.01, value: insert.drive, unit: '%', resetValue: 0, onInput: (v) => set(['drive'], v) }),
      slider({ label: '音色亮度 (Tone)', min: 0, max: 1, step: 0.01, value: insert.tone, unit: '%', onInput: (v) => set(['tone'], v) }),
    );
    distGroup.append(distGrid);

    // ---- 干湿 ----
    const mixGroup = el('div', { class: 'fx-group' });
    mixGroup.append(el('div', { class: 'fx-group-title' }, '干湿混合'));
    const mixGrid = el('div', { class: 'fx-grid' });
    mixGrid.append(
      slider({
        label: '效果量 (Mix)', min: 0, max: 1, step: 0.01,
        value: insert.mix, unit: '%', onInput: (v) => set(['mix'], v),
      }),
    );
    mixGroup.append(mixGrid);

    wrap.append(eqGroup, distGroup, mixGroup);

    // ---- 说明 ----
    wrap.append(el('div', {
      style: 'margin-top:18px;padding:11px 13px;background:var(--bg-2);border-radius:6px;font-size:11.5px;color:var(--text-mute);line-height:1.9',
    },
      '提示：混响和延迟在通道条上调节（发送量）。这里负责 EQ 与失真，'
      + '两者配合是让声音"变脏变厚"最快的办法。'));

    return wrap;
  }
}