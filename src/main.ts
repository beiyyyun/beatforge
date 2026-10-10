/**
 * BeatForge · 应用入口
 * ============================================
 * 负责：组装界面、连接状态与音频引擎、快捷键、文件读写。
 */

import './style.css';
import { el, toast, modal, stepToBars, formatDuration } from './ui/dom';
import { Store, demoProject, emptyProject, makeTrack, makeStepRow, makeLayer, nextId } from './core/store';
import { PlaybackEngine } from './audio/engine';
import { exportWav, downloadBlob } from './audio/export';
import { PRESETS, getPresetById } from './audio/presets';
import { getInstrumentDef } from './audio/registry';
import './audio/register';
import { GRID_OPTIONS, KEYBOARD_MAP, DEFAULT_INSERT } from './core/constants';
import type { Project, Track } from './core/types';
import { ChannelRack } from './ui/rack';
import { StepSequencer } from './ui/stepper';
import { PianoRoll } from './ui/pianoroll';
import { Mixer } from './ui/mixer';
import { InstrumentEditor } from './ui/editor';
import { FXPanel } from './ui/fxpanel';
import { ScopeView } from './ui/scope';
import { HarmonyPanel } from './ui/harmonypanel';
import { MAX_LAYERS, instrumentTag } from './ui/layers';
import { RecordPanel } from './ui/recordpanel';

// ============================================================
// 状态
// ============================================================

const store = new Store(demoProject());
const engine = new PlaybackEngine();

type MainTab = 'rack' | 'step' | 'piano' | 'harmony' | 'record' | 'mixer' | 'tone' | 'fx';
type BrowserTab = 'presets' | 'project';

const ui = {
  mainTab: 'rack' as MainTab,
  browserTab: 'presets' as BrowserTab,
  selectedTrackId: null as string | null,
  fxTrackId: null as string | null,
  keyboardNotes: new Map<string, number>(),
  playingKeys: new Set<number>(),
  /** UI 元素引用，refresh 时更新 */
  playBtn: null as unknown as HTMLButtonElement,
  posValue: null as unknown as HTMLElement,
  bpmValue: null as unknown as HTMLElement,
  gridSeg: null as unknown as HTMLSelectElement,
  loopBtn: null as unknown as HTMLButtonElement,
  browserBody: null as unknown as HTMLElement,
  mainBody: null as unknown as HTMLElement,
  /**
   * 每个主标签对应的 .panel 宿主元素。
   * 面板实例（rack / stepper / pianoRoll …）的 root 是独立节点，
   * 必须由这里挂进 mainBody，再通过 hidden 属性切换显示 ——
   * 不挂的话 refresh() 渲染的内容根本没有落脚点，主工作区会是空的。
   */
  panelHosts: {} as Partial<Record<MainTab, HTMLElement>>,
  tabButtons: {} as Partial<Record<MainTab, HTMLElement>>,
  tabPresets: null as unknown as HTMLButtonElement,
  tabProject: null as unknown as HTMLButtonElement,
  statusDot: null as unknown as HTMLElement,
  statusText: null as unknown as HTMLElement,
  statusTime: null as unknown as HTMLElement,
  statusNotes: null as unknown as HTMLElement,
  undoBtn: null as unknown as HTMLButtonElement,
  redoBtn: null as unknown as HTMLButtonElement,
  nameInput: null as unknown as HTMLInputElement,
  scope: null as unknown as ScopeView,
  scopeBtn: null as unknown as HTMLButtonElement,
};

// ============================================================
// 组件实例
// ============================================================

const rack = new ChannelRack({
  onSelect: (id) => { ui.selectedTrackId = id; refreshSelection(); refresh(); },
  onToggleMute: (id) => store.update((d) => {
    const t = d.tracks.find((x) => x.id === id);
    if (t) { t.muted = !t.muted; engine.applyTrackState(t); }
  }),
  onToggleSolo: (id) => store.update((d) => {
    const t = d.tracks.find((x) => x.id === id);
    if (t) t.solo = !t.solo;
  }),
  onVolume: (id, v) => store.update((d) => {
    const t = d.tracks.find((x) => x.id === id);
    if (t) { t.volume = v; engine.applyTrackState(t); }
  }, false),
  onPan: (id, v) => store.update((d) => {
    const t = d.tracks.find((x) => x.id === id);
    if (t) { t.pan = v; engine.applyTrackState(t); }
  }, false),
  onSendReverb: (id, v) => store.update((d) => {
    const t = d.tracks.find((x) => x.id === id);
    if (t) { t.sendReverb = v; engine.applyTrackState(t); }
  }, false),
  onSendDelay: (id, v) => store.update((d) => {
    const t = d.tracks.find((x) => x.id === id);
    if (t) { t.sendDelay = v; engine.applyTrackState(t); }
  }, false),
  onRemove: (id) => removeTrack(id),
  onOpenStepper: (id) => { ui.selectedTrackId = id; refreshSelection(); switchTab('step'); },
  onOpenPianoRoll: (id) => { ui.selectedTrackId = id; refreshSelection(); switchTab('piano'); },
  onPreview: (track) => previewTrack(track),
});

const stepper = new StepSequencer({
  onBeginEdit: () => store.commit(),
  onToggle: (trackId, part, step, on, velocity) => store.update((d) => {
    const row = d.steps[trackId];
    if (!row) return;
    const total = d.totalSteps;
    row.steps[part * total + step] = on ? velocity : 0;
  }),
});

const pianoRoll = new PianoRoll({
  onBeginEdit: () => store.commit(),
  onAdd: (trackId, key, start, length, velocity) => {
    const id = nextId('n');
    store.update((d) => {
      d.notes.push({ id, key, start, length, velocity, trackId });
    });
    return id;
  },
  onMove: (noteId, key, start, length) => store.update((d) => {
    const n = d.notes.find((x) => x.id === noteId);
    if (n) { n.key = key; n.start = start; n.length = Math.max(1, length); }
  }, false),
  onDelete: (noteId) => store.update((d) => {
    d.notes = d.notes.filter((n) => n.id !== noteId);
  }),
  onPreviewKey: (trackId, key, isDown) => {
    const track = store.current.tracks.find((t) => t.id === trackId);
    if (!track) return;
    if (track.kind === 'drum') {
      if (isDown) engine.previewDrum(track, drumPartForKey(key), 1);
    } else {
      if (isDown) {
        engine.previewNoteOn(track, key, 0.85);
        ui.playingKeys.add(key);
      } else {
        engine.previewNoteOff(track);
        ui.playingKeys.delete(key);
      }
      editor.setPlayingKeys(ui.playingKeys);
    }
  },
});

const mixer = new Mixer({
  onBeginEdit: () => store.commit(),
  onVolume: (id, v) => store.update((d) => {
    const t = d.tracks.find((x) => x.id === id);
    if (t) { t.volume = v; engine.applyTrackState(t); }
  }, false),
  onPan: (id, v) => store.update((d) => {
    const t = d.tracks.find((x) => x.id === id);
    if (t) { t.pan = v; engine.applyTrackState(t); }
  }, false),
  onMute: (id) => store.update((d) => {
    const t = d.tracks.find((x) => x.id === id);
    if (t) { t.muted = !t.muted; engine.applyTrackState(t); }
  }),
  onSolo: (id) => store.update((d) => {
    const t = d.tracks.find((x) => x.id === id);
    if (t) t.solo = !t.solo;
  }),
  onMasterVolume: (v) => store.update((d) => { d.masterVolume = v; }, false),
});

const editor = new InstrumentEditor({
  onCommit: () => store.commit(),
  onParam: (trackId, path, value) => store.update((d) => {
    const t = d.tracks.find((x) => x.id === trackId);
    if (!t) return;
    let obj: Record<string, unknown> = t.params as never;
    for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]] as Record<string, unknown>;
    obj[path[path.length - 1]] = value;
  }, false),
  onPreviewNote: (trackId, key, velocity) => {
    const track = store.current.tracks.find((t) => t.id === trackId);
    if (!track) return;
    if (track.kind === 'drum') engine.previewDrum(track, drumPartForKey(key), velocity);
    else engine.previewNoteOn(track, key, velocity);
  },
  onPreviewOff: (trackId) => {
    const track = store.current.tracks.find((t) => t.id === trackId);
    if (track && track.kind !== 'drum') engine.previewNoteOff(track);
  },
  onLayerAdd: (trackId, presetId) => {
    const track = store.current.tracks.find((x) => x.id === trackId);
    if (!track) return;
    if ((track.layers?.length ?? 0) >= MAX_LAYERS) {
      toast(`最多叠加 ${MAX_LAYERS} 层`, 2000);
      return;
    }
    const layer = makeLayer(presetId);
    store.update((d) => {
      const t = d.tracks.find((x) => x.id === trackId);
      if (!t) return;
      if (!t.layers) t.layers = [];
      if (t.layers.length >= MAX_LAYERS) return;
      t.layers.push(layer);
    });
    // 拓扑变了，必须重建声音链路
    engine.rebuild(store.current);
    refresh();
    const n = store.current.tracks.find((x) => x.id === trackId)?.layers?.length ?? 0;
    toast(`已叠加「${layer.name}」，当前 ${n} 层`);
  },
  onLayerParam: (trackId, layerId, path, value) => store.update((d) => {
    const t = d.tracks.find((x) => x.id === trackId);
    const layer = t?.layers?.find((l) => l.id === layerId);
    if (!t || !layer) return;
    let obj = layer.params as unknown as Record<string, unknown>;
    for (let i = 0; i < path.length - 1; i++) {
      obj = obj[path[i]] as Record<string, unknown>;
    }
    obj[path[path.length - 1]] = value;
    // 音量/声像/发送只改增益，不必重建；音色参数下次触发自然生效
    engine.applyTrackState(t);
  }, false),
  onLayerRemove: (trackId, layerId) => {
    store.update((d) => {
      const t = d.tracks.find((x) => x.id === trackId);
      if (!t?.layers) return;
      t.layers = t.layers.filter((l) => l.id !== layerId);
    });
    engine.rebuild(store.current);
    refresh();
    toast('叠加层已删除');
  },
  onLayerToggleMute: (trackId, layerId) => store.update((d) => {
    const t = d.tracks.find((x) => x.id === trackId);
    const layer = t?.layers?.find((l) => l.id === layerId);
    if (!layer) return;
    layer.muted = !layer.muted;
    engine.applyTrackState(t!);
  }),
});

const fxPanel = new FXPanel({
  onParam: (trackId, path, value) => store.update((d) => {
    const t = d.tracks.find((x) => x.id === trackId);
    if (!t || !t.insert) return;
    let obj: Record<string, unknown> = t.insert as never;
    for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]] as Record<string, unknown>;
    obj[path[path.length - 1]] = value;
    engine.rebuild(d);
  }, false),
  onCommit: () => store.commit(),
  onEnable: (trackId, enabled) => store.update((d) => {
    const t = d.tracks.find((x) => x.id === trackId);
    if (t) {
      if (!t.insert) t.insert = { ...DEFAULT_INSERT };
      t.insert.enabled = enabled;
      engine.rebuild(d);
    }
  }),
  onSelect: (id) => { ui.fxTrackId = id; refresh(); },
});

const harmony = new HarmonyPanel({
  onGenerate: (trackId, notes) => {
    store.commit();
    store.update((d) => {
      d.notes = d.notes.filter((n) => n.trackId !== trackId);
      for (const n of notes) d.notes.push({ ...n, trackId });
    });
    engine.rebuild(store.current);
    ui.selectedTrackId = trackId;
    refreshSelection();
    refresh();
    toast(notes.length ? `已生成 ${notes.length} 个音符` : '已清空该轨音符');
  },
  onPreviewChord: (trackId, keys, holdMs) => {
    const track = store.current.tracks.find((t) => t.id === trackId);
    if (!track) return;
    engine.init();
    for (const key of keys) engine.previewNoteOn(track, key, 0.72);
    setTimeout(() => engine.previewNoteOff(track), holdMs);
  },
  onCreateTrack: (style) => {
    // 按风格挑一个合适的默认音色，避免用户面对空白选择
    const name = style === 'bassline' ? '厚实贝斯'
      : style === 'pad' ? '空气感垫'
      : '温暖电钢琴';
    const preset = PRESETS.find((p) => p.name === name);
    if (!preset) return;
    addPresetTrack(preset.id);
    const created = store.current.tracks[store.current.tracks.length - 1];
    harmony.setTarget(created.id);
    switchTab('harmony');
  },
});

const record = new RecordPanel({
  onCommit: (trackId, notes) => {
    store.commit();
    store.update((d) => {
      d.notes = d.notes.filter((n) => n.trackId !== trackId);
      for (const n of notes) {
        d.notes.push({ id: nextId('n'), trackId, ...n });
      }
    });
    engine.rebuild(store.current);
    ui.selectedTrackId = trackId;
    refreshSelection();
    refresh();
    toast(`已写入 ${notes.length} 个音符，点播放听听看`);
  },
  onPreview: (trackId, notes) => {
    const track = store.current.tracks.find((t) => t.id === trackId);
    if (!track) return;
    engine.init();
    const secPerStep = 60 / store.current.bpm / store.current.gridSteps;
    notes.forEach((n) => {
      setTimeout(() => {
        engine.previewNoteOn(track, n.key, n.velocity);
        setTimeout(() => engine.previewNoteOff(track), Math.max(60, n.length * secPerStep * 1000 * 0.85));
      }, n.start * secPerStep * 1000);
    });
  },
});
// 面板内部状态变化时自己触发重绘，避免每个按钮都往 main.ts 挂回调
record.onChange = () => {
  if (ui.mainTab === 'record') refresh();
};

// ============================================================
// 构建界面
// ============================================================

function buildApp() {
  const app = document.getElementById('app')!;
  app.replaceChildren();

  // ---------- 顶部栏 ----------
  const topbar = el('header', { class: 'topbar' });
  topbar.append(
    el('div', { class: 'brand' }, el('div', { class: 'brand-mark' }), 'BeatForge'),
  );

  const transport = el('div', { class: 'transport' });

  const playBtn = el('button', {
    class: 'btn-icon btn-play', type: 'button', title: '播放 / 停止 (空格)',
  }, el('div', { class: 'icon-play' })) as HTMLButtonElement;
  playBtn.addEventListener('click', togglePlay);

  const stopBtn = el('button', {
    class: 'btn-icon', type: 'button', title: '停止并回到开头',
  }, el('div', { class: 'icon-stop' }));
  stopBtn.addEventListener('click', () => {
    stopPlayback();
    store.silentUpdate((d) => { d.playhead = 0; });
    refresh();
  });

  const panicBtn = el('button', {
    class: 'btn-icon', type: 'button', title: '紧急停止所有声音 (Esc)',
  }, '!');
  panicBtn.addEventListener('click', panic);

  transport.append(playBtn, stopBtn, panicBtn);

  // BPM
  const bpmReadout = el('div', { class: 'readout' });
  const bpmValue = el('span', { class: 'readout-value is-editable' }, String(store.current.bpm)) as HTMLElement;
  bpmValue.addEventListener('click', () => promptNumber('设置速度 BPM', 40, 240, store.current.bpm, (v) => {
    store.update((d) => { d.bpm = v; });
    engine.setBpm(v);
    refresh();
  }));
  bpmReadout.append(el('span', { class: 'readout-label' }, 'BPM'), bpmValue);

  // 位置
  const posReadout = el('div', { class: 'readout' });
  const posValue = el('span', { class: 'readout-value' }, '1.1') as HTMLElement;
  posReadout.append(el('span', { class: 'readout-label' }, '小节.拍'), posValue);

  const loopBtn = el('button', {
    class: 'btn-icon is-active', type: 'button', title: '循环播放',
  }, '↻') as HTMLButtonElement;
  loopBtn.addEventListener('click', () => {
    store.update((d) => { d.loop = !d.loop; });
    loopBtn.classList.toggle('is-active', store.current.loop);
  });

  // 网格
  const gridSeg = el('select', {
    class: 'ctrl-select', style: 'width:98px;padding:4px 8px',
  }) as HTMLSelectElement;
  for (const g of GRID_OPTIONS) {
    const o = el('option', { value: String(g.steps) }, g.label) as HTMLOptionElement;
    if (g.steps === store.current.gridSteps) o.selected = true;
    gridSeg.append(o);
  }
  gridSeg.addEventListener('change', () => {
    store.update((d) => { d.gridSteps = parseInt(gridSeg.value, 10); });
    engine.setBpm(store.current.bpm);
    refresh();
  });

  topbar.append(
    transport,
    el('div', { class: 'divider' }),
    bpmReadout, loopBtn,
    el('div', { class: 'divider' }),
    posReadout,
    el('div', { class: 'divider' }),
    el('span', { class: 'readout-label' }, '网格'),
    gridSeg,
    el('div', { class: 'topbar-spacer' }),
  );

  const nameInput = el('input', {
    class: 'project-name', type: 'text', value: store.current.name,
  }) as HTMLInputElement;
  nameInput.addEventListener('change', () => {
    store.update((d) => { d.name = nameInput.value || '未命名工程'; });
  });
  topbar.append(nameInput);

  const fileBtn = el('button', { class: 'btn', type: 'button' }, '文件');
  fileBtn.addEventListener('click', openFileMenu);
  topbar.append(fileBtn);

  const exportBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '导出音频');
  exportBtn.addEventListener('click', openExportDialog);
  topbar.append(exportBtn);

  const helpBtn = el('button', { class: 'btn btn-ghost', type: 'button', title: '新手引导' }, '?');
  helpBtn.addEventListener('click', showGuide);
  topbar.append(helpBtn);

  // 波形可视化
  const scope = new ScopeView('wave');
  scope.root.style.width = '190px';
  scope.root.style.height = '32px';
  scope.root.title = '实时波形输出';
  scope.clear();

  const scopeBtn = el('button', {
    class: 'btn-icon', type: 'button', title: '切换波形 / 频谱显示',
  }, '∿');
  let scopeMode: 'wave' | 'spectrum' = 'wave';
  scopeBtn.addEventListener('click', () => {
    scopeMode = scopeMode === 'wave' ? 'spectrum' : 'wave';
    scope.setMode(scopeMode);
    if (store.current.playing) scope.start();
  });

  topbar.append(el('div', { class: 'divider' }), scope.root, scopeBtn);

  // ---------- 工作区 ----------
  const workspace = el('div', { class: 'workspace' });

  const browser = el('aside', { class: 'browser' });
  const browserTabs = el('div', { class: 'browser-tabs' });
  const tabPresets = el('button', { class: 'browser-tab is-active', type: 'button' }, '乐器') as HTMLButtonElement;
  const tabProject = el('button', { class: 'browser-tab', type: 'button' }, '工程') as HTMLButtonElement;
  tabPresets.addEventListener('click', () => switchBrowser('presets'));
  tabProject.addEventListener('click', () => switchBrowser('project'));
  browserTabs.append(tabPresets, tabProject);
  const browserBody = el('div', { class: 'browser-body' }) as HTMLElement;
  browser.append(browserTabs, browserBody);

  const main = el('main', { class: 'main' });
  const mainTabs = el('div', { class: 'main-tabs' });
  const tabDefs: Array<[MainTab, string, string]> = [
    ['rack', '通道', '组织乐器，每行一条轨道 (1)'],
    ['step', '步进', '用格子编鼓点，最简单的编曲方式 (2)'],
    ['piano', '钢琴卷帘', '画旋律与和弦，可拖动音符 (3)'],
    ['harmony', '编曲', '按和弦进行一键生成伴奏，不用懂乐理 (4)'],
    ['record', '录音', '对着麦克风哼唱，自动转成音符 (5)'],
    ['mixer', '混音', '调整每条轨道的音量与空间感 (6)'],
    ['tone', '音色', '调节合成器参数与叠加层 (7)'],
    ['fx', '效果', '为轨道添加均衡、失真等处理 (8)'],
  ];
  const tabButtons: Partial<Record<MainTab, HTMLElement>> = {};
  for (const [id, label, tip] of tabDefs) {
    // 首屏就把当前标签标出来。之前只有 switchTab() 会toggle is-active，
    // 而它只在点击时触发 —— 于是首屏 8 个标签全都不是选中态，
    // 用户看不到自己在哪个标签页。现在按 ui.mainTab 的初值直接标上。
    const btn = el('button', {
      class: `main-tab${id === ui.mainTab ? ' is-active' : ''}`,
      type: 'button',
      title: tip,
    }, label);
    btn.addEventListener('click', () => switchTab(id));
    tabButtons[id] = btn;
    mainTabs.append(btn);
  }
  const mainBody = el('div', { class: 'main-body' }) as HTMLElement;
  main.append(mainTabs, mainBody);

  // ---- 面板宿主 ----
  // 每个主标签一个 .panel 容器，把对应面板的 root 挂进去。
  // .panel 是 position:absolute; inset:0，.panel[hidden] 有 display:none，
  // 所以全部常驻 DOM、靠 hidden 切换即可，不需要反复搬节点 ——
  // 钢琴卷帘/步进器里存着滚动位置和拖拽状态，重建节点会把这些状态全丢掉。
  const panelRoots: Record<MainTab, HTMLElement> = {
    rack: rack.root,
    step: stepper.root,
    piano: pianoRoll.root,
    harmony: harmony.root,
    record: record.root,
    mixer: mixer.root,
    tone: editor.root,
    fx: fxPanel.root,
  };
  const panelHosts: Partial<Record<MainTab, HTMLElement>> = {};
  for (const [id, root] of Object.entries(panelRoots) as Array<[MainTab, HTMLElement]>) {
    const host = el('div', { class: 'panel', 'data-panel': id }) as HTMLElement;
    host.hidden = id !== ui.mainTab;
    host.append(root);
    panelHosts[id] = host;
    mainBody.append(host);
  }

  workspace.append(browser, main);

  // ---------- 状态栏 ----------
  const statusbar = el('footer', { class: 'statusbar' });
  const statusDot = el('span', { class: 'status-dot' });
  const statusText = el('span', {}, '音频引擎待启动');
  const statusAudio = el('span', { class: 'status-item' }, statusDot, statusText);
  const statusTime = el('span', {});
  const statusNotes = el('span', {});
  const undoBtn = el('button', { class: 'status-btn', type: 'button', title: '撤销 (Ctrl+Z)' }, '撤销') as HTMLButtonElement;
  const redoBtn = el('button', { class: 'status-btn', type: 'button', title: '重做 (Ctrl+Shift+Z)' }, '重做') as HTMLButtonElement;
  undoBtn.addEventListener('click', doUndo);
  redoBtn.addEventListener('click', doRedo);
  statusbar.append(
    statusAudio,
    statusTime, statusNotes,
    el('span', { class: 'status-spacer' }),
    undoBtn, redoBtn,
  );

  app.append(topbar, workspace, statusbar);

  Object.assign(ui, {
    playBtn, posValue, bpmValue, gridSeg, loopBtn,
    browserBody, mainBody, tabButtons, tabPresets, tabProject, panelHosts,
    statusDot, statusText, statusTime, statusNotes, undoBtn, redoBtn, nameInput,
    scope, scopeBtn,
  });
}

function setStatus(text: string, live: boolean) {
  ui.statusText.textContent = text;
  ui.statusDot.classList.toggle('is-live', live);
}

// ============================================================
// 刷新
// ============================================================

function refresh() {
  const project = store.current;

  ui.posValue.textContent = stepToBars(project.playhead, project.gridSteps);
  ui.bpmValue.textContent = String(project.bpm);

  const loopSec = project.totalSteps * (60 / project.bpm / project.gridSteps);
  ui.statusTime.textContent = project.playing
    ? `${stepToBars(project.playhead, project.gridSteps)} · 循环 ${formatDuration(loopSec)}`
    : `共 ${Math.round(project.totalSteps / (project.gridSteps * 4))} 小节 · ${formatDuration(loopSec)}`;
  ui.statusNotes.textContent = `${project.tracks.length} 通道 · ${project.notes.length} 音符`;
  ui.undoBtn.disabled = !store.canUndo;
  ui.redoBtn.disabled = !store.canRedo;
  ui.loopBtn.classList.toggle('is-active', project.loop);

  refreshSelection();

  // 先按当前标签显示对应面板，再让它渲染 ——
  // 反过来的话会出现"渲染进了隐藏容器"，用户切回来才看到内容。
  for (const [id, host] of Object.entries(ui.panelHosts)) {
    if (host) host.hidden = id !== ui.mainTab;
  }

  switch (ui.mainTab) {
    case 'rack': rack.setSelected(ui.selectedTrackId); rack.render(project); break;
    case 'step': stepper.setTrack(ui.selectedTrackId); stepper.render(project); break;
    case 'piano': pianoRoll.setTrack(ui.selectedTrackId); pianoRoll.render(project); break;
    case 'harmony': harmony.render(project, ui.selectedTrackId); break;
    case 'record': record.setTrack(ui.selectedTrackId); record.render(project, ui.selectedTrackId); break;
    case 'mixer': mixer.render(project); break;
    case 'tone': editor.setTrack(ui.selectedTrackId); editor.render(project); break;
    case 'fx': fxPanel.render(project, ui.fxTrackId); break;
  }

  renderBrowser(project);
}

function refreshSelection() {
  const p = store.current;
  if (!ui.selectedTrackId || !p.tracks.some((t) => t.id === ui.selectedTrackId)) {
    ui.selectedTrackId = p.tracks[0]?.id ?? null;
  }
  if (ui.selectedTrackId) {
    pianoRoll.setTrack(ui.selectedTrackId);
    stepper.setTrack(ui.selectedTrackId);
    editor.setTrack(ui.selectedTrackId);
  }
  if (!ui.fxTrackId || !p.tracks.some((t) => t.id === ui.fxTrackId)) {
    ui.fxTrackId = ui.selectedTrackId;
  }
}

function switchTab(tab: MainTab) {
  ui.mainTab = tab;
  for (const [id, btn] of Object.entries(ui.tabButtons)) {
    btn?.classList.toggle('is-active', id === tab);
  }
  refresh();
}

function switchBrowser(tab: 'presets' | 'project') {
  ui.browserTab = tab;
  ui.tabPresets.classList.toggle('is-active', tab === 'presets');
  ui.tabProject.classList.toggle('is-active', tab === 'project');
  renderBrowser(store.current);
}

// ============================================================
// 左侧浏览器
// ============================================================

function renderBrowser(project: Project) {
  if (ui.browserTab === 'presets') renderPresetList(project);
  else renderProjectList(project);
}

function renderPresetList(project: Project) {
  const frag = document.createDocumentFragment();
  const cats = [...new Set(PRESETS.map((p) => p.category))];

  for (const cat of cats) {
    frag.append(el('div', { class: 'browser-section' }, cat));
    for (const preset of PRESETS.filter((p) => p.category === cat)) {
      const isUsed = project.tracks.some((t) => t.presetId === preset.id);
      const card = el('div', {
        class: `preset${isUsed ? ' is-selected' : ''}`,
        title: `${preset.name} · 点击添加到编曲`,
      });

      const icon = el('div', { class: 'preset-icon' });
      icon.style.background = categoryColor(preset.category);
      icon.textContent = instrumentTag(preset.instrument);

      const info = el('div', { class: 'preset-info' });
      info.append(
        el('div', { class: 'preset-name' }, preset.name),
        el('div', { class: 'preset-meta' },
          isUsed ? '已在编曲中'
            : preset.trackKind === 'drum' ? '鼓组 · 8 件'
            : `${getInstrumentDef(preset.instrument)?.label ?? preset.instrument}乐器`),
      );

      card.append(icon, info);
      card.addEventListener('click', () => addPresetTrack(preset.id));
      frag.append(card);
    }
  }

  ui.browserBody.replaceChildren(frag);
}

function renderProjectList(project: Project) {
  const frag = document.createDocumentFragment();

  frag.append(el('div', { class: 'browser-section' }, '工程操作'));

  const mk = (label: string, title: string, action: () => void) => {
    const btn = el('button', {
      class: 'btn btn-sm', type: 'button',
      style: 'width:100%;margin-bottom:6px;text-align:left', title,
    }, label);
    btn.addEventListener('click', action);
    return btn;
  };

  frag.append(
    mk('新建空白工程', '清空所有内容', newProject),
    mk('载入示例工程', '8 小节完整示范', loadDemo),
    mk('保存到本地', '导出工程文件 (.json)', saveProject),
    mk('打开工程文件', '导入 .json', openProject),
    mk('导出音频 (WAV)', '把作品渲染成音频文件', openExportDialog),
  );

  frag.append(el('div', { class: 'browser-section' }, '当前工程'));
  const info = el('div', { style: 'font-size:11.5px;color:var(--text-mute);line-height:2' });
  info.innerHTML =
    `<div>速度：<strong style="color:var(--text-dim)">${project.bpm} BPM</strong></div>` +
    `<div>长度：<strong style="color:var(--text-dim)">${Math.round(project.totalSteps / (project.gridSteps * 4))} 小节</strong></div>` +
    `<div>通道：<strong style="color:var(--text-dim)">${project.tracks.length} 条</strong></div>` +
    `<div>音符：<strong style="color:var(--text-dim)">${project.notes.length} 个</strong></div>`;
  frag.append(info);

  frag.append(el('div', { class: 'browser-section' }, '键盘快捷键'));
  const keys = el('div', { style: 'font-size:11px;color:var(--text-mute);line-height:2.1' });
  keys.innerHTML =
    '<div><kbd>空格</kbd> 播放 / 停止</div>' +
    '<div><kbd>1</kbd>~<kbd>8</kbd> 切换标签页</div>' +
    '<div><kbd>A</kbd> ~ <kbd>;</kbd> 演奏选中乐器</div>' +
    '<div><kbd>Ctrl</kbd>+<kbd>Z</kbd> 撤销</div>' +
    '<div><kbd>Ctrl</kbd>+<kbd>S</kbd> 保存工程</div>' +
    '<div><kbd>Esc</kbd> 紧急静音</div>';
  frag.append(keys);

  ui.browserBody.replaceChildren(frag);
}

function categoryColor(cat: string): string {
  switch (cat) {
    case '鼓组': return '#ff8c3a';
    case '贝斯': return '#4a9eff';
    case '主音': return '#a78bfa';
    case '氛围': return '#3ecf8e';
    case '键盘': return '#f472b6';
    // 民乐四类用同一族暖色，一眼能和电子音色区分开
    case '拨弦': return '#f59e0b';
    case '拉弦': return '#f472b6';
    case '吹管': return '#4ade80';
    case '击弦': return '#fbbf24';
    default: return '#888780';
  }
}

// ============================================================
// 操作
// ============================================================

function addPresetTrack(presetId: string) {
  const preset = getPresetById(presetId);
  if (!preset) return;
  store.update((d) => {
    const track = makeTrack(presetId);
    d.tracks.push(track);
    if (track.kind === 'drum') {
      d.steps[track.id] = makeStepRow(d.totalSteps);
    }
  });
  const newId = store.current.tracks[store.current.tracks.length - 1];
  ui.selectedTrackId = newId.id;
  engine.rebuild(store.current);
  refresh();
  toast(`已添加「${preset.name}」`);
}

function removeTrack(id: string) {
  const track = store.current.tracks.find((t) => t.id === id);
  if (!track) return;
  store.update((d) => {
    d.tracks = d.tracks.filter((t) => t.id !== id);
    d.notes = d.notes.filter((n) => n.trackId !== id);
    delete d.steps[id];
  });
  refreshSelection();
  engine.rebuild(store.current);
  refresh();
  toast(`已删除「${track.name}」`, 1600);
}

function previewTrack(track: Track) {
  engine.init();
  if (track.kind === 'drum') {
    engine.previewDrum(track, 'kick', 1);
    setTimeout(() => engine.previewDrum(track, 'snare', 0.9), 170);
    setTimeout(() => engine.previewDrum(track, 'closedHat', 0.8), 340);
    return;
  }
  // 试听音高按乐器音域选，不是一个值套所有乐器：
  // 低八度试贝斯（听得清基频），中音区试主音/键盘，
  // 民乐按各自常用音域（古筝/阮偏低，吹管偏高）。
  const root = PREVIEW_ROOT[track.instrument] ?? 60;
  engine.previewNoteOn(track, root, 0.9);
  setTimeout(() => engine.previewNoteOff(track), 640);
}

/**
 * 各乐器的试听音高（MIDI）。
 * 选错的后果不是"不好听"而是"听起来完全不对"：
 * 用 C2(36) 试竹笛只会得到一声极薄的低音，用 C6(84) 试古筝则只剩泛音。
 */
const PREVIEW_ROOT: Record<string, number> = {
  poly: 45,
  fm: 60,
  pluck: 55,     // G3，接近古筝/阮常用音区
  bow: 57,       // A3，二胡内弦常用音区
  wind: 62,      // D4，笛箫常用音区
  yangle: 62,    // D4，扬琴常用音区
};

function drumPartForKey(key: number): string {
  const map: Record<number, string> = {
    36: 'kick', 38: 'snare', 39: 'clap', 42: 'closedHat',
    46: 'openHat', 41: 'tomLow', 45: 'tomMid', 37: 'rim',
  };
  return map[key] ?? 'kick';
}

// ---------- 播放控制 ----------

function togglePlay() {
  if (store.current.playing) stopPlayback();
  else startPlayback();
}

function startPlayback() {
  engine.init();
  const analyser = engine.analyserNode;
  if (analyser) ui.scope.attach(analyser);
  ui.scope.start();
  engine.setMasterVolume(store.current.masterVolume);
  engine.setBpm(store.current.bpm);
  engine.rebuild(store.current);
  engine.setProject(store.current);
  engine.play(store.current, store.current.playhead);

  store.update((d) => { d.playing = true; });
  ui.playBtn.classList.add('is-playing');
  ui.playBtn.replaceChildren(el('div', { class: 'icon-pause' }));
  setStatus('正在播放', true);
}

function stopPlayback() {
  engine.stop();
  ui.scope.stop();
  store.update((d) => { d.playing = false; });
  ui.playBtn.classList.remove('is-playing');
  ui.playBtn.replaceChildren(el('div', { class: 'icon-play' }));
  setStatus('已停止', false);
  refresh();
}

function panic() {
  engine.panic();
  ui.scope.stop();
  stopPlayback();
  toast('已紧急静音', 1400);
}

function doUndo() {
  if (store.undo()) { engine.rebuild(store.current); refreshSelection(); refresh(); toast('已撤销', 1200); }
}

function doRedo() {
  if (store.redo()) { engine.rebuild(store.current); refreshSelection(); refresh(); toast('已重做', 1200); }
}

engine.onProgress = (step) => {
  store.silentUpdate((d) => { d.playhead = step; });
  ui.posValue.textContent = stepToBars(step, store.current.gridSteps);
  stepper.setPlayhead(step);
  updatePlayheadInPiano();
};

engine.onStop = () => {
  store.silentUpdate((d) => { d.playing = false; d.playhead = 0; });
  ui.playBtn.classList.remove('is-playing');
  ui.playBtn.replaceChildren(el('div', { class: 'icon-play' }));
  setStatus('已停止', false);
  refresh();
};

store.subscribe((project) => {
  engine.setProject(project);
});

function updatePlayheadInPiano() {
  const grid = ui.mainBody.querySelector<HTMLElement>('.pr-grid');
  if (!grid) return;
  let marker = grid.querySelector<HTMLElement>('.pr-playhead');
  if (!marker) {
    marker = el('div', { class: 'playhead pr-playhead' });
    grid.append(marker);
  }
  const total = store.current.totalSteps;
  const cellW = parseFloat(grid.style.width) / total;
  marker.style.left = `${store.current.playhead * cellW}px`;
}

// ---------- 文件 ----------

function saveProject() {
  const json = store.serialize();
  const blob = new Blob([json], { type: 'application/json' });
  const name = (store.current.name || '工程').replace(/[\\/:*?"<>|]/g, '_');
  downloadBlob(blob, `${name}.json`);
  toast('工程已保存');
}

function openProject() {
  const input = el('input', { type: 'file', accept: '.json,application/json' }) as HTMLInputElement;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    if (store.deserialize(text)) {
      engine.rebuild(store.current);
      engine.setBpm(store.current.bpm);
      refreshSelection();
      ui.nameInput.value = store.current.name;
      ui.gridSeg.value = String(store.current.gridSteps);
      refresh();
      toast('工程已载入');
    } else {
      toast('文件格式不正确', 2600);
    }
  });
  input.click();
}

function newProject() {
  if (!confirm('确定要新建空白工程吗？当前内容会被清空。')) return;
  stopPlayback();
  store.replaceAll(emptyProject());
  store.commit();
  refreshSelection();
  engine.rebuild(store.current);
  refresh();
  toast('已新建空白工程');
}

function loadDemo() {
  if (!confirm('载入示例工程会覆盖当前内容，继续吗？')) return;
  stopPlayback();
  store.replaceAll(demoProject());
  store.commit();
  refreshSelection();
  engine.rebuild(store.current);
  refresh();
  toast('示例工程已载入，点播放听听看');
}

function openFileMenu() {
  const body = el('div', {});
  body.append(el('p', {
    style: 'margin-bottom:14px',
  }, '工程文件是 .json 格式，保存全部音符与参数；音频导出为 .wav，可直接用播放器打开。'));

  const list = el('div', { style: 'display:grid;gap:8px' });
  const add = (label: string, fn: () => void) => {
    const b = el('button', { class: 'btn', type: 'button' }, label);
    b.addEventListener('click', () => { close(); fn(); });
    list.append(b);
  };
  add('新建空白工程', newProject);
  add('载入示例工程', loadDemo);
  add('保存工程文件', saveProject);
  add('打开工程文件', openProject);
  add('导出音频 WAV', openExportDialog);
  body.append(list);
  const close = modal('文件', body, [{ label: '关闭', onClick: (c) => c() }]);
}

// ---------- 导出 ----------

function openExportDialog() {
  const project = store.current;
  const loopSec = project.totalSteps * (60 / project.bpm / project.gridSteps);

  const body = el('div', {});
  const info = el('div', { style: 'margin-bottom:14px;color:var(--text-mute);line-height:1.9' });
  info.innerHTML =
    `渲染时长约 <strong style="color:var(--text)">${formatDuration(loopSec + 3)}</strong><br>` +
    `（${Math.round(project.totalSteps / (project.gridSteps * 4))} 小节循环 + 3 秒尾音）<br>` +
    `离线渲染会重放全部音符与效果器，通常几秒内完成。`;
  body.append(info);

  const fill = el('div', { class: 'progress-fill', style: 'width:0%' });
  body.append(el('div', { class: 'progress-bar' }, fill));

  let closed = false;
  modal('导出音频', body, [
    { label: '取消', onClick: (c) => { closed = true; c(); } },
    {
      label: '开始导出',
      primary: true,
      onClick: async (c) => {
        try {
          const blob = await exportWav(project, {
            onProgress: (r) => { fill.style.width = `${Math.round(r * 100)}%`; },
          });
          if (closed) return;
          const name = (project.name || '作品').replace(/[\\/:*?"<>|]/g, '_');
          downloadBlob(blob, `${name}.wav`);
          c();
          toast('导出完成，已开始下载');
        } catch (err) {
          console.error(err);
          if (!closed) toast('导出失败：' + String(err), 3200);
        }
      },
    },
  ]);
}

// ---------- 引导 ----------

function showGuide() {
  const body = el('div', {});
  const steps: Array<[string, string]> = [
    ['每行就是一个乐器', '在左侧「乐器」里点任意音色就能加进来。点通道上的 ▶ 按钮可直接试听好不好听。'],
    ['鼓用「步进」，旋律用「钢琴卷帘」', '鼓轨点右边「⋯」进入步进序列器，点格子敲鼓点。旋律轨进钢琴卷帘，在空白处拖动就能画出音符。'],
    ['不会写和弦？用「编曲」页', '选一段和弦进行、选一种编配方式，点「生成」，伴奏骨架就写好了。生成前能看到具体音高，不满意可以 Ctrl+Z 撤销。'],
    ['空格键播放', '顶部橙色按钮或 <kbd>空格</kbd> 都能播放，再按一次停止。'],
    ['电脑键盘能弹琴', '选中一条旋律轨道后，用 <kbd>A</kbd> 到 <kbd>;</kbd> 这排键演奏它。'],
    ['混音让作品变专业', '「混音」页调整每条轨道的音量与声像，通道条上的「混响」「延迟」旋钮能加空间感。'],
    ['声音太薄？叠一层', '「音色」页往下滚，点「+ 叠加一个乐器」。同一个音符会被多个乐器一起演奏，'
      + '这是把声音加厚最直接的办法。示例工程的主音轨已经叠了一层，可以直接播放对比。'],
    ['随时导出', '右上角「导出音频」把作品存成 WAV 文件，可以发给别人听。'],
  ];

  steps.forEach(([title, text], i) => {
    const content = el('div', { class: 'guide-text' });
    content.append(
      el('strong', {}, title),
      el('span', { style: 'display:block' }),
    );
    content.lastElementChild!.innerHTML = text;
    body.append(el('div', { class: 'guide-step' },
      el('div', { class: 'guide-num' }, String(i + 1)), content));
  });

  modal('快速上手', body, [
    { label: '载入示例工程', onClick: (c) => { c(); loadDemo(); } },
    { label: '开始创作', primary: true, onClick: (c) => c() },
  ]);
}

function promptNumber(
  title: string, min: number, max: number, current: number,
  onDone: (v: number) => void,
) {
  const body = el('div', {});
  const input = el('input', {
    type: 'number', class: 'ctrl-select',
    min: String(min), max: String(max), value: String(current),
    style: 'width:100%;padding:8px',
  }) as HTMLInputElement;
  body.append(
    el('div', { style: 'margin-bottom:12px;color:var(--text-mute)' }, `范围 ${min} ~ ${max}`),
    input,
  );
  const close = modal(title, body, [
    { label: '取消', onClick: (c) => c() },
    {
      label: '确定', primary: true,
      onClick: (c) => {
        const v = parseInt(input.value, 10);
        if (!Number.isNaN(v)) onDone(Math.max(min, Math.min(max, v)));
        c();
      },
    },
  ]);
  setTimeout(() => { input.focus(); input.select(); }, 50);
  return close;
}

// ---------- 键盘快捷键 ----------

function bindKeyboard() {
  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') return;

    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
      return;
    }

    if (e.code === 'Escape') {
      panic();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) doRedo(); else doUndo();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveProject();
      return;
    }

    if (e.key >= '1' && e.key <= '8') {
      const tabs: MainTab[] = ['rack', 'step', 'piano', 'harmony', 'record', 'mixer', 'tone', 'fx'];
      switchTab(tabs[parseInt(e.key, 10) - 1]);
      return;
    }

    const key = e.key.toLowerCase();
    if (!e.repeat && KEYBOARD_MAP[key] !== undefined) {
      const track = store.current.tracks.find((t) => t.id === ui.selectedTrackId);
      if (track && track.kind !== 'drum') {
        e.preventDefault();
        const noteKey = 60 + KEYBOARD_MAP[key];
        engine.init();
        engine.previewNoteOn(track, noteKey, 0.85);
        ui.keyboardNotes.set(key, noteKey);
        ui.playingKeys.add(noteKey);
        editor.setPlayingKeys(ui.playingKeys);
      }
    }
  });

  window.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    const noteKey = ui.keyboardNotes.get(key);
    if (noteKey !== undefined) {
      const track = store.current.tracks.find((t) => t.id === ui.selectedTrackId);
      // 传入具体 key：弹和弦时只松开当前键，其他键继续发声。
      if (track) engine.previewNoteOff(track, noteKey);
      ui.keyboardNotes.delete(key);
      ui.playingKeys.delete(noteKey);
      editor.setPlayingKeys(ui.playingKeys);
    }
  });
}

// ============================================================
// 启动
// ============================================================

buildApp();
refresh();
bindKeyboard();

// AudioContext 必须在用户手势中创建（浏览器自动播放策略）
const kickstart = () => {
  engine.init();
  engine.setMasterVolume(store.current.masterVolume);
  engine.setBpm(store.current.bpm);
  engine.rebuild(store.current);
  engine.setProject(store.current);
  const an = engine.analyserNode;
  if (an) ui.scope.attach(an);
  setStatus('音频引擎就绪', true);
  window.removeEventListener('pointerdown', kickstart);
  window.removeEventListener('keydown', kickstart);
};
window.addEventListener('pointerdown', kickstart);
window.addEventListener('keydown', kickstart);

if (!localStorage.getItem('beatforge-guided')) {
  setTimeout(() => {
    localStorage.setItem('beatforge-guided', '1');
    showGuide();
  }, 400);
}