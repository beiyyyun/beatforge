/**
 * 标准鼓组默认参数
 * ============================================
 * 单独抽出来是因为有两处要用同一份数值：
 *   1. presets.ts 里"标准鼓组"预设
 *   2. register.ts 里drum 乐器的 defaultParams（老工程补全字段时用）
 * 两处各写一份的话，改了其中一处另一处静默走偏，是很难查的 bug。
 */

import type { DrumKitParams } from '../core/types';

export const DEFAULT_DRUM_KIT: DrumKitParams = {
  kick:     { pitch: 55,  decay: 0.42, noise: 0.05, drive: 0.3,  punch: 1, body: 0.5,  bend: 32 },
  snare:    { pitch: 190, decay: 0.19, noise: 0.75, drive: 0.22, punch: 1, body: 0.4,  bend: 60 },
  clap:     { pitch: 1000, decay: 0.24, noise: 0.95, drive: 0.15, punch: 1, body: 0.12, bend: 0 },
  closedHat: { pitch: 8000, decay: 0.055, noise: 1.0, drive: 0.12, punch: 1, body: 0.05, bend: 0 },
  openHat:  { pitch: 7200, decay: 0.34, noise: 1.0, drive: 0.14, punch: 1, body: 0.06, bend: 0 },
  tomLow:   { pitch: 110, decay: 0.32, noise: 0.2,  drive: 0.2,  punch: 1, body: 0.7,  bend: 40 },
  tomMid:   { pitch: 165, decay: 0.26, noise: 0.22, drive: 0.2,  punch: 1, body: 0.65, bend: 35 },
  rim:      { pitch: 420, decay: 0.06, noise: 0.5,  drive: 0.35, punch: 1, body: 0.55, bend: 0 },
};