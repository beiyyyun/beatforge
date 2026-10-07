/**
 * 民乐引擎测试入口。
 *
 * 单独打一个 bundle 而不是复用主应用，原因有二：
 *  1. 主应用的模块文件名带 hash，每次构建都变，测试脚本无法稳定引用；
 *  2. 测试需要直接访问引擎类和默认参数，主应用没导出这些。
 *
 * 挂到 window 上供页面内的脚本读取 —— file:// 下ES module 的具名导出
 * 无法从外部 import（没有服务端、没有正确的 MIME），这是唯一可靠的做法。
 */
import {
  PluckSynth, BowSynth, WindSynth, YangleSynth,
  PLUCK_DEFAULTS, BOW_DEFAULTS, WIND_DEFAULTS, YANGLE_DEFAULTS,
  preparePluck,
} from '../src/audio/folk';

const api = {
  PluckSynth, BowSynth, WindSynth, YangleSynth,
  PLUCK_DEFAULTS, BOW_DEFAULTS, WIND_DEFAULTS, YANGLE_DEFAULTS,
  // 离线路径必须显式 await，测试里也一样 —— 不传 preparePluck
  // 的话 AudioWorklet 还没加载完，AudioWorkletNode 会直接抛异常
  preparePluck,
};

(globalThis as unknown as Record<string, unknown>).FOLK = api;
(window as unknown as Record<string, unknown>).FOLK = api;

document.getElementById('app')!.textContent = 'folk-test-ready';