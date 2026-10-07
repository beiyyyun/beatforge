/**
 * 波形与频谱可视化
 * ============================================
 * 两类视图：
 *  - 实时波形：播放时逐帧绘制，像示波器
 *  - 频谱：柱状图，帮助判断音色明暗
 *
 * 性能要点：只在播放时启动 rAF，停止时取消，避免空转耗电。
 */

import { el } from './dom';

export class ScopeView {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private data: Uint8Array<ArrayBuffer>;
  private raf = 0;
  private analyser: AnalyserNode | null = null;
  private running = false;

  constructor(private mode: 'wave' | 'spectrum' = 'wave') {
    this.root = el('div', {
      class: 'scope',
      style: 'height:76px;background:var(--bg-0);border:1px solid var(--line);' +
        'border-radius:var(--radius);overflow:hidden;position:relative',
    });
    this.canvas = el('canvas', {
      style: 'display:block;width:100%;height:100%',
    }) as HTMLCanvasElement;
    this.root.append(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.data = new Uint8Array(new ArrayBuffer(2048));

    // 尺寸随容器变化
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(this.root);
  }

  private resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.root.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** 切换显示模式 */
  setMode(mode: 'wave' | 'spectrum') {
    if (this.mode === mode) return;
    this.mode = mode;
    this.resize();
    if (this.running) this.draw();
  }

  /** 绑定分析节点 */
  attach(analyser: AnalyserNode) {
    this.analyser = analyser;
    this.resize();
    if (!this.running) this.clear();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.resize();
    const loop = () => {
      if (!this.running) return;
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.clear();
  }

  /** 空闲时显示一条静态基线，避免看起来像坏了 */
  clear() {
    const ctx = this.ctx;
    if (!ctx) return;
    const rect = this.root.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.strokeStyle = 'rgba(107,116,132,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const y = rect.height / 2;
    ctx.moveTo(0, y);
    ctx.lineTo(rect.width, y);
    ctx.stroke();
  }

  private draw() {
    const ctx = this.ctx;
    if (!ctx || !this.analyser) return;
    const rect = this.root.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    ctx.clearRect(0, 0, w, h);

    if (this.mode === 'wave') {
      this.analyser.getByteTimeDomainData(this.data);
      ctx.strokeStyle = '#ff8c3a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const step = this.data.length / w;
      for (let i = 0; i < w; i++) {
        const v = this.data[Math.floor(i * step)] / 128 - 1;
        const y = h / 2 + v * (h / 2 - 2);
        if (i === 0) ctx.moveTo(i, y);
        else ctx.lineTo(i, y);
      }
      ctx.stroke();
      // 中线
      ctx.strokeStyle = 'rgba(107,116,132,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
    } else {
      this.analyser.getByteFrequencyData(this.data);
      const bars = 48;
      const bw = w / bars;
      const g = ctx.createLinearGradient(0, h, 0, 0);
      g.addColorStop(0, '#4a9eff');
      g.addColorStop(0.6, '#3ecf8e');
      g.addColorStop(1, '#ff8c3a');
      ctx.fillStyle = g;
      const step = Math.floor(this.data.length / bars);
      for (let i = 0; i < bars; i++) {
        // 取该区间的最大值，避免细条闪烁
        let peak = 0;
        for (let j = 0; j < step; j++) peak = Math.max(peak, this.data[i * step + j]);
        const bh = (peak / 255) * (h - 4);
        ctx.fillRect(i * bw + 1, h - bh - 2, bw - 2, bh);
      }
    }
  }
}

/** 播放头经过时高亮当前音符的装饰层 */
export class PlayheadHighlighter {
  private marker: HTMLElement | null = null;

  constructor(private container: HTMLElement) {}

  update(step: number, cellWidth: number, totalSteps: number) {
    if (!this.marker) {
      this.marker = el('div', { class: 'playhead' });
      this.container.append(this.marker);
    }
    this.marker.style.left = `${step * cellWidth}px`;
  }

  destroy() {
    this.marker?.remove();
    this.marker = null;
  }
}