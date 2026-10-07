/**
 * 通道机架（Channel Rack）
 * ============================================
 * FL 的标志性布局：纵向排列的通道条，每条对应一个乐器。
 * 这里是 FL 的核心设计，用户一眼就能理解"轨道"这个概念。
 */

import { el, slider, clamp } from './dom';
import type { Project, Track } from '../core/types';
import { getPresetById } from '../audio/presets';

export interface RackCallbacks {
  onSelect: (trackId: string) => void;
  onToggleMute: (trackId: string) => void;
  onToggleSolo: (trackId: string) => void;
  onVolume: (trackId: string, value: number) => void;
  onPan: (trackId: string, value: number) => void;
  onSendReverb: (trackId: string, value: number) => void;
  onSendDelay: (trackId: string, value: number) => void;
  onRemove: (trackId: string) => void;
  onOpenStepper: (trackId: string) => void;
  onOpenPianoRoll: (trackId: string) => void;
  onPreview: (track: Track) => void;
}

export class ChannelRack {
  readonly root: HTMLElement;
  private selectedId: string | null = null;

  constructor(private cb: RackCallbacks) {
    this.root = el('div', { class: 'rack' });
  }

  get selectedTrackId() { return this.selectedId; }

  setSelected(id: string | null) {
    this.selectedId = id;
  }

  render(project: Project) {
    if (project.tracks.length === 0) {
      this.root.replaceChildren(
        el(
          'div',
          { class: 'rack-empty' },
          el(
            'div',
            { class: 'rack-empty-inner' },
            el('h3', {}, '还没有任何通道'),
            el('p', {}, '从左侧「乐器」面板挑一个音色，就能加进你的编曲。'),
          ),
        ),
      );
      return;
    }

    const frag = document.createDocumentFragment();
    for (const track of project.tracks) {
      frag.append(this.renderChannel(track, project));
    }
    this.root.replaceChildren(frag);
  }

  private renderChannel(track: Track, project: Project): HTMLElement {
    const isSelected = track.id === this.selectedId;
    const preset = getPresetById(track.presetId);

    const channel = el('div', {
      class: `channel${isSelected ? ' is-selected' : ''}${track.muted ? ' is-muted' : ''}`,
    });

    // ---- 头部 ----
    const head = el('div', { class: 'channel-head' });

    const dot = el('span', { class: 'channel-dot' });
    dot.style.background = track.color;

    const name = el('span', { class: 'channel-name' }, track.name);

    const presetTag = el(
      'span',
      { class: 'channel-preset', title: preset?.name ?? track.presetId },
      preset?.name ?? '自定义',
    );

    const actions = el('div', { class: 'channel-actions' });

    // 试听按钮：点击直接出声，方便挑音色
    const play = el('button', { class: 'chip', type: 'button', title: '试听这个音色' }, '▶');
    play.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cb.onPreview(track);
    });

    const mute = el(
      'button',
      {
        class: `chip chip-mute${track.muted ? ' is-on' : ''}`,
        type: 'button',
        title: '静音 (M)',
      },
      'M',
    );
    mute.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cb.onToggleMute(track.id);
    });

    const solo = el(
      'button',
      {
        class: `chip chip-solo${track.solo ? ' is-on' : ''}`,
        type: 'button',
        title: '独奏 (S)',
      },
      'S',
    );
    solo.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cb.onToggleSolo(track.id);
    });

    const edit = el(
      'button',
      {
        class: 'chip',
        type: 'button',
        title: track.kind === 'drum' ? '打开步进序列器' : '打开钢琴卷帘',
      },
      '⋯',
    );
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      if (track.kind === 'drum') this.cb.onOpenStepper(track.id);
      else this.cb.onOpenPianoRoll(track.id);
    });

    const del = el('button', { class: 'chip', type: 'button', title: '删除通道' }, '×');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cb.onRemove(track.id);
    });

    actions.append(play, mute, solo, edit, del);
    head.append(dot, name, presetTag, actions);

    head.addEventListener('click', () => {
      this.selectedId = track.id;
      this.cb.onSelect(track.id);
    });

    // ---- 混音条 ----
    const mix = el('div', { class: 'channel-mix' });
    mix.append(
      this.miniSlider('音量', track.volume, 0, 1.5, 0.01, (v) =>
        this.cb.onVolume(track.id, v), (v) => `${Math.round(v * 100)}`),
      this.miniSlider('声像', track.pan, -1, 1, 0.01, (v) =>
        this.cb.onPan(track.id, v), (v) => (Math.abs(v) < 0.02 ? '中' : (v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`))),
      this.miniSlider('混响', track.sendReverb, 0, 1, 0.01, (v) =>
        this.cb.onSendReverb(track.id, v), (v) => `${Math.round(v * 100)}`),
      this.miniSlider('延迟', track.sendDelay, 0, 1, 0.01, (v) =>
        this.cb.onSendDelay(track.id, v), (v) => `${Math.round(v * 100)}`),
    );

    channel.append(head, mix);

    if (track.kind === 'drum' && project.steps[track.id]) {
      channel.append(el('div', {
        style: 'padding:0 11px 9px;font-size:10.5px;color:var(--text-mute)',
      }, '鼓组 · 在「步进」标签页编排节奏'));
    }

    return channel;
  }

  private miniSlider(
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (v: number) => void,
    format: (v: number) => string,
  ): HTMLElement {
    const wrap = el('div', { class: 'mini-ctl' });
    const val = el('span', { class: 'mini-value' }, format(value));
    const input = el('input', {
      type: 'range',
      class: 'mini-range',
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(value),
    }) as HTMLInputElement;

    input.addEventListener('pointerdown', () => {
      input.dataset.dragging = '1';
    });
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      val.textContent = format(v);
      onChange(v);
    });
    input.addEventListener('pointerup', () => {
      delete input.dataset.dragging;
    });
    input.addEventListener('dblclick', () => {
      input.value = String(clamp(0, min, max));
      val.textContent = format(clamp(0, min, max));
      onChange(clamp(0, min, max));
    });

    wrap.append(el('span', { class: 'mini-label' }, label), input, val);
    return wrap;
  }
}