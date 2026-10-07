/**
 * 乐器引擎接口与注册表
 * ============================================
 * 为什么要有这一层：早先engine.ts 里直接写
 *   if (track.instrument === 'fm') ... else new PolySynth(...)
 * 每加一种乐器就要去engine.ts / export.ts / editor.ts / layers.ts
 * 四处加分支，加到第五种时已经是一堆 if-else，加到第十种必然失控。
 *
 * 改成注册表后，加乐器只需两步：
 *   1. 实现 InstrumentEngine 接口
 *   2. registerInstrument('pluck', { factory, label, ... })
 * 调用方（engine / export / editor / layers）一行都不用改。
 *
 * 另一个目的是工程文件兼容：新增乐器类型时，老工程反序列化能识别
 * 并给出可读提示，而不是静默变成一条哑轨。
 */

/**
 * 乐器参数对象 —— 对注册表来说是不透明的口袋。
 *
 * 刻意用 `object` 而不是 `Record<string, unknown>`：
 * 后者要求带索引签名，而 TS 的 interface 不允许隐式索引签名，
 * 于是 `params as PolySynthParams` 之类的转换全部报错
 * （"neither type sufficiently overlaps with the other"）。
 * 语义上注册表本来就不关心参数长什么样，由各引擎自己解释，
 * `object` 表达的正是这一点。需要按字段读取时在引擎内部转成
 * Record<string, unknown> 即可。
 */
export type AnyParams = object;

/** 需要按字段读取时的便捷视图 */
export type ParamsView = Record<string, unknown>;

/**
 * 统一乐器接口。
 *
 * 设计取舍：noteOn 收key（MIDI 音高）而不是 Hz，因为所有乐器都以音高为输入，
 * 各引擎内部自行换算频率（拨弦要用周期采样数、气声要用共振峰）。
 */
export interface InstrumentEngine {
  /** 该引擎对应的乐器类型标识 */
  readonly type: string;

  /**
   * 触发一个音符。
   * @param key MIDI 音高，60=C4
   * @param time AudioContext 时间轴上的起音时刻（前瞻式调度会提前排入）
   * @param velocity 力度 0~1
   * @param params 乐器参数
   * @param noteId 音符标识。持续类乐器需要它把"松开"对应回这一条声部；
   *              一击即发（拨弦、打击）的乐器可以忽略。
   */
  noteOn(key: number, time: number, velocity: number, params: AnyParams, noteId?: string): void;

  /** 松开某个音符。打击类乐器可留空实现。 */
  noteOff?(noteId: string, time: number): void;

  /**
   * 立即释放所有发声中的音符（停止播放、切换工程时用）。
   *
   * 早先FMSynth.releaseAll 需要额外传 params、PolySynth 不需要，
   * 调用方只能写 if-else 分支。统一成带 params 的单一签名。
   */
  releaseAll(time: number, params: AnyParams): void;

  /**
   * 立即掐断一切发声（"停止"按钮 / panic 用）。
   *
   * 为什么与 releaseAll 分开：拨弦/击弦类乐器的 releaseAll 只清理过期声部，
   * 保留还在自然衰减中的——因为正常演奏不该切断余音。
   * 但用户点了"停止"，期望的是立刻安静，此时必须真正掐断。
   * 持续音类乐器两者等价，不实现此方法即可。
   */
  panic?(): void;

  /** 参数被用户改动后同步到正在发声的声部（可选实现） */
  setParams?(params: AnyParams): void;

  /** 触发鼓件。仅鼓组类引擎实现 */
  trigger?(part: string, time: number, velocity: number, params: AnyParams): void;

  /** 触发步进的一整排鼓。仅鼓组类引擎实现 */
  triggerStep?(
    layout: string[],
    velocities: number[],
    time: number,
    params: AnyParams,
  ): void;

  /** 销毁，释放占用的节点 */
  dispose?(): void;
}

/** 注册一项乐器 */
export interface InstrumentDef {
  /** 唯一类型标识，存进工程文件，务必稳定不要随意改名 */
  type: string;
  /** UI 显示名 */
  label: string;
  /** 构造引擎实例 */
  factory: (ctx: BaseAudioContext, dest: AudioNode) => InstrumentEngine;
  /** 轨道类型 */
  trackKind: 'melodic' | 'drum';
  /** 参数默认值，新建轨道/加载旧预设时用来补全缺失字段 */
  defaultParams: AnyParams;
  /**
   * 是否为打击类（无延音）。UI 决定是否画延音条、是否需要"松开"事件。
   * 不填视为false。
   */
  percussive?: boolean;
}

const registry = new Map<string, InstrumentDef>();

/**
 * 注册乐器。
 *
 * 同名重复注册会覆盖旧的 —— 这是刻意的：开发时热重载需要能替换实现，
 * 而生产环境重复注册本就不该发生，静默失败反而更难排查。
 */
export function registerInstrument(def: InstrumentDef): void {
  registry.set(def.type, def);
}

export function getInstrumentDef(type: string): InstrumentDef | undefined {
  return registry.get(type);
}

export function getAllInstruments(): InstrumentDef[] {
  return [...registry.values()];
}

/** 已注册的乐器类型标识列表 */
export function getInstrumentTypes(): string[] {
  return [...registry.keys()];
}

/**
 * 构造引擎实例。
 * 未知类型说明工程文件来自更高版本或已被破坏，返回 null 由调用方决定降级策略，
 * 不在这里默默抛错 —— 用户看到的是界面提示，不是控制台堆栈。
 */
export function createInstrument(
  type: string,
  ctx: BaseAudioContext,
  dest: AudioNode,
): InstrumentEngine | null {
  const def = registry.get(type);
  if (!def) return null;
  return def.factory(ctx, dest);
}

/**
 * 补全参数：用默认值填补缺失字段。
 *
 * 场景：新增乐器版本后打开老工程，老工程存的 params 缺少新加的字段。
 * 直接使用会让引擎读到 undefined，在算术运算里变成 NaN，
 * 结果是整个轨道无声且没有任何报错——极难排查。
 */
export function withDefaults<T extends AnyParams>(
  def: InstrumentDef | undefined,
  params: unknown,
): T {
  const out: ParamsView = {};
  const defaults = (def?.defaultParams ?? {}) as ParamsView;
  for (const k of Object.keys(defaults)) {
    const dv = defaults[k];
    const pv = (params as ParamsView | null)?.[k];
    // 对象类参数（如 drum 的各鼓件）递归补全
    if (dv && typeof dv === 'object' && !Array.isArray(dv)) {
      out[k] = withDefaults({ ...def, defaultParams: dv } as InstrumentDef, pv);
    } else {
      out[k] = pv === undefined ? dv : pv;
    }
  }
  // 保留默认值里没有、但工程里存在的额外字段（向后兼容的未知参数）
  if (params && typeof params === 'object') {
    for (const k of Object.keys(params as ParamsView)) {
      if (!(k in out)) out[k] = (params as ParamsView)[k];
    }
  }
  return out as T;
}

/**
 * 乐器是否已注册。
 * 工程加载时用它校验类型是否被当前版本支持。
 */
export function isInstrumentKnown(type: string): boolean {
  return registry.has(type);
}