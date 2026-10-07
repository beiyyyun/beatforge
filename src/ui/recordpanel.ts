/**
 * 录音面板
 * ============================================
 * 流程：录音 → 显示波形与识别出的音符 → 调量化强度 → 写入轨道
 *
 * 设计取舍：
 *   - 识别结果必须可视化。用户看不到自己"唱成了什么"，
 *     就无法判断是重录还是接受量化后的结果。
 *   - 提供试听。音高转 MIDI 是有损的，让用户先听一遍再决定。
 *   - 量化强度默认 0.7 而不是 1.0。硬吸附会毁掉演唱的律动弹性，
 *     留一点余量更接近人的演奏。
 */

import { el, slider, dropdown } from './dom';
import { Recorder, type RecordingResult } from '../audio/recorder';
import { analyzeRecording, quantize, type DetectedNote } from '../core/audioAnalysis';
import type { Project, Track } from '../core/types';
import { keyToName } from '../core/constants';

export interface RecordCallbacks {
  /** 把量化后的音符写入轨道 */
  onCommit: (trackId: string, notes: Array<{ key: number; start: number; length: number; velocity: number }>) => void;
  /** 试听识别出的音符序列 */
  onPreview: (trackId: string, notes: Array<{ key: number; start: number; length: number; velocity: number }>) => void;
}

type Status = 'idle' | 'recording' | 'analyzing' | 'ready' | 'error';

export class RecordPanel {
  readonly root: HTMLElement;

  private recorder = new Recorder();
  private trackId: string | null = null;
  private status: Status = 'idle';
  private errorMsg = '';

  private recorded: RecordingResult | null = null;
  private detected: DetectedNote[] = [];
  private strength = 0.7;
  private octaveShift = 'auto';
  private elapsed = 0;
  private level = 0;

  constructor(private cb: RecordCallbacks) {
    this.root = el('div', { class: 'panel' });

    this.recorder.onTick = (s) => {
      this.elapsed = s;
      this.updateTimer();
    };
    this.recorder.onLevel = (v) => {
      this.level = v;
      this.updateMeter();
    };
  }

  setTrack(id: string | null) { this.trackId = id; }

  render(project: Project, selectedTrackId: string | null) {
    if (!this.trackId || !project.tracks.some((t) => t.id === this.trackId)) {
      this.trackId = selectedTrackId;
    }
    const track = project.tracks.find((t) => t.id === this.trackId) ?? null;

    const wrap = el('div', { class: 'rec-wrap' });

    // ---- 左：录音控制 + 波形 ----
    const left = el('div', { class: 'rec-left' });

    if (!Recorder.isSupported()) {
      wrap.append(el('div', { class: 'fx-empty' },
        '当前浏览器不支持麦克风录音。', el('br'),
        '请改用 Chrome、Edge 或 Firefox 的桌面版。'));
      this.root.replaceChildren(wrap);
      return;
    }

    left.append(el('div', { class: 'fx-group-title' }, '第一步 · 录音'));

    // 状态条：录音指示灯 + 计时 + 电平
    const statusBar = el('div', { class: 'rec-status' });
    const dot = el('span', {
      class: `rec-dot${this.status === 'recording' ? ' is-live' : ''}`,
    });
    const timer = el('span', { class: 'rec-timer' }, '0.0s');
    timer.id = 'rec-timer';
    const meterFill = el('div', { class: 'rec-meter-fill' });
    meterFill.id = 'rec-meter';
    const meter = el('div', { class: 'rec-meter' }, meterFill);
    statusBar.append(dot, timer, meter);
    left.append(statusBar);

    // 波形画布
    const canvas = el('canvas', { class: 'rec-canvas' }) as HTMLCanvasElement;
    canvas.width = 720;
    canvas.height = 130;
    left.append(canvas);
    this.drawWaveform(canvas);

    // 控制按钮
    const controls = el('div', { class: 'rec-controls' });

    if (this.status === 'recording') {
      const stopBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '■ 停止并识别');
      stopBtn.addEventListener('click', () => void this.stopAndAnalyze());
      const cancelBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, '取消');
      cancelBtn.addEventListener('click', () => void this.reset());
      controls.append(stopBtn, cancelBtn);
    } else {
      const recBtn = el('button', {
        class: 'btn btn-primary', type: 'button',
        disabled: this.status === 'analyzing' ? 'true' : undefined,
      }, this.status === 'analyzing' ? '正在识别…' : '● 开始录音');
      recBtn.addEventListener('click', () => void this.startRecording());
      controls.append(recBtn);

      if (this.status === 'ready') {
        const again = el('button', { class: 'btn btn-ghost', type: 'button' }, '重录');
        again.addEventListener('click', () => void this.reset());
        controls.append(again);
      }
    }
    left.append(controls);

    if (this.status === 'recording') {
      left.append(el('div', {
        style: 'margin-top:11px;font-size:11.5px;color:var(--text-mute);line-height:1.8',
      },
        '对着麦克风唱或哼。识别范围约两个八度（#B1 ~ G#5），'
        + '所以低音要哼出来而不是用嗓子唱。'));
    }

    if (this.status === 'error') {
      left.append(el('div', { class: 'rec-error' }, this.errorMsg));
    }

    // ---- 右：识别结果 ----
    const right = el('div', { class: 'rec-right' });
    right.append(this.buildResult(project, track));

    wrap.append(left, right);
    this.root.replaceChildren(wrap);
    this.updateTimer();
    this.updateMeter();
  }

  private buildResult(project: Project, track: Track | null): HTMLElement {
    const box = el('div', {});

    if (this.status !== 'ready' || !this.recorded) {
      box.append(el('div', { class: 'fx-group-title' }, '第二步 · 识别结果'));
      box.append(el('div', { class: 'fx-empty', style: 'height:auto;padding:40px 10px' },
        this.status === 'analyzing' ? '正在分析音高…' : '录完一段就会出现这里'));
      return box;
    }

    box.append(el('div', { class: 'fx-group-title' }, '第二步 · 识别结果'));

// 概要
    const n = this.detected.length;
    const summary = el('div', { class: 'rec-summary' });
    summary.append(
      el('div', {}, `识别到 ${n} 个音符`),
      el('div', { style: 'color:var(--text-mute)' },
        n > 0
          ? `音域 ${keyToName(Math.min(...this.detected.map((d) => d.key)))}`
            + ` ~ ${keyToName(Math.max(...this.detected.map((d) => d.key)))}`
            + ` · 时长 ${this.recorded.duration.toFixed(1)}s`
          : `录音时长 ${this.recorded?.duration.toFixed(1)}s，但没找到清晰的音高`),
    );
    box.append(summary);

    if (n === 0) {
      box.append(el('div', {
        style: 'padding:12px 14px;background:var(--bg-2);border-radius:6px;font-size:11.5px;color:var(--text-mute);line-height:1.9',
      },
        '没检测到音符，常见原因：', el('br'),
        '· 离麦克风太远，音量太小', el('br'),
        '· 环境噪音太大 —— 请在安静的地方录', el('br'),
        '· 录的是说话或敲击，不是乐音', el('br'),
        '· 只哼了很短一下，不足一个音长'));
      return box;
    }

    // 音符列表
    const list = el('div', { class: 'rec-notes' });
    for (const d of this.detected.slice(0, 40)) {
      const row = el('div', { class: 'rec-note-row' });
      row.append(
        el('span', { class: 'rec-note-key' }, keyToName(d.key)),
        el('span', { class: 'rec-note-time' }, `${d.start.toFixed(2)}s`),
        el('span', { class: 'rec-note-dur' }, `${(d.end - d.start).toFixed(2)}s`),
        el('span', { class: 'rec-note-vel', title: `力度 ${Math.round(d.velocity * 100)}%` }),
      );
      // 用小竖条表示力度，扫一眼就能看出轻重
      const bar = row.lastElementChild as HTMLElement;
      const fill = el('div', { class: 'rec-note-vel-fill' });
      fill.style.width = `${Math.round(d.velocity * 100)}%`;
      bar.append(fill);
      list.append(row);
    }
    if (this.detected.length > 40) {
      list.append(el('div', {
        style: 'padding:6px 10px;font-size:11px;color:var(--text-mute)',
      }, `…以及另外 ${this.detected.length - 40} 个`));
    }
    box.append(list);

    // ---- 第三步：量化与写入 ----
    box.append(el('div', { class: 'fx-group-title', style: 'margin-top:18px' }, '第三步 · 对齐网格'));

    const secPerStep = 60 / project.bpm / project.gridSteps;
    const stepLabel = `${(secPerStep * 1000).toFixed(0)}ms（${project.bpm} BPM · ${project.gridSteps} 格/拍）`;

    box.append(
      slider({
        label: '量化强度',
        min: 0, max: 1, step: 0.05,
        value: this.strength, unit: '%',
        resetValue: 0.7,
        onInput: (v) => { this.strength = v; this.refreshPreview(project); },
      }),
      el('div', { style: 'font-size:11px;color:var(--text-mute);margin:-4px 0 12px' },
        `网格 ${stepLabel}。强度越低越保留你原本的节奏，越高越严格对齐。`),
      dropdown('音区', [
        { value: 'auto', label: '保持原样' },
        { value: 'c3', label: '整体上移到 C3 为最低音' },
        { value: 'c2', label: '整体下移到 C2 为最低音' },
        { value: 'c4', label: '整体上移到 C4 为最低音' },
        { value: 'none', label: '不移调（保留八度）' },
      ], this.octaveShift, (v) => {
        this.octaveShift = v;
        this.refreshPreview(project);
      }),
    );

    if (this.octaveShift !== 'auto' && this.octaveShift !== 'none' && n > 0) {
      const shifted = shiftPitch(this.detected, this.octaveSemitones());
      box.append(el('div', { style: 'font-size:11px;color:var(--text-mute);margin:-4px 0 10px' },
        `移调后音域变为 ${keyToName(Math.min(...shifted.map((d) => d.key)))}`
        + ` ~ ${keyToName(Math.max(...shifted.map((d) => d.key)))}`));
    }

    // 量化前后对比预览
    const preview = el('div', { class: 'rec-qcompare' });
    preview.id = 'rec-qcompare';
    box.append(preview);

    const actions = el('div', { class: 'rec-actions' });
    const playBtn = el('button', { class: 'btn', type: 'button' }, '▶ 试听');
    playBtn.addEventListener('click', () => {
      const t = this.resolveTrack(project);
      if (!t) return;
      this.cb.onPreview(t.id, this.quantized(project));
    });

    const writeBtn = el('button', {
      class: 'btn btn-primary', type: 'button', style: 'flex:1',
      disabled: track ? undefined : 'true',
    }, track ? `写入「${track.name}」` : '先选一条旋律轨道');
    writeBtn.addEventListener('click', () => {
      const t = this.resolveTrack(project);
      if (!t) return;
      this.cb.onCommit(t.id, this.quantized(project));
    });

    actions.append(playBtn, writeBtn);
    box.append(actions);

    if (track) {
      const existing = project.notes.filter((x) => x.trackId === track.id).length;
      if (existing > 0) {
        box.append(el('div', { style: 'margin-top:9px;font-size:11px;color:var(--text-mute)' },
          `「${track.name}」已有 ${existing} 个音符，写入会覆盖它们。`));
      }
    }

    return box;
  }

  /** 量化到当前工程的网格，并按需移调 */
  private quantized(project: Project) {
    const secPerStep = 60 / project.bpm / project.gridSteps;
    // 先移调：音高会影响用户对"这是不是我想录的东西"的判断，必须在量化前定下来
    let notes = this.detected;
    const shift = this.octaveSemitones();
    if (shift !== 0) notes = shiftPitch(notes, shift);
    const q = quantize(notes, { stepSeconds: secPerStep, strength: this.strength });
    return q
      .map((n) => ({ ...n, start: Math.round(n.start / secPerStep) }))
      // 移调后可能超出 MIDI 范围，丢弃而不是夹紧
      // （夹紧会产生大量同音高的音符，听感上是"卡住"）
      .filter((n) => n.key >= 0 && n.key <= 127);
  }

  /** 把音区选项翻译成要移动的半音数 */
  private octaveSemitones(): number {
    switch (this.octaveShift) {
      case 'c2': {
        // 让最低音落在 C2 (=36)。若原本就比 C2 高，则上移到刚好 C2
        const low = Math.min(...this.detected.map((d) => d.key));
        return low > 36 ? 36 - low : 0;
      }
      case 'c3': {
        const low = Math.min(...this.detected.map((d) => d.key));
        return low > 48 ? 48 - low : 0;
      }
      case 'c4': {
        const low = Math.min(...this.detected.map((d) => d.key));
        return low > 60 ? 60 - low : 0;
      }
      default: return 0;   // auto / none 都保持原样
    }
  }

  private resolveTrack(project: Project): Track | null {
    const id = this.trackId;
    if (!id) return null;
    const t = project.tracks.find((x) => x.id === id);
    return t && t.kind === 'melodic' ? t : null;
  }

  private refreshPreview(project: Project) {
    const host = this.root.querySelector<HTMLElement>('#rec-qcompare');
    if (!host) return;
    const secPerStep = 60 / project.bpm / project.gridSteps;
    const shift = this.detected.length ? this.octaveSemitones() : 0;

    const rows: string[] = [];
    for (const d of this.detected.slice(0, 12)) {
      const snapped = Math.round(d.start / secPerStep) * secPerStep;
      const moved = this.strength * (snapped - d.start);
      const finalStart = Math.round((d.start + moved) / secPerStep);
      const keyText = shift !== 0
        ? `${keyToName(d.key)}→${keyToName(d.key + shift)}`
        : keyToName(d.key);
      rows.push(
        `<div class="rec-qrow">`
        + `<span class="rec-note-key">${keyText}</span>`
        + `<span class="rec-note-time">${d.start.toFixed(3)}s</span>`
        + `<span style="color:var(--text-mute)">→</span>`
        + `<span class="rec-note-time" style="color:var(--accent)">第 ${finalStart + 1} 格</span>`
        + `<span class="rec-qshift">${moved >= 0 ? '+' : ''}${(moved * 1000).toFixed(0)}ms</span>`
        + `</div>`,
      );
    }
    host.innerHTML = this.detected.length
      ? `<div class="rec-note-row" style="border-bottom:1px solid var(--line)">`
        + `<span class="rec-note-key">音高</span>`
        + `<span class="rec-note-time">原始时间</span><span></span>`
        + `<span class="rec-note-time">量化后</span>`
        + `<span class="rec-qshift">位移</span></div>${rows.join('')}`
      : '';
  }

  /** 画波形：静音时画基线，录完画实际波形 */
  private drawWaveform(canvas: HTMLCanvasElement) {
    const g = canvas.getContext('2d');
    if (!g) return;
    const w = canvas.width;
    const h = canvas.height;
    const mid = h / 2;

    g.clearRect(0, 0, w, h);
    g.fillStyle = '#14161a';
    g.fillRect(0, 0, w, h);

    const samples = this.recorded?.samples;
    if (!samples || samples.length === 0) {
      g.strokeStyle = '#3a3f47';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, mid);
      g.lineTo(w, mid);
      g.stroke();
      g.fillStyle = '#5a6069';
      g.font = '12px system-ui';
      g.textAlign = 'center';
      g.fillText(this.status === 'recording' ? '录音中…' : '波形将显示在这里', w / 2, mid - 12);
      return;
    }

    // 包络：每列取该列的最大绝对值，比逐点画更清晰也更快
    g.strokeStyle = '#ff8c3a';
    g.lineWidth = 1;
    g.beginPath();
    const cols = Math.floor(w / 2);
    const per = Math.max(1, Math.floor(samples.length / cols));
    for (let c = 0; c < cols; c++) {
      let peak = 0;
      const start = c * per;
      for (let i = start; i < start + per && i < samples.length; i++) {
        const a = Math.abs(samples[i]);
        if (a > peak) peak = a;
      }
      const y = peak * (mid - 6);
      const x = c * 2 + 1;
      g.moveTo(x, mid - y);
      g.lineTo(x, mid + y);
    }
    g.stroke();

    // 叠加音符位置（红点），让用户看到识别结果落在哪
    const dur = this.recorded!.duration || 1;
    for (const n of this.detected) {
      const x = (n.start / dur) * w;
      g.fillStyle = '#3ecf8e';
      g.fillRect(x - 1, 0, 2, 7);
    }
  }

  private updateTimer() {
    const node = this.root.querySelector<HTMLElement>('#rec-timer');
    if (node) node.textContent = `${this.elapsed.toFixed(1)}s`;
  }

  private updateMeter() {
    const node = this.root.querySelector<HTMLElement>('#rec-meter');
    if (node) node.style.width = `${Math.round(this.level * 100)}%`;
  }

  // ---------- 状态流转 ----------

  private async startRecording() {
    this.status = 'idle';
    try {
      await this.recorder.start();
      this.status = 'recording';
      this.elapsed = 0;
      this.level = 0;
    } catch (err) {
      this.status = 'error';
      const name = (err as { name?: string })?.name ?? '';
      this.errorMsg = name === 'NotAllowedError'
        ? '麦克风权限被拒绝。请在浏览器地址栏的权限图标里允许麦克风，然后重试。'
        : name === 'NotFoundError'
          ? '没有找到麦克风设备。'
          : `无法开始录音：${String(err)}`;
      console.error(err);
    }
    this.onChange();
  }

  private async stopAndAnalyze() {
    this.status = 'analyzing';
    this.onChange();

    try {
      // 让 UI 先画出"正在识别"，再做同步计算
      await new Promise((r) => setTimeout(r, 30));
      const result = await this.recorder.stop();
      if (!result) {
        this.status = 'error';
        this.errorMsg = '没有录到声音，可能是麦克风没有工作。检查一下系统音量与静音开关。';
        this.onChange();
        return;
      }
      this.recorded = result;
      const analysis = analyzeRecording(result.samples, result.sampleRate);
      this.detected = analysis.notes;
      this.status = 'ready';
    } catch (err) {
      this.status = 'error';
      this.errorMsg = `分析失败：${String(err)}`;
      console.error(err);
    }
    this.onChange();
  }

  private async reset() {
    await this.recorder.cancel();
    this.status = 'idle';
    this.recorded = null;
    this.detected = [];
    this.elapsed = 0;
    this.level = 0;
    this.errorMsg = '';
    this.onChange();
  }

  /** 状态变化后请求重绘。由 main.ts 注入 */
  onChange: (() => void) | null = null;
}

/** 把识别出的音符整体移调。semitones 为 0 时原样返回新数组 */
function shiftPitch(notes: DetectedNote[], semitones: number): DetectedNote[] {
  if (semitones === 0) return notes.map((d) => ({ ...d }));
  return notes.map((d) => ({ ...d, key: d.key + semitones }));
}