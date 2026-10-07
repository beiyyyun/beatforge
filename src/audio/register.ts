/**
 * 乐器注册
 * ============================================
 * 这是整个模块化架构里唯一"需要为新乐器写代码"的地方。
 *
 * 加一种新乐器（比如中提琴、唢呐低八度、锣）：
 *   1. 在自己的文件里实现 InstrumentEngine 接口
 *   2. 在这里加一条 registerInstrument({ type, label, factory, defaultParams })
 * engine.ts / export.ts / editor.ts / layers.ts 一行都不用改。
 *
 * 另一个用途：工程文件兼容。
 * 老工程里写了 "instrument": "bow"，当前版本认识 → 正常加载；
 * 写了不认识的（比如用户装了更高版本）→ isInstrumentKnown 返回 false，
 * 界面给提示，而不是静默哑掉。
 */

import { registerInstrument } from './registry';
import { PolySynth, FMSynth, DrumMachine } from './synth';
import {
  PluckSynth, BowSynth, WindSynth, YangleSynth,
  PLUCK_DEFAULTS, BOW_DEFAULTS, WIND_DEFAULTS, YANGLE_DEFAULTS,
  preparePluck,
} from './folk';
import { DEFAULT_DRUM_KIT } from './drum-defaults';

/**
 * 把所有内置乐器注册进注册表。
 *
 * 幂等：重复调用只会覆盖同名条目（registerInstrument 的既定行为），
 * 所以模块被多处 import 也不会出问题。
 */
export function registerAllInstruments(): void {
  registerInstrument({
    type: 'poly',
    label: '复音合成器',
    factory: (ctx, dest) => new PolySynth(ctx, dest),
    trackKind: 'melodic',
    defaultParams: {
      osc1: { wave: 'sawtooth', detune: 0, level: 0.7 },
      osc2: { wave: 'square', detune: 7, level: 0.35 },
      subLevel: 0.2,
      noiseLevel: 0,
      unison: 1,
      env: { attack: 0.01, decay: 0.25, sustain: 0.65, release: 0.3 },
      filter: { type: 'lowpass', cutoff: 2400, resonance: 4, envAmount: 0.5 },
      filterEnv: { attack: 0.005, decay: 0.2, sustain: 0.3, release: 0.2 },
      portamento: 0,
      glide: false,
      voices: 12,
    },
  });

  registerInstrument({
    type: 'fm',
    label: 'FM 合成器',
    factory: (ctx, dest) => new FMSynth(ctx, dest),
    trackKind: 'melodic',
    defaultParams: {
      ratio: 2,
      index: 3,
      algorithm: 'sine',
      feedback: 0,
      env: { attack: 0.005, decay: 1.2, sustain: 0.35, release: 0.6 },
      modEnv: { attack: 0.002, decay: 0.35, sustain: 0.25, release: 0.3 },
      filter: { type: 'lowpass', cutoff: 5200, resonance: 1.2, envAmount: 0 },
    },
  });

  registerInstrument({
    type: 'drum',
    label: '鼓组',
    factory: (ctx, dest) => new DrumMachine(ctx, dest),
    trackKind: 'drum',
    // 鼓件的默认值必须与 DEFAULT_DRUM_KIT 一致 —— 新建工程和旧工程补全共用它
    defaultParams: DEFAULT_DRUM_KIT,
    percussive: true,
  });

  registerInstrument({
    type: 'pluck',
    label: '拨弦',
    factory: (ctx, dest) => new PluckSynth(ctx, dest),
    trackKind: 'melodic',
    defaultParams: { ...PLUCK_DEFAULTS },
    percussive: true,
  });

  registerInstrument({
    type: 'bow',
    label: '拉弦',
    factory: (ctx, dest) => new BowSynth(ctx, dest),
    trackKind: 'melodic',
    defaultParams: { ...BOW_DEFAULTS },
  });

  registerInstrument({
    type: 'wind',
    label: '吹管',
    factory: (ctx, dest) => new WindSynth(ctx, dest),
    trackKind: 'melodic',
    defaultParams: { ...WIND_DEFAULTS },
  });

  registerInstrument({
    type: 'yangle',
    label: '击弦',
    factory: (ctx, dest) => new YangleSynth(ctx, dest),
    trackKind: 'melodic',
    defaultParams: { ...YANGLE_DEFAULTS },
    percussive: true,
  });
}

/**
 * 等待所有需要异步初始化的引擎就绪。
 *
 * 目前只有拨弦/击弦需要：它们依赖 AudioWorklet 模块加载完成才能建节点。
 * 不 await 就直接 noteOn，首个音符会被暂存并补发 —— 但离线导出路径
 * 是一口气同步渲染的，补发机制在离线下不生效，必须显式等待。
 */
export async function prepareInstrumentsFor(
  ctx: BaseAudioContext,
  types: Iterable<string>,
): Promise<void> {
  const tasks: Promise<void>[] = [];
  for (const t of types) {
    if (t === 'pluck' || t === 'yangle') tasks.push(preparePluck(ctx));
  }
  if (tasks.length > 0) await Promise.all(tasks);
}

/** 模块加载即注册 —— 任何 import 本模块的地方都自动获得全部内置乐器 */
registerAllInstruments();