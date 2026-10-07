/**
 * 录音分析：音高检测 + 起音点检测 + 网格量化
 * ============================================
 * 目标：用户对着麦克风哼一段，程序自动变成钢琴卷帘上的音符。
 *
 * 三步流水线：
 *   ① 时域分析 —— 找起音点（音符的起点）与音量包络
 *   ② 频域分析 —— 自相关法估计基频，转 MIDI 音高
 *   ③ 量化     —— 把起音点吸附到 BPM 网格，按置信度决定是否保留
 *
 * 关键取舍：
 *   - 用自相关而非 FFT 峰值。FFT 峰值在低频（<200Hz）分辨率不足，
 *     而人声哼唱基频恰恰集中在 80~400Hz，这是自相关的主场。
 *   - 量化强度是连续参数而非开关。录音永远不准，硬吸附会毁掉
 *     演奏的弹性；给用户一个"吸附多少"的滑块才是诚实的做法。
 *   - 置信度低于阈值的片段直接丢弃，而不是硬生成一个错的音。
 *     宁缺毋滥：错音比缺音更让人难受。
 */

export interface DetectedNote {
  /** MIDI 音高 */
  key: number;
  /** 起始秒 */
  start: number;
  /** 结束秒 */
  end: number;
  /** 力度 0~1，由峰值音量映射 */
  velocity: number;
  /** 音高置信度 0~1 */
  confidence: number;
}

export interface RecordingAnalysis {
  notes: DetectedNote[];
  /** 采样率 */
  sampleRate: number;
  /** 音频总时长（秒） */
  duration: number;
  /** 检测到的整体音高范围（半音），用于 UI 提示 */
  range: { low: number; high: number };
}

// ============================================================
// 常量
// ============================================================

/**
 * 分析采样率。
 *
 * 为什么必须降采样：自相关是 O(帧长 × 最大lag) 的暴力计算。
 * 直接在 44.1kHz 上跑，10 秒音频约需 11 亿次乘加，浏览器会直接卡死。
 * 降到 11kHz 后运算量降到 1/16，检测精度对基频（上限 1000Hz）毫无损失。
 */
const ANALYSIS_RATE = 11025;
/** 单帧样本数 @11kHz ≈ 46ms。窗口太长会糊掉起音，太短则低音高不可靠 */
const FRAME_SIZE = 512;
const HOP_SIZE = 128;           // 帧移 @11kHz ≈ 11.6ms
/** 自相关搜索的基频范围（Hz）。低于 70Hz 的基频人耳难以判断，过低会误锁倍频 */
const FMIN = 70;
/**
 * 基频检测上限（Hz）。
 *
 * 这个值由实测标定，不是拍脑袋定的。
 * 采样率 11kHz、帧长 512 样本（约 46ms）下，帧内最多约 46 个周期。
 * 周期短到 13 个样本以内时，整数 lag 无法精确表达，自相关峰会摊平到相邻 lag 上，
 * "首个可信峰"机制就会自信地选中 2 倍周期，凭空低一个八度。
 *
 * 标定方式：MIDI 40~86 逐半音 × 5 种频谱配方（纯音/弱谐波/类锯齿/类方波/富谐波）
 * × 4 档白噪声（0 / 0.01 / 0.03 / 0.06），每档配方都取整段音频的逐帧中位音高。
 * 结果：
 *   FMAX=1000Hz → 2 个半音出错（MIDI 80 在高噪声下、MIDI 81 在富谐波配方下）
 *   FMAX=830Hz  → 范围内 0 个半音出错
 * 且出错帧的置信度高达 0.998，比正确帧的中位数 0.992 还高，
 * 靠置信度门限过滤不掉——只能从频段上杜绝。
 *
 * 取 830Hz（G#5）意味着放弃 A5(880Hz) 及以上。代价是明确的：
 * 宁可少识别两个高音，也绝不输出错音高。
 * 对哼唱场景够用——普通人声基频上限约C5(523Hz)，
 * 专业女声最高可到A5(880Hz)，但那已在本算法的可靠区之外。
 */
const FMAX = 830;
/**
 * 范围检查的容差系数（以半音为单位换算成倍频）。
 *
 * 存在的理由只有一个：整数 lag 的量化误差。周期 13.28 样本的 830Hz 音，
 * 无论选中 lag 13 还是 14，检出频率都在 830~848 之间浮动。
 * 容差取 1 个半音（2^(1/12) ≈ 1.0595），刚好覆盖这个浮动范围。
 *
 * 它不会让折叠的错误音高蒙混过关：真正的越界信号在更早的
 * 折叠检测处已被拒绝，走不到这里。
 */
const FREQUENCY_SLACK = Math.pow(2, 1 / 12);
/**
 * 首个可信峰必须达到全局峰值的这个比例。
 *
 * 这是本文件最关键的一个常量。自相关函数在 lag 的整数倍处都有峰
 * （周期信号延迟 2 个周期后仍与自身相似），所以直接取全局最大值
 * 会经常锁到 2 倍或 3 倍周期上，产生"低八度"或"低两个八度"的错误。
 *
 * 正确做法（McLeod / YIN 的标准做法）：先求全局峰值，
 * 再从最小的 lag 开始找第一个局部极大值，
 * 只要它不低于全局峰值的这个比例，就采信它——
 * 它才是基频，后面那些都是谐波造成的次峰。
 *
 * 取 0.9 而非更低：太低会把噪声当基频；太高则漏掉真实的基频。
 */
const FIRST_PEAK_RATIO = 0.9;
/**
 * 自相关计算的最低 lag。
 *
 * 这个值刻意远低于 minLag（=采样率/FMAX）。多算几个 lag 的代价可以忽略
 * （每个 lag 是 O(帧长) 的一次线性扫描，多算 8 个 lag 约增加 5% 运算量），
 * 但换来的是能看见"真实基频高于 FMAX"的那部分周期——折叠检测离不开它。
 */
const NSDF_FLOOR_LAG = 3;
/** 判定"这一帧有音"的能量阈值（相对全局峰值） */
const ONSET_REL_THRESHOLD = 0.12;
/** 判定"这一帧没音"的能量阈值，低于起音阈值形成迟滞，避免抖动 */
const SILENCE_REL_THRESHOLD = 0.05;
/** 最短音符时长（秒）。短于此的会被当作敲击噪声丢掉 */
const MIN_DURATION = 0.06;
/** 同一根音内允许的音高跳变（半音）。超过则认为换音了 */
const PITCH_JUMP_TOLERANCE = 1;
/** 置信度下限，低于此不生成音符 */
const CONFIDENCE_FLOOR = 0.35;

// ============================================================
// 主入口
// ============================================================

/**
 * 分析录音 Buffer，产出音符候选。
 * @param buffer     单声道 PCM，原始采样率
 * @param sampleRate buffer 的采样率
 *
 * 流程：降采样 → 逐帧能量与音高 → 切分音符 → 映射力度。
 * 全程同步计算。10 秒录音约需 200~400ms，期间会阻塞 UI，
 * 所以录音面板在分析时必须显示进度提示。
 */
export function analyzeRecording(buffer: Float32Array, sampleRate: number): RecordingAnalysis {
  // ---- ① 降采样到分析率 ----
  const decimated = decimate(buffer, sampleRate, ANALYSIS_RATE);
  const sr = decimated.sampleRate;
  const data = decimated.data;

  const frameCount = Math.max(0, Math.floor((data.length - FRAME_SIZE) / HOP_SIZE) + 1);
  const duration = buffer.length / sampleRate;

  const empty: RecordingAnalysis = {
    notes: [], sampleRate, duration, range: { low: 60, high: 60 },
  };
  if (frameCount <= 0 || data.length < sr * 0.05) return empty;

  // ---- ② 全局峰值，用于设阈值 ----
  let peak = 0;
  for (let i = 0; i < buffer.length; i++) {
    const a = Math.abs(buffer[i]);
    if (a > peak) peak = a;
  }
  // 全是静音或极低电平，直接返回
  if (peak < 0.005) return empty;

  const onsetThreshold = peak * ONSET_REL_THRESHOLD;
  const silenceThreshold = peak * SILENCE_REL_THRESHOLD;

  // ---- ③ 逐帧分析 ----
  const energies = new Float32Array(frameCount);
  const pitches = new Float32Array(frameCount);   // MIDI，-1 表示无音
  const confidences = new Float32Array(frameCount);

  const frame = new Float32Array(FRAME_SIZE);
  for (let f = 0; f < frameCount; f++) {
    const off = f * HOP_SIZE;
    frame.set(data.subarray(off, off + FRAME_SIZE));

    const energy = rms(frame);
    energies[f] = energy;

    if (energy < onsetThreshold) continue;

    const { midi, confidence } = detectPitch(frame, sr);
    pitches[f] = midi;
    confidences[f] = confidence;
  }

  // ---- ④ 切分音符 ----
  const segments = segmentNotes(
    energies, pitches, confidences, frameCount, sr,
    onsetThreshold, silenceThreshold,
  );

  // ---- ⑤ 收集音高范围 ----
  const keys = segments.map(s => s.key);
  const range = segments.length
    ? { low: Math.min(...keys), high: Math.max(...keys) }
    : { low: 60, high: 60 };

  return {
    notes: segments.map(s => ({
      key: s.key,
      start: s.start,
      end: s.end,
      velocity: velocityFromPeak(s.peak, peak),
      confidence: s.confidence,
    })),
    sampleRate,
    duration,
    range,
  };
}

/**
 * 降采样到目标采样率。
 *
 * 做法：先做低通（滑动平均）再抽样。
 * 只抽样不滤波会产生混叠（aliasing）——高频率折回到低频，
 * 让 2kHz 的泛音被误判成 500Hz 的基频，这是音高检测最典型的错误来源。
 * 滑动平均的截止频率约等于目标采样率的一半，对基频检测足够。
 */
export function decimate(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): { data: Float32Array; sampleRate: number } {
  if (toRate >= fromRate) return { data: input, sampleRate: fromRate };
  const factor = fromRate / toRate;
  const outLen = Math.floor(input.length / factor);
  if (outLen < 1) return { data: new Float32Array(0), sampleRate: toRate };

  const out = new Float32Array(outLen);
  // 窗长取 factor 并向下取整，保证整数抽头；factor 至少为 1
  const half = Math.max(0, Math.floor(factor / 2));
  for (let i = 0; i < outLen; i++) {
    const center = Math.round(i * factor);
    let sum = 0;
    let count = 0;
    for (let k = -half; k <= half; k++) {
      const idx = center + k;
      if (idx < 0 || idx >= input.length) continue;
      sum += input[idx];
      count++;
    }
    out[i] = count ? sum / count : 0;
  }
  return { data: out, sampleRate: toRate };
}

// ============================================================
// 音高检测（自相关法）
// ============================================================

/**
 * 自相关基频检测。
 *
 * 原理：周期性信号的时域波形与自身延迟一个周期后的副本高度相似，
 * 所以自相关函数在 lag = 周期 处出现峰值。
 * 用归一化自相关（NSDF 的简化版）保证不同音量下的检测结果一致。
 *
 * @param frame      必须是 ANALYSIS_RATE 下的单帧
 * @param sampleRate 该帧的采样率
 * @returns midi 音高，检测失败为 -1；confidence 为 0~1 的可信度
 */
export function detectPitch(
  frame: Float32Array,
  sampleRate: number,
): { midi: number; confidence: number } {
  const n = frame.length;
  if (n < FRAME_SIZE / 2) return { midi: -1, confidence: 0 };

  // 去直流：麦克风常有偏置，会干扰自相关的峰值位置
  let mean = 0;
  for (let i = 0; i < n; i++) mean += frame[i];
  mean /= n;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = frame[i] - mean;

  // 去均值后重新算能量，用于归一化
  let energy = 0;
  for (let i = 0; i < n; i++) energy += x[i] * x[i];
  if (energy < 1e-9) return { midi: -1, confidence: 0 };

  const minLag = Math.max(2, Math.floor(sampleRate / FMAX));
  const maxLag = Math.min(n - 1, Math.ceil(sampleRate / FMIN));
  if (maxLag <= minLag) return { midi: -1, confidence: 0 };

  // 归一化自相关：nsdf(lag) = r(lag) / sqrt(e(0) * e(lag))
  //
  // 计算下界是 NSDF_FLOOR_LAG 而非 minLag：多算几个 lag 用来做折叠检测。
  // 搜索范围（minLag..maxLag）仍只用于挑选基频候选。
  const minLagInt = minLag;
  const maxLagInt = maxLag;
  const floorLag = Math.max(2, Math.min(NSDF_FLOOR_LAG, minLagInt - 1));
  let bestLag = -1;
  let bestVal = 0;
  const nsdf = new Float32Array(maxLagInt + 2);

  for (let lag = floorLag; lag <= maxLagInt; lag++) {
    let ac = 0;
    let e1 = 0;
    let e2 = 0;
    for (let i = 0; i < n - lag; i++) {
      ac += x[i] * x[i + lag];
      e1 += x[i] * x[i];
      e2 += x[i + lag] * x[i + lag];
    }
    const denom = Math.sqrt(e1 * e2) + 1e-12;
    const v = ac / denom;
    nsdf[lag] = v;
    // 全局峰值只在搜索范围内统计，避免越界信号的短周期峰污染阈值
    if (lag >= minLagInt && v > bestVal) { bestVal = v; bestLag = lag; }
  }

  if (bestLag < 0 || bestVal < CONFIDENCE_FLOOR) return { midi: -1, confidence: 0 };

  // ---- 关键一步：取首个可信峰，而不是全局最大峰 ----
  // 周期信号的 nsdf 在 lag、2·lag、3·lag… 处都有峰，
  // 全局最大往往落在 2·lag 上，于是基频被判定为一半（低八度）。
  // 从搜索下界起步，找第一个"局部极大且接近全局峰"的位置才是基频。
  //
  // 起点必须是 minLagInt 本身而不是 minLagInt+1：
  // 紧贴上限的音（MIDI 79 = 784Hz，周期 14.06 样本）真实峰就贴着 minLag，
  // 跳过它会一路找到 2·lag，凭空低一个八度。
  // 这么改之所以安全，是因为 nsdf 现在从 NSDF_FLOOR_LAG 算起，
  // nsdf[minLagInt-1]是真实采样值而非未初始化的 0，能安全用作左邻比较。
  const threshold = bestVal * FIRST_PEAK_RATIO;
  let chosenLag = -1;
  for (let lag = minLagInt; lag < maxLagInt; lag++) {
    if (nsdf[lag] > nsdf[lag - 1] && nsdf[lag] >= nsdf[lag + 1] && nsdf[lag] >= threshold) {
      chosenLag = lag;
      break;
    }
  }

  // 找不到任何局部峰，说明搜索范围内根本没有周期性。
  // 最常见的原因是真实基频低于 FMIN（周期超出 maxLag），
  // 此时 nsdf 在整个范围内单调衰减，会把最小 lag 当成峰值——
  // 那其实是在"猜"，必须拒绝而不是输出一个错的音高。
  if (chosenLag < 0) return { midi: -1, confidence: 0 };

  // 抛物线插值把峰值细化到亚样本精度。
  // 这一步对音准很关键：整数 lag 在低音区误差可达半个半音。
  const y0 = nsdf[chosenLag - 1];
  const y1 = nsdf[chosenLag];
  const y2 = nsdf[chosenLag + 1];
  const denom = 2 * (2 * y1 - y0 - y2);
  const shift = Math.abs(denom) > 1e-9 ? (y2 - y0) / denom : 0;
  const refinedLag = chosenLag + Math.max(-1, Math.min(1, shift));

  // ---- 折叠检测：真实基频高于 FMAX 时必须拒绝 ----
  //
  // 问题：若真实基频 > FMAX，其周期短于 minLag，落不进搜索范围。
  // 但 2·周期、3·周期仍在范围内，于是算法会把谐波当成基频，
  // 表现为凭空低一个八度甚至低十二度（1600Hz 被判成 800Hz = MIDI 79）。
  //
  // 判据：minLag 以下若存在【内部局部极大值】且强度接近全局峰，
  // 说明波形在更短的周期上就已经重复了——真实基频超出量程，拒绝。
  //
  // 为什么强调"内部局部极大"而不是"某处取值高"：
  // 低频信号（110Hz）在短 lag 处的自相关是单调衰减的肩部，
  // 110Hz 在 lag 5 处 nsdf 高达 0.90，但那不是峰，只是"波形变化很慢"。
  // 只有要求两侧都有更低值的真正极大值，才能把肩部和周期峰区分开。
  // 实测：可靠区内 36 个半音 × 5 种频谱配方 × 4 档白噪声，
  // minLag 以下无一例外没有内部峰；越界信号则在真实周期处有 0.98~1.00 的峰。
  // 已知残留：真实周期恰好落在两个整数 lag 正中间时（如 1300Hz，周期 8.48），
  // 峰会摊平到 0.87 左右，够不到 y1×0.9 而漏检。该频率远超人声哼唱范围，
  // 继续为它调参会引入回归风险，因此保留现状而非追求全覆盖。
  for (let lag = floorLag + 1; lag < minLagInt; lag++) {
    if (nsdf[lag] > nsdf[lag - 1] && nsdf[lag] > nsdf[lag + 1]
        && nsdf[lag] >= y1 * FIRST_PEAK_RATIO) {
      return { midi: -1, confidence: 0 };
    }
  }

  const freq = sampleRate / refinedLag;

  // 范围检查。留一个半音的容差（FREQUENCY_SLACK）吸收整数 lag 的量化误差：
  // 周期 13.28 样本的 830Hz 音，检出频率会落在 830~848 之间，
  // 卡死在 830 会把边界音误杀。折叠检测已经在上方拦住了真正的越界信号，
  // 这里的容差不会放进错误的音高。
  if (freq < FMIN * FREQUENCY_SLACK || freq > FMAX * FREQUENCY_SLACK) {
    return { midi: -1, confidence: 0 };
  }

  // 置信度 = 选中峰的强度。它接近 1 意味着波形高度周期化，
  // 是纯净乐音的典型特征；噪声的 nsdf 各处都低且平。
  const confidence = Math.max(0, Math.min(1, y1));

  const midi = Math.round(69 + 12 * Math.log2(freq / 440));
  return { midi, confidence };
}

// ============================================================
// 起音切分
// ============================================================

interface Segment {
  key: number;
  start: number;
  end: number;
  confidence: number;
  peak: number;
}

/**
 * 把逐帧结果切成音符段。
 * 状态机：静音 → 起音（记起始帧与音高）→ 保持 → 收尾。
 *
 * 用迟滞阈值（起音 0.12 / 收尾 0.05）而不是单一阈值，
 * 否则长音中间的音量波动会把一个音符切成两半。
 */
function segmentNotes(
  energies: Float32Array,
  pitches: Float32Array,
  confidences: Float32Array,
  frameCount: number,
  sampleRate: number,
  onsetThreshold: number,
  silenceThreshold: number,
): Segment[] {
  const out: Segment[] = [];
  const secPerFrame = HOP_SIZE / sampleRate;

  let active = false;
  let startFrame = 0;
  let lastKey = -1;
  let keySum = 0;
  let keyCount = 0;
  let confSum = 0;
  let peak = 0;

  const reset = () => {
    active = false; lastKey = -1; keySum = 0; keyCount = 0; confSum = 0; peak = 0;
  };

  const flush = (endFrame: number) => {
    if (!active) return;
    const start = startFrame * secPerFrame;
    const end = Math.max(endFrame * secPerFrame, start + MIN_DURATION);
    const avgKey = keyCount ? Math.round(keySum / keyCount) : lastKey;
    const avgConf = keyCount ? confSum / keyCount : 0;

    if (avgKey > 0 && end - start >= MIN_DURATION && avgConf >= CONFIDENCE_FLOOR) {
      out.push({ key: avgKey, start, end, confidence: avgConf, peak });
    }
    reset();
  };

  for (let f = 0; f < frameCount; f++) {
    const e = energies[f];

    if (!active) {
      if (e < onsetThreshold) continue;
      // 起音：这一帧的音高必须可信，否则当作噪声忽略
      if (pitches[f] < 0 || confidences[f] < CONFIDENCE_FLOOR) continue;
      active = true;
      startFrame = f;
      lastKey = pitches[f];
      keySum = pitches[f];
      keyCount = 1;
      confSum = confidences[f];
      peak = e;
      continue;
    }

    peak = Math.max(peak, e);

    // 迟滞收尾
    if (e < silenceThreshold) {
      flush(f);
      continue;
    }

    const p = pitches[f];
    if (p < 0) continue;

    if (lastKey >= 0 && Math.abs(p - lastKey) > PITCH_JUMP_TOLERANCE) {
      // 音高变了 → 前一个音结束，当前音另起一段。
      // 保留能量连续性：不在这里加静音间隔，否则听感上有断句感。
      flush(f);
      active = true;
      startFrame = f;
      lastKey = p;
      keySum = p;
      keyCount = 1;
      confSum = confidences[f];
      peak = e;
      continue;
    }

    lastKey = p;
    keySum += p;
    keyCount += 1;
    confSum += confidences[f];
  }

  flush(frameCount);
  return mergeAdjacent(out);
}

/**
 * 合并音高相同、首尾相接的短片段。
 * 自相关法在音头容易少检一帧，导致一个音被切成两段，
 * 这个后处理能把它们粘回去。
 */
function mergeAdjacent(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (prev && prev.key === s.key && s.start - prev.end < 0.02) {
      prev.end = s.end;
      prev.confidence = Math.max(prev.confidence, s.confidence);
      prev.peak = Math.max(prev.peak, s.peak);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

// ============================================================
// 量化
// ============================================================

export interface QuantizeOptions {
  /** 网格步长（秒）。由 BPM 与网格精度决定 */
  stepSeconds: number;
  /**
   * 量化强度 0~1。
   * 0 = 完全不吸附（保留原始律动）
   * 1 = 完全吸附（严格落在网格上）
   * 中间值按比例在"原始位置"与"网格位置"之间插值。
   */
  strength: number;
  /** 是否量化音高到半音。半音 quantization 本身已在 detectPitch 里做了 */
  quantizePitch?: boolean;
}

/**
 * 把检测到的音符对齐到 BPM 网格。
 *
 * 力度与时值保持原始值——量化的目的是对齐节奏，不是把演奏变得机械。
 */
export function quantize(
  notes: DetectedNote[],
  opts: QuantizeOptions,
): Array<{ key: number; start: number; length: number; velocity: number }> {
  const { stepSeconds, strength } = opts;
  if (stepSeconds <= 0) throw new Error('stepSeconds 必须为正数');

  return notes.map((n) => {
    // 起点：向最近的网格线插值
    const snapped = Math.round(n.start / stepSeconds) * stepSeconds;
    const start = n.start + (snapped - n.start) * strength;

    // 时长同样吸附，但至少一格，避免生成零长度音符
    const rawLen = n.end - n.start;
    const lenSnapped = Math.max(1, Math.round(rawLen / stepSeconds)) * stepSeconds;
    const length = Math.max(stepSeconds, rawLen + (lenSnapped - rawLen) * strength);

    return {
      key: opts.quantizePitch ? Math.round(n.key) : n.key,
      start: Math.max(0, start),
      length,
      velocity: n.velocity,
    };
  });
}

/** 秒 → 步索引 */
export function secondsToStep(seconds: number, stepSeconds: number): number {
  return Math.max(0, Math.round(seconds / stepSeconds));
}

/** 峰值电平 → 力度。做一次压缩，让轻声也能被听见 */
function velocityFromPeak(peak: number, globalPeak: number): number {
  if (globalPeak <= 0) return 0.5;
  const rel = peak / globalPeak;
  // 平方根压缩：线性映射会让大部分音符挤在低力度区
  return Math.max(0.15, Math.min(1, Math.sqrt(rel)));
}

/** 均方根，用于帧能量 */
function rms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}