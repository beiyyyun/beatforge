/**
 * 混音台（Mixer）
 * ============================================
 * FL 的核心概念之一：每条轨道一个通道条，推子 + 声像 + 发送量。
 */

import { el, clamp } from './dom';
import type { Project } from '../core/types';

export interface MixerCallbacks {
  onVolume: (trackId: string, v: number) => void;
  onPan: (trackId: string, v: number) => void;
  onMute: (trackId: string) => void;
  onSolo: (trackId: string) => void;
  onMasterVolume: (v: number) => void;
  onBeginEdit: () => void;
}

export class Mixer {
  readonly root: HTMLElement;
  private masterFill: HTMLElement | null = null;
  private masterValue: HTMLElement | null = null;
  private trackFills = new Map<string, HTMLElement>();
  /**
   * 监听器生命周期控制器。renderStrip/renderMaster 往 window 挂监听器，
   * 每次 render 都挂新的、从不移除 —— 监听器随渲染次数线性累积。
   * 用 AbortController 一次性撤销旧监听器，再挂新的。
   */
  private listenerCtl: AbortController | null = null;
  private sig: AddEventListenerOptions | undefined;

  constructor(private cb: MixerCallbacks) {
    this.root = el('div', { class: 'mixer' });
  }

  render(project: Project) {
    // 先撤销旧监听器，再挂新的 —— 不撤销的话 window 上的
    // pointermove/pointerup 监听器会随渲染次数线性累积。
    this.listenerCtl?.abort();
    const ctl = new AbortController();
    this.listenerCtl = ctl;
    this.sig = { signal: ctl.signal };

    this.trackFills.clear();
    const frag = document.createDocumentFragment();

    for (const track of project.tracks) {
      frag.append(this.renderStrip(track));
    }
    frag.append(this.renderMaster(project));
    this.root.replaceChildren(frag);
  }

  private renderStrip(track: Project['tracks'][number]): HTMLElement {
    const strip = el('div', { class: 'strip' });

    const dot = el('span', { class: 'channel-dot' });
    dot.style.background = track.color;

    const nameRow = el('div', { style: 'display:flex;align-items:center;justify-content:center;gap:5px' });
    nameRow.append(dot, el('div', { class: 'strip-name', title: track.name }, track.name));

    // 电平表（由播放引擎驱动，这里做静态占位）
    const meter = el('div', { class: 'strip-meter' });
    const fill = el('div', { class: 'strip-meter-fill' });
    fill.style.width = '0%';
    fill.style.background = track.color;
    meter.append(fill);
    this.trackFills.set(track.id, fill);

    // 推子
    const faderWrap = el('div', { class: 'strip-fader' });
    const trackEl = el('div', { class: 'fader-track' });
    const faderFill = el('div', { class: 'fader-fill' });
    const cap = el('div', { class: 'fader-cap' });

    const maxVol = 1.5;
    const ratio = clamp(track.volume / maxVol, 0, 1);
    faderFill.style.height = `${ratio * 100}%`;
    cap.style.bottom = `calc(${ratio * 100}% - 5.5px)`;

    // 拖动推子
    let dragging = false;
    const applyFromEvent = (clientY: number) => {
      const rect = trackEl.getBoundingClientRect();
      const r = clamp(1 - (clientY - rect.top) / rect.height, 0, 1);
      const v = r * maxVol;
      faderFill.style.height = `${r * 100}%`;
      cap.style.bottom = `calc(${r * 100}% - 5.5px)`;
      value.textContent = `${Math.round(v * 100)}`;
      this.cb.onVolume(track.id, v);
    };

    cap.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      this.cb.onBeginEdit();
      cap.setPointerCapture(e.pointerId);
    });
    cap.addEventListener('pointermove', (e) => {
      if (dragging) applyFromEvent(e.clientY);
    });
    cap.addEventListener('pointerup', (e) => {
      dragging = false;
      cap.releasePointerCapture(e.pointerId);
    });

    trackEl.append(faderFill, cap);
    faderWrap.append(trackEl);

    // 点击轨道跳转
    trackEl.addEventListener('pointerdown', (e) => {
      if (e.target === cap) return;
      this.cb.onBeginEdit();
      applyFromEvent(e.clientY);
      dragging = true;
    });
    trackEl.addEventListener('pointermove', (e) => { if (dragging) applyFromEvent(e.clientY); });
    window.addEventListener('pointerup', () => { dragging = false; }, this.sig);

    const value = el('div', { class: 'strip-value' }, String(Math.round(track.volume * 100)));

    // 声像
    const panCtl = el('div', { class: 'pan-ctl' });
    panCtl.append(el('div', { class: 'strip-value' },
      Math.abs(track.pan) < 0.02 ? '中间' : (track.pan < 0 ? `左 ${Math.round(-track.pan * 100)}` : `右 ${Math.round(track.pan * 100)}`)));
    const panRange = el('input', {
      type: 'range', class: 'mini-range',
      min: '-1', max: '1', step: '0.01', value: String(track.pan),
    }) as HTMLInputElement;
    panRange.addEventListener('input', () => this.cb.onPan(track.id, parseFloat(panRange.value)));
    panRange.addEventListener('pointerdown', () => this.cb.onBeginEdit());
    panCtl.append(panRange);

    // 静音独奏
    const btns = el('div', { style: 'display:flex;gap:4px;justify-content:center' });
    const m = el('button', {
      class: `chip chip-mute${track.muted ? ' is-on' : ''}`, type: 'button', title: '静音',
    }, 'M');
    m.addEventListener('click', () => this.cb.onMute(track.id));
    const s = el('button', {
      class: `chip chip-solo${track.solo ? ' is-on' : ''}`, type: 'button', title: '独奏',
    }, 'S');
    s.addEventListener('click', () => this.cb.onSolo(track.id));
    btns.append(m, s);

    strip.append(nameRow, meter, faderWrap, value, panCtl, btns);
    return strip;
  }

  private renderMaster(project: Project): HTMLElement {
    const strip = el('div', { class: 'strip is-master' });
    strip.append(el('div', { class: 'strip-name' }, '主输出'));

    const meter = el('div', { class: 'strip-meter' });
    const fill = el('div', { class: 'strip-meter-fill' });
    fill.style.width = '0%';
    meter.append(fill);
    this.masterFill = fill;

    const faderWrap = el('div', { class: 'strip-fader' });
    const trackEl = el('div', { class: 'fader-track' });
    const faderFill = el('div', { class: 'fader-fill' });
    const cap = el('div', { class: 'fader-cap' });

    const maxVol = 1.2;
    const ratio = clamp(project.masterVolume / maxVol, 0, 1);
    faderFill.style.height = `${ratio * 100}%`;
    cap.style.bottom = `calc(${ratio * 100}% - 5.5px)`;

    const value = el('div', { class: 'strip-value' }, String(Math.round(project.masterVolume * 100)));
    this.masterValue = value;

    let dragging = false;
    const apply = (clientY: number) => {
      const rect = trackEl.getBoundingClientRect();
      const r = clamp(1 - (clientY - rect.top) / rect.height, 0, 1);
      const v = r * maxVol;
      faderFill.style.height = `${r * 100}%`;
      cap.style.bottom = `calc(${r * 100}% - 5.5px)`;
      value.textContent = String(Math.round(v * 100));
      this.cb.onMasterVolume(v);
    };

    cap.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dragging = true;
      this.cb.onBeginEdit();
    });
    window.addEventListener('pointermove', (e) => { if (dragging) apply(e.clientY); }, this.sig);
    window.addEventListener('pointerup', () => { dragging = false; }, this.sig);

    trackEl.addEventListener('pointerdown', (e) => {
      if (e.target !== cap) { this.cb.onBeginEdit(); apply(e.clientY); dragging = true; }
    });

    trackEl.append(faderFill, cap);
    faderWrap.append(trackEl);
    strip.append(meter, faderWrap, value);

    // 重置
    const reset = el('button', { class: 'btn btn-sm', type: 'button' }, '重置');
    reset.addEventListener('click', () => {
      this.cb.onBeginEdit();
      this.cb.onMasterVolume(0.8);
    });
    strip.append(reset);

    return strip;
  }

  /** 由主程序调用，更新电平表 */
  updateLevels(trackId: string, level: number) {
    const fill = this.trackFills.get(trackId);
    if (fill) fill.style.width = `${Math.min(100, level * 100)}%`;
  }

  updateMasterLevel(level: number) {
    if (this.masterFill) {
      this.masterFill.style.width = `${Math.min(100, level * 100)}%`;
      this.masterFill.style.background = level > 0.92 ? 'var(--red)' : 'var(--green)';
    }
  }
}