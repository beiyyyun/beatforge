/**
 * 叠加层编辑器
 * ============================================
 * 让一条轨道同时挂多个乐器，共享同一份音符。
 *
 * 面向新生的设计取舍：
 *  - 层数上限 4。超过 4 层，新手已经听不出哪层在干什么，只会觉得"糊了"
 *  - 每个层只暴露 4 个参数（音量/声像/八度/静音），其余进高级设置
 *  - 默认参数（低八度、音量 0.55、稍偏左）本身就是能直接听的设置
 */

import { el, slider, dropdown, modal } from './dom';
import type { Project, Track, TrackLayer } from '../core/types';
import { PRESETS } from '../audio/presets';

export interface LayerCallbacks {
  /** 添加一层 */
  onAdd: (trackId: string, presetId: string) => void;
  /** 修改层参数 */
  onParam: (trackId: string, layerId: string, path: string[], value: unknown) => void;
  /** 删除层 */
  onRemove: (trackId: string, layerId: string) => void;
  /** 层静音切换 */
  onToggleMute: (trackId: string, layerId: string) => void;
  /** 进入层内音色编辑 */
  onEditTone: (trackId: string, layerId: string) => void;
  onCommit: () => void;
}

/**
 * 层数上限。
 * 为什么定 4：超过 4 层，新手已经听不出哪层在干什么，
 * 只会觉得"声音糊了"，而且 CPU 开销与理解成本同时上升。
 */
export const MAX_LAYERS = 4;

export class LayerEditor {
  readonly root: HTMLElement;

  constructor(private cb: LayerCallbacks) {
    this.root = el('div', { class: 'fx-group' });
  }

  render(track: Track) {
    const layers = track.layers ?? [];
    const isDrum = track.kind === 'drum';

    const wrap = el('div', {});
    wrap.append(el('div', { class: 'fx-group-title' }, `乐器叠加 · Layer${layers.length ? ` (${layers.length}/${MAX_LAYERS})` : ''}`));

    if (isDrum) {
      wrap.append(el('div', {
        style: 'padding:11px 13px;background:var(--bg-2);border-radius:6px;font-size:11.5px;color:var(--text-mute);line-height:1.9',
      },
        '鼓轨不需要叠加层。一套鼓组里已经有 8 件鼓，'
        + '想更厚可以在「音色」页把底鼓的「基音厚度」和「失真饱和」拉高。'));
      this.root.replaceChildren(wrap);
      return;
    }

    if (layers.length === 0) {
      wrap.append(el('div', {
        style: 'padding:11px 13px;background:var(--bg-2);border-radius:6px;font-size:11.5px;color:var(--text-mute);line-height:1.9;margin-bottom:12px',
      },
        '叠加层让同一个音符同时由多个乐器演奏，是把声音加厚最直接的办法。'
        + '典型用法：主音保留原样，再叠一层低八度的柔软音色，'
        + '整条轨道立刻变厚、变宽。'));
    }

    for (const layer of layers) {
      wrap.append(this.renderLayer(track.id, layer));
    }

    // ---- 添加按钮 ----
    const canAdd = layers.length < MAX_LAYERS;
    const addBtn = el('button', {
      class: 'btn', type: 'button', style: 'width:100%;margin-top:4px',
      disabled: canAdd ? undefined : 'true',
      title: canAdd ? '选一个乐器叠在这条轨道上' : `最多 ${MAX_LAYERS} 层`,
    }, canAdd ? '+ 叠加一个乐器' : `已达上限（${MAX_LAYERS} 层）`);
    if (canAdd) {
      addBtn.addEventListener('click', () => this.openPicker(track));
    }
    wrap.append(addBtn);

    if (layers.length > 0) {
      wrap.append(el('div', {
        style: 'margin-top:11px;font-size:11px;color:var(--text-mute);line-height:1.8',
      },
        '所有层共享这条轨道的音符，所以钢琴卷帘里改一次，全部层同时跟着变。'
        + '层的声音汇入轨道的效果器，因此混响、均衡对每一层都生效。'));
    }

    this.root.replaceChildren(wrap);
  }

  private renderLayer(trackId: string, layer: TrackLayer): HTMLElement {
    const card = el('div', { class: `layer-card${layer.muted ? ' is-muted' : ''}` });

    // ---- 头部：名称 + 静音 + 删除 ----
    const head = el('div', { class: 'layer-head' });
    const dot = el('span', { class: 'channel-dot' });
    dot.style.background = layerColor(layer);
    const name = el('span', { class: 'layer-name' }, layer.name);
    name.title = '双击改名';

    const editBtn = el('span', { class: 'chip', title: '编辑这一层的音色参数' }, '调音色');
    editBtn.addEventListener('click', () => this.cb.onEditTone(trackId, layer.id));

    const muteBtn = el('span', {
      class: `chip${layer.muted ? '' : ' is-on'}`,
      title: layer.muted ? '取消静音' : '静音这一层',
    }, layer.muted ? '已静音' : '开');
    muteBtn.addEventListener('click', () => this.cb.onToggleMute(trackId, layer.id));

    const delBtn = el('span', { class: 'chip', title: '删除这一层' }, '删');
    delBtn.addEventListener('click', () => {
      if (confirm(`确定删除叠加层「${layer.name}」吗？`)) {
        this.cb.onRemove(trackId, layer.id);
      }
    });

    head.append(dot, name, el('span', { style: 'margin-left:auto;display:flex;gap:5px' },
      editBtn, muteBtn, delBtn));

    // ---- 参数 ----
    const grid = el('div', { class: 'fx-grid' });
    const set = (path: string[], v: unknown) => this.cb.onParam(trackId, layer.id, path, v);

    grid.append(
      slider({
        label: '层音量', min: 0, max: 1.2, step: 0.01,
        value: layer.volume, unit: '%',
        onInput: (v) => set(['volume'], v),
        resetValue: 0.55,
      }),
      slider({
        label: '层声像', min: -1, max: 1, step: 0.01,
        value: layer.pan,
        onInput: (v) => set(['pan'], v),
        resetValue: -0.25,
      }),
      dropdown('八度偏移', [
        { value: '-2', label: '低两八度' },
        { value: '-1', label: '低八度' },
        { value: '0', label: '同度' },
        { value: '1', label: '高八度' },
        { value: '2', label: '高两八度' },
      ], String(layer.octave), (v) => set(['octave'], parseInt(v, 10))),
      slider({
        label: '半音偏移', min: -12, max: 12, step: 1,
        value: layer.semitone, unit: 'st',
        onInput: (v) => set(['semitone'], v),
        resetValue: 0,
      }),
    );

    card.append(head, grid);
    return card;
  }

  /** 选一个乐器作为新层 */
  private openPicker(track: Track) {
    const melodic = PRESETS.filter((p) => p.trackKind === 'melodic');
    const list = el('div', { class: 'layer-picker' });

    for (const cat of [...new Set(melodic.map((p) => p.category))]) {
      list.append(el('div', { class: 'browser-section' }, `${cat} · 适合叠加`));
      for (const preset of melodic.filter((p) => p.category === cat)) {
        const item = el('div', { class: 'layer-pick-item', title: '点击添加为叠加层' });

        const icon = el('div', { class: 'preset-icon' });
        icon.style.background = layerColor({ instrument: preset.instrument });
        icon.textContent = instrumentTag(preset.instrument);

        item.append(
          icon,
          el('div', { class: 'preset-info' },
            el('div', { class: 'preset-name' }, preset.name),
            el('div', { class: 'preset-meta' }, suggestText(preset.category))),
        );
        item.addEventListener('click', () => {
          close();
          this.cb.onAdd(track.id, preset.id);
        });
        list.append(item);
      }
    }

    const close = modal(`为「${track.name}」选一个叠加乐器`, list, [
      { label: '取消', onClick: (c) => c() },
    ]);
  }
}

/**
 * 层的配色与图标。
 * 从注册表读取，新增乐器不用改这里 —— 以前写的是
 * `instrument === 'fm' ? 青 : 紫`，结果所有民乐都被画成紫色的 "SY"。
 */
const FALLBACK_COLOR = '#a78bfa';
const INSTRUMENT_COLORS: Record<string, string> = {
  poly: '#a78bfa',
  fm: '#22d3ee',
  pluck: '#f59e0b',
  bow: '#f472b6',
  wind: '#4ade80',
  yangle: '#fbbf24',
  drum: '#fb7185',
};
const INSTRUMENT_TAGS: Record<string, string> = {
  poly: 'SY', fm: 'FM', drum: 'DR',
  pluck: '拨', bow: '拉', wind: '吹', yangle: '击',
};

/** 层的配色，跟主轨道区分开 */
export function layerColor(layer: { instrument: string }): string {
  return INSTRUMENT_COLORS[layer.instrument] ?? FALLBACK_COLOR;
}

/** 音色图标上的两字缩写 */
export function instrumentTag(instrument: string): string {
  return INSTRUMENT_TAGS[instrument] ?? 'SY';
}

/** 按乐器类别给一句"叠什么"建议，避免用户盲选 */
function suggestText(category: string): string {
  switch (category) {
    case '贝斯': return '叠低八度最有效，能补足低频';
    case '氛围': return '叠长音铺底，延音拉到最长';
    case '主音': return '注意层音量别超过主层，否则会糊';
    case '键盘': return '低八度叠键盘，声音立刻变厚';
    case '拨弦': return '层音量压到 0.4 以下，否则余音叠加会糊';
    case '拉弦': return '二胡类适合叠在主音下方加厚度';
    case '吹管': return '笛箫适合高八度叠，唢呐建议单独成轨';
    case '击弦': return '扬琴层音量不宜大，轮音叠多了很吵';
    default: return '点开试听再决定';
  }
}