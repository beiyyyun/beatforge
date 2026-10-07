/**
 * 离线渲染与音频导出
 * ============================================
 * 用 OfflineAudioContext 以 4 倍速渲染，比实时录制更快更干净，
 * 然后编码成 16bit PCM WAV / MP3(若浏览器支持)。
 */

import type { Project } from '../core/types';
import { createInstrument, withDefaults, getInstrumentDef } from './registry';
import type { InstrumentEngine } from './registry';
import { prepareInstrumentsFor } from './register';
import { ReverbBus, DelayBus, MasterBus, buildInsert } from './fx';
import { DEFAULT_DRUM_LAYOUT } from '../core/constants';

/** WAV 文件头 */
function encodeWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const bufferSize = 44 + dataSize;

  const arrayBuffer = new ArrayBuffer(bufferSize);
  const view = new DataView(arrayBuffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  // RIFF 头
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);       // fmt chunk 大小
  view.setUint16(20, 1, true);        // PCM 格式
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);       // 位深
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  // 采样数据：多声道交错
  const channels: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) channels.push(buffer.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const sample = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

/** 单次离线渲染：把所有声音按时间排入 offline context */
async function renderProject(
  project: Project,
  sampleRate: number,
  durationSeconds: number,
): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.ceil(sampleRate * durationSeconds), sampleRate);

  // 拨弦/击弦依赖 AudioWorklet，离线路径必须显式等待。
  // 实时路径靠引擎内部的补发队列能兜住，离线不行 ——
  // 离线渲染是一口气同步跑完的，await 不到就是静音。
  const types = new Set<string>();
  for (const t of project.tracks) {
    types.add(t.instrument);
    for (const l of t.layers ?? []) types.add(l.instrument);
  }
  await prepareInstrumentsFor(ctx, types);

  const master = new MasterBus(ctx, ctx.destination);
  master.setVolume(project.masterVolume);
  const reverb = new ReverbBus(ctx, master.node);
  const delay = new DelayBus(ctx, master.node);
  delay.setTime(60 / project.bpm / 2, 0.42);

  // 判断可听性
  const anySolo = project.tracks.some((t) => t.solo);
  const audible = (t: Project['tracks'][number]) => {
    if (t.muted) return false;
    if (anySolo && !t.solo) return false;
    return true;
  };

  // 建立每条轨道的链路
  const infos = project.tracks.map((track) => {
    const input = ctx.createGain();
    const volume = ctx.createGain();
    const pan = ctx.createStereoPanner();
    const rSend = ctx.createGain();
    const dSend = ctx.createGain();
    let tail: AudioNode = input;
    if (track.insert && track.insert.enabled) {
      const chain = buildInsert(ctx, track.insert);
      tail.connect(chain.input);
      tail = chain.output;
    }
    tail.connect(volume);
    volume.connect(pan);
    pan.connect(master.node);
    pan.connect(rSend);
    rSend.connect(reverb.node);
    pan.connect(dSend);
    dSend.connect(delay.node);
    volume.gain.value = track.volume;
    pan.pan.value = track.pan;
    rSend.gain.value = track.sendReverb;
    dSend.gain.value = track.sendDelay;

    // 叠加层：与实时引擎保持同一拓扑（汇入 input，在效果器之前）
    const layers = (track.kind === 'drum' ? [] : (track.layers ?? []))
      .filter((l) => !l.muted)
      .map((layer) => {
        const lGain = ctx.createGain();
        const lPan = ctx.createStereoPanner();
        const lRev = ctx.createGain();
        const lDel = ctx.createGain();
        lGain.connect(lPan);
        lPan.connect(input);
        lPan.connect(lRev);
        lRev.connect(reverb.node);
        lPan.connect(lDel);
        lDel.connect(delay.node);
        lGain.gain.value = layer.volume;
        lPan.pan.value = layer.pan;
        lRev.gain.value = layer.sendReverb;
        lDel.gain.value = layer.sendDelay;
        const params = withDefaults(getInstrumentDef(layer.instrument), layer.params);
        const synth = createInstrument(layer.instrument, ctx, lGain);
        return { layer, synth, params };
      });

    const params = withDefaults(getInstrumentDef(track.instrument), track.params);
    const synth = createInstrument(track.instrument, ctx, input);
    return { track, input, params, synth, audible: audible(track), layers };
  });

  const secPerStep = 60 / project.bpm / project.gridSteps;

  // 铺开音符事件
  for (const note of project.notes) {
    const info = infos.find((i) => i.track.id === note.trackId);
    if (!info || !info.audible || info.track.kind === 'drum') continue;
    if (!info.synth) continue;              // 未注册的乐器类型，跳过
    const time = note.start * secPerStep;
    info.synth.noteOn(note.key, time, note.velocity, info.params, note.id);
    for (const { layer, synth, params } of info.layers) {
      if (!synth) continue;
      const key = note.key + layer.semitone + layer.octave * 12;
      if (key < 0 || key > 127) continue;
      const g = layer.octave < 0 ? 0.8 : 0.72;
      synth.noteOn(key, time, note.velocity * g, params, `${note.id}@${layer.id}`);
    }
  }

  // 鼓组步进：row.steps 长度 = 鼓件数 × 步数，前 totalSteps 段为鼓件 0…7
  for (const info of infos) {
    if (info.track.kind !== 'drum' || !info.audible) continue;
    if (!info.synth?.trigger) continue;      // 能力检测，不写死 DrumMachine
    const row = project.steps[info.track.id];
    if (!row) continue;
    const layout = row.layout ?? DEFAULT_DRUM_LAYOUT;
    const total = project.totalSteps;
    for (let part = 0; part < layout.length; part++) {
      const params = info.params[layout[part]];
      if (!params) continue;
      // 该鼓件的数据从 part * total 开始
      for (let step = 0; step < total; step++) {
        const v = row.steps[part * total + step];
        if (!v || v <= 0.001) continue;
        info.synth.trigger(layout[part], step * secPerStep, v, params);
      }
    }
  }

  return ctx.startRendering();
}

export interface RenderOptions {
  /** 导出多少小节（含尾奏） */
  bars?: number;
  /** 尾部延音秒数 */
  tailSeconds?: number;
  sampleRate?: number;
  onProgress?: (ratio: number) => void;
}

/** 导出 WAV */
export async function exportWav(
  project: Project,
  opts: RenderOptions = {},
): Promise<Blob> {
  const bars = opts.bars ?? Math.round(project.totalSteps / project.gridSteps);
  const tail = opts.tailSeconds ?? 3;
  const sampleRate = opts.sampleRate ?? 44100;

  const secPerStep = 60 / project.bpm / project.gridSteps;
  const loopSeconds = project.totalSteps * secPerStep;
  const duration = loopSeconds + tail;

  opts.onProgress?.(0.1);
  const buffer = await renderProject(project, sampleRate, duration);
  opts.onProgress?.(0.9);

  const blob = encodeWav(buffer);
  opts.onProgress?.(1);
  return blob;
}

/** 触发浏览器下载 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}