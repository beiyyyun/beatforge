/**
 * 麦克风录音
 * ============================================
 * 用 Web Audio 的 ScriptProcessor 不合时宜（已废弃），
 * 但 MediaRecorder 只能拿到压缩音频、无法直接读原始采样，
 * 所以这里走 getUserMedia → AudioWorklet 的现代路径。
 *
 * 兼容性考量：AudioWorklet 需要加载一个独立 JS 文件，
 * 而 Vite 打包后它的路径会变。因此这里用 URL.createObjectURL
 * 从内联字符串生成 worklet 模块，避开路径问题。
 *
 * 降级策略：若 AudioWorklet 不可用（如部分旧浏览器），
 * 退回 ScriptProcessorNode。它已废弃但仍被广泛支持，
 * 且本项目只在录音期间使用，废弃带来的风险可控。
 */

import { decimate } from '../core/audioAnalysis';

/** 录音结果 */
export interface RecordingResult {
  /** 下混为单声道并降采样后的 PCM */
  samples: Float32Array;
  sampleRate: number;
  /** 原始时长（秒） */
  duration: number;
}

/**
 * 内联的 AudioWorklet 源码。
 * 只做一件事：把输入声道复制到输出，
 * 同时累积到 processor.port 之外——worklet 里没有全局状态可依赖，
 * 所以用一个 MessagePort 把每块数据发回主线程。
 */
const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      // 下混为单声道：多声道取平均，避免相位抵消
      const len = input[0].length;
      const mono = new Float32Array(len);
      for (let c = 0; c < input.length; c++) {
        const ch = input[c];
        for (let i = 0; i < len; i++) mono[i] += ch[i];
      }
      for (let i = 0; i < len; i++) mono[i] /= input.length;
      this.port.postMessage(mono, [mono.buffer]);
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
`;

const TARGET_RATE = 22050;

export class Recorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioNode | null = null;
  private analyser: AnalyserNode | null = null;
  private chunks: Float32Array[] = [];
  private workletReady = false;

  private startTime = 0;
  /** 音量轮询句柄 */
  private meterTimer: number | null = null;
  private meterBuf = new Float32Array(1024);

  /** 录音过程中每秒触发一次，用于 UI 显示时长 */
  onTick: ((seconds: number) => void) | null = null;
  /** 输入音量 0~1，用于 UI 显示电平 */
  onLevel: ((level: number) => void) | null = null;

  get recording() { return this.stream !== null; }

  /** 申请麦克风权限并开始录音 */
  async start(): Promise<void> {
    if (this.stream) throw new Error('已经在录音了');

    // 关闭自动增益与降噪：AGC 会改变音量包络，让力度全部顶到最大；
    // 降噪会削掉起音的噪声成分，起音点检测会失效。
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });

    this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.chunks = [];
    this.workletReady = false;

    // 独立分析支路：只测电平，不参与捕获，避免污染数据
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.source.connect(this.analyser);

    try {
      await this.attachWorklet();
    } catch {
      this.attachScriptProcessorFallback();
    }

    this.startTime = performance.now();
    this.startMeter();
  }

  /** 每 100ms 报一次时长与电平。100ms 对 UI 足够快，也够省电 */
  private startMeter() {
    this.stopMeter();
    const readLevel = () => {
      if (!this.analyser || !this.ctx) return;
      this.analyser.getFloatTimeDomainData(this.meterBuf);
      let sum = 0;
      for (let i = 0; i < this.meterBuf.length; i++) {
        sum += this.meterBuf[i] * this.meterBuf[i];
      }
      const rms = Math.sqrt(sum / this.meterBuf.length);
      // 开方后压到 0~1，让小幅说话也能推动电平条
      this.onLevel?.(Math.min(1, Math.sqrt(rms * 3)));
    };
    this.meterTimer = window.setInterval(() => {
      readLevel();
      this.onTick?.((performance.now() - this.startTime) / 1000);
    }, 100);
  }

  private stopMeter() {
    if (this.meterTimer !== null) {
      clearInterval(this.meterTimer);
      this.meterTimer = null;
    }
  }

  private async attachWorklet() {
    if (!this.ctx || !this.source) throw new Error('未初始化');
    const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await this.ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    const node = new AudioWorkletNode(this.ctx, 'capture-processor');
    node.port.onmessage = (e: MessageEvent) => {
      this.chunks.push(e.data as Float32Array);
    };
    // 必须连到 destination，否则部分浏览器不会真正驱动 worklet 的 process()
    node.connect(this.ctx.destination);
    this.source.connect(node);
    this.node = node;
    this.workletReady = true;
  }

  private attachScriptProcessorFallback() {
    if (!this.ctx || !this.source) throw new Error('未初始化');
    const size = 4096;
    const proc = this.ctx.createScriptProcessor(size, 1, 1);
    proc.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(input));
    };
    this.source.connect(proc);
    proc.connect(this.ctx.destination);
    this.node = proc;
  }

  /** 停止录音并返回 PCM 数据 */
  async stop(): Promise<RecordingResult | null> {
    const ctx = this.ctx;
    if (!this.stream || !ctx) return null;

    this.stopMeter();
    const duration = (performance.now() - this.startTime) / 1000;

    // 断开并释放资源。顺序很重要：先断开 node，
    // 否则 onaudioprocess / port.onmessage 还可能收到尾部数据块。
    try { this.node?.disconnect(); } catch { /* noop */ }
    try { this.source?.disconnect(); } catch { /* noop */ }
    try { this.analyser?.disconnect(); } catch { /* noop */ }
    if ('onaudioprocess' in (this.node ?? {})) {
      (this.node as ScriptProcessorNode).onaudioprocess = null;
    }
    for (const t of this.stream.getTracks()) t.stop();
    await ctx.close();

    this.stream = null;
    this.ctx = null;
    this.source = null;
    this.node = null;
    this.analyser = null;

    // 拼接所有数据块
    const total = this.chunks.reduce((sum, c) => sum + c.length, 0);
    const raw = new Float32Array(total);
    let off = 0;
    for (const c of this.chunks) { raw.set(c, off); off += c.length; }
    this.chunks = [];

    if (total === 0) return null;

    // 降采样到分析友好的采样率
    const { data, sampleRate } = decimate(raw, ctx.sampleRate, TARGET_RATE);
    return { samples: data, sampleRate, duration };
  }

  /** 主动取消，丢弃已录内容 */
  async cancel(): Promise<void> {
    if (!this.stream) return;
    this.chunks = [];
    await this.stop();
  }

  /** 检测浏览器是否支持录音 */
  static isSupported(): boolean {
    return typeof navigator !== 'undefined'
      && !!navigator.mediaDevices?.getUserMedia
      && typeof AudioContext !== 'undefined';
  }
}