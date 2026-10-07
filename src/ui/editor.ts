/**
 * 音色编辑器
 * ============================================
 * 每种乐器有自己的参数面板。
 * 设计原则：参数用中文名 + 术语括号，让新手看得懂也方便查资料。
 *
 * 分发方式：用注册表的 label / 类型标识决定渲染哪个面板，
 * 而不是 if-else 链。加新乐器时这里加一个 case 即可，
 * 其余逻辑（工程兼容、参数写回、试听）完全不用动。
 */

import { el, slider, dropdown, checkbox, segmented } from './dom';
import type {
  Project, Track, PolySynthParams, FMSynthParams, DrumKitParams,
} from '../core/types';
import type { PluckParams, BowParams, WindParams, YangleParams } from '../audio/folk';
import { PRESET_CATEGORIES, getPresetById } from '../audio/presets';
import { getInstrumentDef } from '../audio/registry';
import { DRUM_LABELS } from '../core/constants';
import { LayerEditor } from './layers';
import '../audio/register';

/** 参数写回函数：把 path/value 交给上层决定写到哪里 */
type Setter = (path: string[], value: unknown) => void;

export interface EditorCallbacks {
  /** 修改乐器参数 */
  onParam: (trackId: string, path: string[], value: unknown) => void;
  onCommit: () => void;
  onPreviewNote: (trackId: string, key: number, velocity: number) => void;
  onPreviewOff: (trackId: string) => void;
  /** 叠加层相关 */
  onLayerAdd: (trackId: string, presetId: string) => void;
  onLayerParam: (trackId: string, layerId: string, path: string[], value: unknown) => void;
  onLayerRemove: (trackId: string, layerId: string) => void;
  onLayerToggleMute: (trackId: string, layerId: string) => void;
}

export class InstrumentEditor {
  readonly root: HTMLElement;
  private trackId: string | null = null;
  private playingKeys = new Set<number>();
  /** 正在编辑叠加层音色时记下层 id；null 表示编辑主乐器 */
  private editingLayerId: string | null = null;
  private layerHost = el('div', {});
  private layerEditor: LayerEditor;

  constructor(private cb: EditorCallbacks) {
    this.root = el('div', { class: 'fx-editor' });
    this.layerEditor = new LayerEditor({
      onAdd: (tid, presetId) => cb.onLayerAdd(tid, presetId),
      onParam: (tid, lid, path, v) => cb.onLayerParam(tid, lid, path, v),
      onRemove: (tid, lid) => cb.onLayerRemove(tid, lid),
      onToggleMute: (tid, lid) => cb.onLayerToggleMute(tid, lid),
      onEditTone: (tid, lid) => { this.editingLayerId = lid; this.render(this.lastProject!); },
      onCommit: () => cb.onCommit(),
    });
  }

  /** 上一次 render 的工程引用，供层编辑器回调里触发重绘 */
  private lastProject: Project | null = null;

  setTrack(id: string | null) {
    if (this.trackId !== id) this.editingLayerId = null;
    this.trackId = id;
    this.playingKeys.clear();
  }

  /** 高亮正在发声的琴键 */
  setPlayingKeys(keys: Set<number>) {
    this.playingKeys = keys;
    for (const el2 of this.root.querySelectorAll<HTMLElement>('.mini-key')) {
      const k = parseInt(el2.dataset.key ?? '-1', 10);
      el2.classList.toggle('is-active', keys.has(k));
    }
  }

  render(project: Project) {
    this.lastProject = project;
    const track = project.tracks.find((t) => t.id === this.trackId);
    if (!track) {
      this.root.replaceChildren(
        el('div', { class: 'fx-empty' }, '选择一条通道来编辑它的音色参数。'),
      );
      return;
    }

    // 编辑对象：主乐器，或某个叠加层。层被删掉后自动退回主乐器。
    const layer = this.editingLayerId
      ? (track.layers ?? []).find((l) => l.id === this.editingLayerId) ?? null
      : null;
    if (this.editingLayerId && !layer) this.editingLayerId = null;

    const instrument = layer ? layer.instrument : track.instrument;
    const presetId = layer ? layer.presetId : track.presetId;
    const def = getInstrumentDef(instrument);
    // 参数写回：主乐器走 onParam，叠加层走 onLayerParam
    const set: Setter = layer
      ? (path, v) => this.cb.onLayerParam(track.id, layer.id, path, v)
      : (path, v) => this.cb.onParam(track.id, path, v);
    const params = (layer ? layer.params : track.params);

    const wrap = el('div', {});
    const head = el('div', {
      style: 'display:flex;align-items:center;gap:9px;margin-bottom:16px;flex-wrap:wrap',
    });
    const dot = el('span', { class: 'channel-dot' });
    dot.style.background = layer ? '#a78bfa' : track.color;
    head.append(dot, el('div', { style: 'font-size:15px;font-weight:500' },
      layer ? `叠加层 · ${layer.name}` : track.name));

    const preset = getPresetById(presetId);
    if (preset) {
      head.append(el('div', { class: 'channel-preset' }, `${preset.category} · ${preset.name}`));
    }
    if (layer) {
      const back = el('span', { class: 'chip is-on' }, '← 回到主乐器');
      back.addEventListener('click', () => {
        this.editingLayerId = null;
        this.render(project);
      });
      head.append(el('span', { style: 'margin-left:auto' }, back));
    }
    wrap.append(head);

    // 未知乐器类型：明确告知，而不是默默显示一个空面板
    if (!def) {
      wrap.append(el('div', {
        style: 'padding:14px 16px;background:var(--bg-2);border-radius:6px;font-size:12px;color:var(--text-mute);line-height:1.9',
      },
        `这条轨道使用的乐器类型「${instrument}」当前版本不认识，`
        + '多半是用更高版本保存的工程。它不会发声，但其余轨道不受影响。'));
      this.root.replaceChildren(wrap);
      return;
    }

    switch (instrument) {
      case 'drum':
        wrap.append(this.renderDrum(track, project));
        break;
      case 'fm':
        wrap.append(this.renderFM(track, params as FMSynthParams, set));
        break;
      case 'pluck':
        wrap.append(this.renderPluck(track, params as PluckParams, set));
        break;
      case 'yangle':
        wrap.append(this.renderYangle(track, params as YangleParams, set));
        break;
      case 'bow':
        wrap.append(this.renderBow(track, params as BowParams, set));
        break;
      case 'wind':
        wrap.append(this.renderWind(track, params as WindParams, set));
        break;
      default:
        wrap.append(this.renderPoly(track, params as PolySynthParams, set));
    }

    // 叠加层列表只在编辑主乐器时显示
    if (!layer && track.kind !== 'drum') {
      this.layerEditor.render(track);
      wrap.append(this.layerEditor.root);
    }

    this.root.replaceChildren(wrap);
  }

  /** 迷你键盘，供试听。layerId 为空表示试听整条轨道（含所有层） */
  private miniKeyboard(track: Track, startKey = 48, count = 13): HTMLElement {
    const wrap = el('div', {
      style: 'display:flex;gap:2px;margin:14px 0 4px;flex-wrap:wrap',
    });
    const blackKeys = new Set([1, 3, 6, 8, 10]);

    for (let i = 0; i < count; i++) {
      const key = startKey + i;
      const isBlack = blackKeys.has(((key % 12) + 12) % 12);
      const btn = el('button', {
        class: `mini-key${isBlack ? ' is-black' : ''}${this.playingKeys.has(key) ? ' is-active' : ''}`,
        type: 'button',
        'data-key': String(key),
        style: `padding:5px 8px;border:1px solid var(--line);border-radius:3px;cursor:pointer;font-size:10px;font-family:var(--mono);` +
          `background:${isBlack ? 'var(--bg-0)' : 'var(--bg-3)'};color:var(--text-dim)`,
      }, isBlack ? '' : keyName(key));

      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.classList.add('is-active');
        this.cb.onPreviewNote(track.id, key, 0.85);
      });
      const up = () => {
        btn.classList.remove('is-active');
        this.cb.onPreviewOff(track.id);
      };
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointerleave', up);
      wrap.append(btn);
    }
    return wrap;
  }

  /**
   * @param trackId 目标轨道
   * @param p       合成器参数（可能来自主乐器，也可能来自某个叠加层）
   * @param setter  参数写回函数。区分主乐器与层是这里唯一的复杂点，
   *                所以让调用方决定，而不是在内部猜。
   */
  private renderPoly(track: Track, p: PolySynthParams, set: Setter): HTMLElement {
    const wrap = el('div', {});

    // ---- 振荡器 ----
    const oscGroup = el('div', { class: 'fx-group' });
    oscGroup.append(el('div', { class: 'fx-group-title' }, '振荡器 · Oscillator'));
    const oscGrid = el('div', { class: 'fx-grid' });

    oscGrid.append(
      dropdown('振荡器 1 波形', waveOptions(), p.osc1.wave, (v) => set(['osc1', 'wave'], v)),
      dropdown('振荡器 2 波形', waveOptions(), p.osc2.wave, (v) => set(['osc2', 'wave'], v)),
      slider({ label: '振荡器 1 音量', min: 0, max: 1, step: 0.01, value: p.osc1.level, unit: '%', onInput: (v) => set(['osc1', 'level'], v) }),
      slider({ label: '振荡器 2 音量', min: 0, max: 1, step: 0.01, value: p.osc2.level, unit: '%', onInput: (v) => set(['osc2', 'level'], v) }),
      slider({ label: '振荡器 2 失谐', min: -50, max: 50, step: 1, value: p.osc2.detune, unit: 'cent', resetValue: 0, onInput: (v) => set(['osc2', 'detune'], v) }),
      slider({ label: '低八度支撑', min: 0, max: 1, step: 0.01, value: p.subLevel, unit: '%', resetValue: 0, onInput: (v) => set(['subLevel'], v) }),
      slider({ label: '噪声层', min: 0, max: 0.6, step: 0.01, value: p.noiseLevel, unit: '%', resetValue: 0, onInput: (v) => set(['noiseLevel'], v) }),
      slider({ label: '复音铺宽', min: 1, max: 5, step: 1, value: p.unison, resetValue: 1, onInput: (v) => set(['unison'], v) }),
      slider({ label: '最大同时发声', min: 1, max: 16, step: 1, value: p.voices, resetValue: 12, onInput: (v) => set(['voices'], v) }),
    );
    oscGroup.append(oscGrid);

    // ---- 滤波器 ----
    const fltGroup = el('div', { class: 'fx-group' });
    fltGroup.append(el('div', { class: 'fx-group-title' }, '滤波器 · Filter'));
    const fltGrid = el('div', { class: 'fx-grid' });
    fltGrid.append(
      dropdown('滤波器类型', filterOptions(), p.filter.type, (v) => set(['filter', 'type'], v)),
      slider({ label: '截止频率', min: 60, max: 16000, step: 10, value: p.filter.cutoff, unit: 'Hz', resetValue: 2400, onInput: (v) => set(['filter', 'cutoff'], v) }),
      slider({ label: '共振 (Q)', min: 0.1, max: 20, step: 0.1, value: p.filter.resonance, resetValue: 4, onInput: (v) => set(['filter', 'resonance'], v) }),
      slider({ label: '包络强度', min: -1, max: 3, step: 0.01, value: p.filter.envAmount, resetValue: 0, onInput: (v) => set(['filter', 'envAmount'], v) }),
    );
    fltGroup.append(fltGrid);

    // ---- 包络 ----
    const envGroup = el('div', { class: 'fx-group' });
    envGroup.append(el('div', { class: 'fx-group-title' }, '音量包络 · ADSR'));
    const envGrid = el('div', { class: 'fx-grid' });
    envGrid.append(
      slider({ label: '起音 A', min: 0.001, max: 2, step: 0.001, value: p.env.attack, unit: 's', onInput: (v) => set(['env', 'attack'], v) }),
      slider({ label: '衰减 D', min: 0.01, max: 3, step: 0.01, value: p.env.decay, unit: 's', onInput: (v) => set(['env', 'decay'], v) }),
      slider({ label: '延音 S', min: 0.01, max: 1, step: 0.01, value: p.env.sustain, unit: '%', onInput: (v) => set(['env', 'sustain'], v) }),
      slider({ label: '释放 R', min: 0.01, max: 4, step: 0.01, value: p.env.release, unit: 's', onInput: (v) => set(['env', 'release'], v) }),
    );
    envGroup.append(envGrid);

    const fenvGroup = el('div', { class: 'fx-group' });
    fenvGroup.append(el('div', { class: 'fx-group-title' }, '滤波器包络'));
    const fenvGrid = el('div', { class: 'fx-grid' });
    fenvGrid.append(
      slider({ label: '起音 A', min: 0.001, max: 2, step: 0.001, value: p.filterEnv.attack, unit: 's', onInput: (v) => set(['filterEnv', 'attack'], v) }),
      slider({ label: '衰减 D', min: 0.01, max: 3, step: 0.01, value: p.filterEnv.decay, unit: 's', onInput: (v) => set(['filterEnv', 'decay'], v) }),
      slider({ label: '延音 S', min: 0.01, max: 1, step: 0.01, value: p.filterEnv.sustain, unit: '%', onInput: (v) => set(['filterEnv', 'sustain'], v) }),
      slider({ label: '滑音时间', min: 0, max: 0.5, step: 0.005, value: p.portamento, unit: 's', resetValue: 0, onInput: (v) => set(['portamento'], v) }),
    );
    fenvGroup.append(fenvGrid);

    wrap.append(
      oscGroup, fltGroup, envGroup, fenvGroup,
      el('div', { class: 'fx-group-title' }, '试听'),
      this.miniKeyboard(track),
    );
    return wrap;
  }

  private renderFM(track: Track, p: FMSynthParams, set: Setter): HTMLElement {
    const wrap = el('div', {});

    const core = el('div', { class: 'fx-group' });
    core.append(el('div', { class: 'fx-group-title' }, 'FM 核心'));
    const coreGrid = el('div', { class: 'fx-grid' });
    coreGrid.append(
      slider({ label: '调制比 (Ratio)', min: 0.25, max: 12, step: 0.01, value: p.ratio, resetValue: 2, onInput: (v) => set(['ratio'], v) }),
      slider({ label: '调制深度 (Index)', min: 0, max: 12, step: 0.01, value: p.index, resetValue: 3, onInput: (v) => set(['index'], v) }),
      slider({ label: '自反馈', min: 0, max: 0.8, step: 0.01, value: p.feedback, resetValue: 0, onInput: (v) => set(['feedback'], v) }),
      dropdown('载波波形', waveOptions(), p.algorithm, (v) => set(['algorithm'], v)),
      dropdown('滤波器类型', filterOptions(), p.filter.type, (v) => set(['filter', 'type'], v)),
      slider({ label: '截止频率', min: 200, max: 16000, step: 10, value: p.filter.cutoff, unit: 'Hz', resetValue: 5200, onInput: (v) => set(['filter', 'cutoff'], v) }),
    );
    core.append(coreGrid);

    const envGroup = el('div', { class: 'fx-group' });
    envGroup.append(el('div', { class: 'fx-group-title' }, '音量包络 ADSR'));
    const envGrid = el('div', { class: 'fx-grid' });
    envGrid.append(
      slider({ label: '起音 A', min: 0.001, max: 2, step: 0.001, value: p.env.attack, unit: 's', onInput: (v) => set(['env', 'attack'], v) }),
      slider({ label: '衰减 D', min: 0.01, max: 3, step: 0.01, value: p.env.decay, unit: 's', onInput: (v) => set(['env', 'decay'], v) }),
      slider({ label: '延音 S', min: 0.01, max: 1, step: 0.01, value: p.env.sustain, unit: '%', onInput: (v) => set(['env', 'sustain'], v) }),
      slider({ label: '释放 R', min: 0.01, max: 4, step: 0.01, value: p.env.release, unit: 's', onInput: (v) => set(['env', 'release'], v) }),
    );
    envGroup.append(envGrid);

    const modGroup = el('div', { class: 'fx-group' });
    modGroup.append(el('div', { class: 'fx-group-title' }, '调制器包络'));
    const modGrid = el('div', { class: 'fx-grid' });
    modGrid.append(
      slider({ label: '起音 A', min: 0.001, max: 2, step: 0.001, value: p.modEnv.attack, unit: 's', onInput: (v) => set(['modEnv', 'attack'], v) }),
      slider({ label: '衰减 D', min: 0.01, max: 3, step: 0.01, value: p.modEnv.decay, unit: 's', onInput: (v) => set(['modEnv', 'decay'], v) }),
      slider({ label: '延音 S', min: 0.01, max: 1, step: 0.01, value: p.modEnv.sustain, unit: '%', onInput: (v) => set(['modEnv', 'sustain'], v) }),
      slider({ label: '释放 R', min: 0.01, max: 4, step: 0.01, value: p.modEnv.release, unit: 's', onInput: (v) => set(['modEnv', 'release'], v) }),
    );
    modGroup.append(modGrid);

    wrap.append(core, envGroup, modGroup,
      el('div', { class: 'fx-group-title' }, '试听'), this.miniKeyboard(track));
    return wrap;
  }

  /**
   * 拨弦面板（古筝/琵琶/阮）。
   *
   * 参数只用物理量、不用抽象系数：damping 是弦阻尼截止频率，
   * t60 是"衰减 60dB 需要几秒"。这样用户拖滑块时心里有数
   * （"我要更长的余音"→ 拉 t60），而不是盲调。
   */
  private renderPluck(track: Track, p: PluckParams, set: Setter): HTMLElement {
    const wrap = el('div', {});
    const g = el('div', { class: 'fx-group' });
    g.append(el('div', { class: 'fx-group-title' }, '弦 · String'));
    const grid = el('div', { class: 'fx-grid' });
    grid.append(
      slider({
        label: '音色亮度（弦阻尼）', min: 600, max: 9000, step: 50,
        value: p.damping, unit: 'Hz', resetValue: 3400,
        onInput: (v) => set(['damping'], v),
      }),
      slider({
        label: '余音长度（T60）', min: 0.2, max: 8, step: 0.05,
        value: p.t60, unit: 's', resetValue: 2.5,
        onInput: (v) => set(['t60'], v),
      }),
      slider({
        label: '音量', min: 0.05, max: 1, step: 0.01,
        value: p.level, unit: '%', resetValue: 0.7,
        onInput: (v) => set(['level'], v),
      }),
      slider({
        label: '音高微调', min: -50, max: 50, step: 1,
        value: p.detune, unit: 'cent', resetValue: 0,
        onInput: (v) => set(['detune'], v),
      }),
    );
    g.append(grid);
    g.append(el('div', {
      style: 'margin-top:11px;font-size:11px;color:var(--text-mute);line-height:1.8',
    },
      '拨弦用的是 Karplus-Strong 物理模型：噪声激励 + 弦长决定的延迟反馈。'
      + '余音长度（T60 = 衰减 60 分贝所需秒数）古筝约 4 秒、琵琶约 1.6 秒、阮约 1.2 秒。'));
    wrap.append(g,
      el('div', { class: 'fx-group-title' }, '试听'),
      this.miniKeyboard(track));
    return wrap;
  }

  /** 击弦面板（扬琴）：拨弦 + 轮音 + 双排弦拍频 */
  private renderYangle(track: Track, p: YangleParams, set: Setter): HTMLElement {
    const wrap = el('div', {});
    const base = this.renderPluck(track, p, set);

    const roll = el('div', { class: 'fx-group' });
    roll.append(el('div', { class: 'fx-group-title' }, '轮音 · Roll（双手交替敲击）'));
    const rg = el('div', { class: 'fx-grid' });
    rg.append(
      slider({
        label: '轮音速度', min: 0, max: 30, step: 0.5,
        value: p.rollRate, unit: 'Hz', resetValue: 14,
        onInput: (v) => set(['rollRate'], v),
      }),
      slider({
        label: '轮音深度', min: 0, max: 1, step: 0.01,
        value: p.rollDepth, unit: '%', resetValue: 0.4,
        onInput: (v) => set(['rollDepth'], v),
      }),
      slider({
        label: '双排弦失谐（拍频）', min: 0, max: 40, step: 1,
        value: p.detune2, unit: 'cent', resetValue: 14,
        onInput: (v) => set(['detune2'], v),
      }),
    );
    roll.append(rg);
    roll.append(el('div', {
      style: 'margin-top:11px;font-size:11px;color:var(--text-mute);line-height:1.8',
    },
      '轮音速度设为 0 就是单次敲击。'
      + '双排弦失谐让两根弦各成一个独立振动环，产生真实的拍频（听感上是"哇"的金属感）。'));

    // rollRate 归零时 rollDepth / detune2 无意义，隐藏避免误导
    const showRoll = p.rollRate > 0.1;
    wrap.append(base);
    if (showRoll) wrap.append(roll);
    return wrap;
  }

  /** 拉弦面板（二胡/板胡） */
  private renderBow(track: Track, p: BowParams, set: Setter): HTMLElement {
    const wrap = el('div', {});

    const vib = el('div', { class: 'fx-group' });
    vib.append(el('div', { class: 'fx-group-title' }, '揉弦 · Vibrato（拉弦的灵魂）'));
    const vg = el('div', { class: 'fx-grid' });
    vg.append(
      slider({
        label: '揉弦深度', min: 0, max: 120, step: 1,
        value: p.vibratoDepth, unit: 'cent', resetValue: 45,
        onInput: (v) => set(['vibratoDepth'], v),
      }),
      slider({
        label: '揉弦速度', min: 1, max: 10, step: 0.1,
        value: p.vibratoRate, unit: 'Hz', resetValue: 5.2,
        onInput: (v) => set(['vibratoRate'], v),
      }),
      slider({
        label: '揉弦渐入', min: 0, max: 2, step: 0.01,
        value: p.vibratoDelay, unit: 's', resetValue: 0.28,
        onInput: (v) => set(['vibratoDelay'], v),
      }),
      slider({
        label: '弓压（影响泛亮度）', min: 0, max: 1, step: 0.01,
        value: p.bowPressure, unit: '%', resetValue: 0.42,
        onInput: (v) => set(['bowPressure'], v),
      }),
      slider({
        label: '弓弦摩擦声', min: 0, max: 0.4, step: 0.005,
        value: p.bowNoise, unit: '%', resetValue: 0.07,
        onInput: (v) => set(['bowNoise'], v),
      }),
    );
    vib.append(vg);
    vib.append(el('div', {
      style: 'margin-top:11px;font-size:11px;color:var(--text-mute);line-height:1.8',
    },
      '二胡揉弦 4~6Hz、板胡更快更粗。'
      + '揉弦渐入很重要：真实的揉弦是长音时才加大，短促音头几乎不揉，'
      + '设为 0 会让每个音从头就在颤，听感机械。'));

    const body = el('div', { class: 'fx-group' });
    body.append(el('div', { class: 'fx-group-title' }, '琴筒共鸣 · Body'));
    const bg = el('div', { class: 'fx-grid' });
    bg.append(
      slider({
        label: '共鸣峰频率', min: 150, max: 2000, step: 10,
        value: p.bodyHz, unit: 'Hz', resetValue: 420,
        onInput: (v) => set(['bodyHz'], v),
      }),
      slider({
        label: '共鸣峰强度 (Q)', min: 0.5, max: 10, step: 0.1,
        value: p.bodyQ, resetValue: 3.2,
        onInput: (v) => set(['bodyQ'], v),
      }),
    );
    body.append(bg);

    const env = el('div', { class: 'fx-group' });
    env.append(el('div', { class: 'fx-group-title' }, '运弓包络'));
    const eg = el('div', { class: 'fx-grid' });
    eg.append(
      slider({ label: '起音', min: 0.005, max: 1, step: 0.005, value: p.attack, unit: 's', onInput: (v) => set(['attack'], v) }),
      slider({ label: '延音', min: 0.05, max: 1, step: 0.01, value: p.sustain, unit: '%', resetValue: 0.82, onInput: (v) => set(['sustain'], v) }),
      slider({ label: '释放', min: 0.02, max: 2, step: 0.01, value: p.release, unit: 's', resetValue: 0.18, onInput: (v) => set(['release'], v) }),
      slider({ label: '音量', min: 0.05, max: 1, step: 0.01, value: p.level, unit: '%', resetValue: 0.65, onInput: (v) => set(['level'], v) }),
    );
    env.append(eg);

    wrap.append(vib, body, env,
      el('div', { class: 'fx-group-title' }, '试听'),
      this.miniKeyboard(track));
    return wrap;
  }

  /** 吹管面板（竹笛/箫/唢呐/笙） */
  private renderWind(track: Track, p: WindParams, set: Setter): HTMLElement {
    const wrap = el('div', {});

    const tone = el('div', { class: 'fx-group' });
    tone.append(el('div', { class: 'fx-group-title' }, '音色 · Tone'));
    const tg = el('div', { class: 'fx-grid' });
    tg.append(
      slider({
        label: '主音占比', min: 0.1, max: 1, step: 0.01,
        value: p.tone, unit: '%', resetValue: 0.75,
        onInput: (v) => set(['tone'], v),
      }),
      slider({
        label: '奇次谐波倾向（闭管感）', min: 0, max: 1, step: 0.01,
        value: p.oddHarmonics, unit: '%', resetValue: 0.78,
        onInput: (v) => set(['oddHarmonics'], v),
      }),
      slider({
        label: '底音空洞（低音区的空心感）', min: 0, max: 1, step: 0.01,
        value: p.hollow, unit: '%', resetValue: 0.12,
        onInput: (v) => set(['hollow'], v),
      }),
    );
    tone.append(tg);
    tone.append(el('div', {
      style: 'margin-top:11px;font-size:11px;color:var(--text-mute);line-height:1.8',
    },
      '奇次谐波拉到 100% 接近闭管（箫、笙，暗而圆）；'
      + '拉到 0 则奇偶谐波齐备（唢呐，亮而高亢，金属芯）。'));

    const breath = el('div', { class: 'fx-group' });
    breath.append(el('div', { class: 'fx-group-title' }, '气息 · Breath'));
    const bg = el('div', { class: 'fx-grid' });
    bg.append(
      slider({
        label: '气声量', min: 0, max: 1, step: 0.01,
        value: p.breath, unit: '%', resetValue: 0.3,
        onInput: (v) => set(['breath'], v),
      }),
      slider({
        label: '气声亮度', min: 400, max: 8000, step: 50,
        value: p.breathHz, unit: 'Hz', resetValue: 3400,
        onInput: (v) => set(['breathHz'], v),
      }),
      slider({ label: '气声起音', min: 0.005, max: 0.5, step: 0.005, value: p.breathAttack, unit: 's', onInput: (v) => set(['breathAttack'], v) }),
    );
    breath.append(bg);
    breath.append(el('div', {
      style: 'margin-top:11px;font-size:11px;color:var(--text-mute);line-height:1.8',
    },
      '气声起音刻意比主音慢，模拟"先吹气、后出声"。'
      + '这是笛箫和风琴最明显的区别：风琴没有这一层。'));

    const tube = el('div', { class: 'fx-group' });
    tube.append(el('div', { class: 'fx-group-title' }, '管身与运指'));
    const ug = el('div', { class: 'fx-grid' });
    ug.append(
      slider({ label: '管身共振峰', min: 200, max: 4000, step: 10, value: p.bodyHz, unit: 'Hz', resetValue: 1400, onInput: (v) => set(['bodyHz'], v) }),
      slider({ label: '共振峰强度 (Q)', min: 0.4, max: 8, step: 0.1, value: p.bodyQ, resetValue: 2.4, onInput: (v) => set(['bodyQ'], v) }),
      slider({ label: '颤音深度', min: 0, max: 80, step: 1, value: p.vibratoDepth, unit: 'cent', resetValue: 16, onInput: (v) => set(['vibratoDepth'], v) }),
      slider({ label: '颤音速度', min: 1, max: 10, step: 0.1, value: p.vibratoRate, unit: 'Hz', resetValue: 4.6, onInput: (v) => set(['vibratoRate'], v) }),
      slider({ label: '音准修正', min: -60, max: 60, step: 1, value: p.detune, unit: 'cent', resetValue: 0, onInput: (v) => set(['detune'], v) }),
      slider({ label: '起音', min: 0.005, max: 0.5, step: 0.005, value: p.attack, unit: 's', onInput: (v) => set(['attack'], v) }),
      slider({ label: '释放', min: 0.02, max: 1.5, step: 0.01, value: p.release, unit: 's', resetValue: 0.14, onInput: (v) => set(['release'], v) }),
      slider({ label: '音量', min: 0.05, max: 1, step: 0.01, value: p.level, unit: '%', resetValue: 0.62, onInput: (v) => set(['level'], v) }),
    );
    tube.append(ug);

    wrap.append(tone, breath, tube,
      el('div', { class: 'fx-group-title' }, '试听'),
      this.miniKeyboard(track));
    return wrap;
  }

  private renderDrum(track: Track, project: Project): HTMLElement {
    const kit = track.params as DrumKitParams;
    const wrap = el('div', {});
    const row = project.steps[track.id];
    const layout = row?.layout ?? [];

    const head = el('div', { class: 'fx-group-title' }, '鼓件参数 · 点击试听');
    wrap.append(head);

    for (const part of Object.keys(kit) as Array<keyof DrumKitParams>) {
      if (!layout.includes(part)) continue;
      const v = kit[part];
      const group = el('div', { class: 'fx-group' });
      group.append(el('div', { class: 'fx-group-title', style: 'text-transform:none;letter-spacing:0;font-size:11.5px' },
        DRUM_LABELS[part] ?? part));

      const set = (path: string[], val: unknown) => this.cb.onParam(track.id, [part, ...path], val);
      const grid = el('div', { class: 'fx-grid' });
      grid.append(
        slider({ label: '音高', min: 30, max: 10000, step: 5, value: v.pitch, unit: 'Hz', onInput: (x) => set(['pitch'], x) }),
        slider({ label: '衰减长度', min: 0.02, max: 1.5, step: 0.005, value: v.decay, unit: 's', onInput: (x) => set(['decay'], x) }),
        slider({ label: '噪声成分', min: 0, max: 1, step: 0.01, value: v.noise, unit: '%', resetValue: 0, onInput: (x) => set(['noise'], x) }),
        slider({ label: '基音厚度', min: 0, max: 1, step: 0.01, value: v.body, unit: '%', resetValue: 0, onInput: (x) => set(['body'], x) }),
        slider({ label: '音调下滑', min: 0, max: 200, step: 1, value: v.bend, unit: 'Hz', resetValue: 0, onInput: (x) => set(['bend'], x) }),
        slider({ label: '失真饱和', min: 0, max: 1, step: 0.01, value: v.drive, unit: '%', resetValue: 0, onInput: (x) => set(['drive'], x) }),
      );
      group.append(grid);
      wrap.append(group);
    }

    wrap.append(
      el('div', { class: 'fx-group-title' }, '快速试听'),
      this.miniDrumPad(track, layout),
    );
    return wrap;
  }

  private miniDrumPad(track: Track, layout: string[]): HTMLElement {
    const wrap = el('div', {
      style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-top:8px;max-width:420px',
    });

    for (const part of layout) {
      const btn = el('button', {
        class: 'btn',
        type: 'button',
        style: 'padding:12px 8px',
      }, DRUM_LABELS[part] ?? part);

      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.cb.onPreviewNote(track.id, partToKey(part), 1);
      });
      const up = () => this.cb.onPreviewOff(track.id);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointerleave', up);
      wrap.append(btn);
    }
    return wrap;
  }
}

function waveOptions() {
  return [
    { value: 'sine', label: '正弦（圆润）' },
    { value: 'triangle', label: '三角（柔和）' },
    { value: 'sawtooth', label: '锯齿（明亮）' },
    { value: 'square', label: '方波（有力）' },
  ];
}

function filterOptions() {
  return [
    { value: 'lowpass', label: '低通（去掉高频）' },
    { value: 'highpass', label: '高通（去掉低频）' },
    { value: 'bandpass', label: '带通（突出中频）' },
    { value: 'notch', label: '陷波（挖空某频段）' },
  ];
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function keyName(key: number): string {
  return `${NOTE_NAMES[((key % 12) + 12) % 12]}${Math.floor(key / 12) - 1}`;
}

const PART_KEYS: Record<string, number> = {
  kick: 36, snare: 38, clap: 39, closedHat: 42,
  openHat: 46, tomLow: 41, tomMid: 45, rim: 37,
};
function partToKey(part: string): number {
  return PART_KEYS[part] ?? 36;
}