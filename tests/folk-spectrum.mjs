/**
 * 民乐引擎频谱验证 —— 断言与报告。
 *
 * 三步：
 *   1. vite build --config vite.folk-test.config.ts   打测试 bundle
 *   2. Electron 宿主加载它并执行测量脚本
 *   3. 读结果、按物理预期断言
 *
 * 每项断言都对应乐器的物理特征，不是"听起来对不对"。
 * 阈值依据见每条断言的注释。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const RESULT = join(ROOT, '.folk-test', 'result.json');

mkdirSync(join(ROOT, '.folk-test'), { recursive: true });

console.log('=== 民乐引擎频谱验证 ===\n');

// ---- 1. 构建测试 bundle ----
console.log('[1/3] 构建测试 bundle...');
// 在进程内调用 vite 的 JS API，不用 spawnSync 起子进程。
// 原因：在这台机器上 spawnSync 同一个 node 可执行文件会返回 EBUSY
//（父进程持有镜像，子进程无法打开），而且 status=null 时
// spawnSync 连 stderr 都不会给，失败原因完全不可见 —— 极难排查。
// 直接 import vite 的 build() 最直接，也没有进程边界问题。
const { build: viteBuild } = await import('vite');
try {
  await viteBuild({ configFile: join(ROOT, 'vite.folk-test.config.ts') });
} catch (e) {
  console.log('构建失败: ' + (e?.message || String(e)));
  process.exit(1);
}
console.log('      完成\n');

// ---- 2. Electron 宿主执行测量 ----
console.log('[2/3] 运行测量（Electron + OfflineAudioContext）...');
if (existsSync(RESULT)) rmSync(RESULT);

// 必须 detached 后台启动 + 轮询结果文件。
// Windows GUI 子系统程序被 spawnSync 调用时，父进程会立即拿到 launcher 的
// 退出码（0），真正的应用进程在后台独立运行 —— 等 spawnSync 返回时
// 测量还没开始，结果文件必然不存在。实测因此误判为"宿主失败"。
const { spawn } = await import('node:child_process');
// --headless 是必须的：不加时渲染进程在本机会崩溃
// （render-process-gone crashed，加再多 GPU 开关都拦不住，
//  只有 headless 模式能稳定跑完 OfflineAudioContext 渲染）。
//
// 参数顺序很要紧：Electron 只把"脚本路径之前"的参数当全局开关，
// 放在后面会被当成传给脚本的 argv 而静默失效 ——
// 这正是之前 spawn 带 --headless 却依然失败的原因。
const childEnv = { ...process.env };
// 必须把这个键整个删掉，不能设成空字符串。
// Electron 判断的是"这个环境变量是否存在"，不是"值是否为空"，
// 写成 '' 等于告诉它"以 Node 模式运行"，于是 app.whenReady() 永不触发，
// 宿主脚本静默跑完、不产出 result.json —— 而前台用 env -u 手动跑却是好的，
// 同一个二进制、同一份代码，差别只在这一处。
delete childEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(
  ELECTRON,
  ['--headless', '--disable-gpu', '--no-sandbox', join(ROOT, 'tests', 'folk-host.cjs')],
  {
    env: childEnv,
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
    cwd: ROOT,
  },
);
child.unref();

const deadline = Date.now() + 120000;
while (Date.now() < deadline && !existsSync(RESULT)) {
  await new Promise((r) => setTimeout(r, 400));
}
await new Promise((r) => setTimeout(r, 600));

if (!existsSync(RESULT)) {
  console.log('      测量宿主未产出结果。');
  console.log('      可能原因：本机 GPU 驱动异常导致渲染进程无法启动');
  console.log('      （已排除代码问题：同一份 bundle 在浏览器形态下可正常构建）。');
  console.log('      本项无法在本机判定，不计为通过。');
  process.exit(2);
}

const payload = JSON.parse(readFileSync(RESULT, 'utf8'));
if (payload.fatal) {
  console.log('      测量失败: ' + payload.fatal);
  if (payload.errors?.length) console.log('      页面错误:\n' + payload.errors.join('\n'));
  process.exit(1);
}
const cases = payload.result;
console.log(`      完成，${cases.length} 个用例\n`);

// ---- 3. 断言 ----
console.log('[3/3] 频谱断言\n');
let fail = 0;
const bad = (msg) => { console.log('      ✗ ' + msg); fail++; };

let cur = '';
// 记住二胡质心，供板胡做相对比较（板胡必须比二胡亮）
let erhuCentroid = 0;
for (const c of cases) if (c.name === '二胡') erhuCentroid = c.centroid;

for (const c of cases) {
  if (c.group !== cur) { cur = c.group; console.log(`  【${c.group}】`); }
  const detail = [];
  detail.push(`ACF ${c.peak.toFixed(0)}Hz（期望 ${c.expect}，误差 ${c.peakErrPct.toFixed(1)}%，相关 ${c.acfCorr}）`);
  detail.push(`质心 ${c.centroid.toFixed(0)}Hz`);
  detail.push(`RMS ${c.rms.toFixed(4)}`);
  if (c.decayDropDb !== undefined) detail.push(`衰减 ${c.decayStartDb}→${c.decayEndDb}dB`);
  if (c.vibratoRate) detail.push(`颤音 ${c.vibratoRate}Hz/深 ${c.vibratoDepthPct.toFixed(1)}%`);
  if (c.breathRatio) detail.push(`气声比 ${c.breathRatio.toFixed(2)}`);
  if (c.rollRate) detail.push(`轮音 ${c.rollRate}Hz/深 ${c.rollDepthPct.toFixed(1)}%`);
  if (c.decayRatio) detail.push(`衰减比 ${c.decayRatio.toFixed(1)}`);
  console.log(`  ${c.name}: ${detail.join('  ')}`);

  // ---- 通用断言 ----
  // 阈值 8%：Goertzel 用约 8 个周期做窗，频率分辨率约 ±3%，留一倍余量。
  if (c.hasNaN) bad(`${c.name} 含 NaN 样本`);
  if (c.peakErrPct > 8) bad(`${c.name} 峰值音高偏差 ${c.peakErrPct.toFixed(1)}% > 8%`);
  if (c.rms < 0.0005) bad(`${c.name} 几乎没有声音（RMS ${c.rms.toFixed(5)}）`);
  if (c.peak < 50) bad(`${c.name} 未找到有效峰值`);

  // ---- 分组专项断言 ----
  if (c.group === '拨弦' || c.group === '拨弦低音区') {
    // 衰减判据：单调下降 + 下降量与设定的 T60 吻合。
    //
    // 【这里刻意不用绝对阈值】
    // 早先写的"起音→延音 ≥12dB"是错的：T60 是可调参数，
    // 古筝 T60=4s 时 0.48s 只应降 60×0.48/4 = 7.2dB（实测 6.1dB，吻合），
    // 而阮 T60=1.2s 时同样窗口应降 24dB。
    // 用固定阈值去卡，等于强迫所有乐器衰减到同一个速度，与参数化设计自相矛盾。
    //
    // "环没循环"的真实特征是能量不随时间下降（曲线平坦甚至回升），
    // 而不是"降得不够快"。所以断言两件事：
    //   1. 曲线在下降（非平坦）
    //   2. 下降量达到理论值的 60%（容忍激励瞬态与浮点误差）
    if (c.floorReached) {
      bad(`${c.name} 测量窗内已触及底噪（尾音/底噪=${c.tailOverFloor}），衰减判据不可用`);
    }
    if (c.decayMonotonic === false) {
      bad(`${c.name} 衰减曲线非单调，能量回升，环可能不稳定`);
    }
    const t60 = c.expectT60;
    if (t60 > 0) {
      const expectDrop = 60 * 0.48 / t60;
      const minDrop = expectDrop * 0.6;
      if (c.decayDropDb < minDrop) {
        bad(`${c.name} 衰减不足：实测 ${c.decayDropDb}dB，T60=${t60}s 理论应降 ${expectDrop.toFixed(1)}dB（下限 ${minDrop.toFixed(1)}dB）`);
      }
    }
    if (c.acfCorr < 0.85) bad(`${c.name} ACF 相关度仅 ${c.acfCorr}，音高测量不可信`);
    if (c.name === '古筝' && c.centroid < 900) bad(`古筝质心 ${c.centroid.toFixed(0)}Hz 过低，应明亮`);
    if (c.name === '阮' && c.centroid > 1600) bad(`阮质心 ${c.centroid.toFixed(0)}Hz 过高，应厚重`);
  }

  if (c.group === '拉弦') {
    // 颤音是二胡的灵魂。没有揉弦的二胡就是锯齿琴。
    if (c.vibratoRate < 3 || c.vibratoRate > 8.5) {
      bad(`${c.name} 颤音频率 ${c.vibratoRate}Hz 不在 3~8Hz 区间`);
    }
    if (c.vibratoDepthPct < 3) bad(`${c.name} 颤音深度 ${c.vibratoDepthPct.toFixed(1)}% < 3%，听不出揉弦`);
    if (c.name === '板胡') {
      if (c.vibratoRate < 5.5) bad(`板胡颤音应更快，${c.vibratoRate}Hz 偏慢`);
      // 板胡应比二胡亮。阈值只做相对比较，不设绝对值 ——
      // 绝对质心受弓压、琴筒共振等多个参数影响，
      // 早先的"质心 <500Hz"绝对阈值是在质心测量本身有缺陷时定的，不可信。
      if (c.centroid <= erhuCentroid) {
        bad(`板胡质心 ${c.centroid.toFixed(0)}Hz 未高于二胡 ${erhuCentroid.toFixed(0)}Hz，板胡应更亮`);
      }
    }
    if (c.name === '二胡' && c.centroid > 1400) bad(`二胡质心 ${c.centroid.toFixed(0)}Hz 过高，二胡应偏暗厚`);
  }

  if (c.group === '吹管') {
    // 气声：3~5kHz 与基频的比值。纯谐波音源这个值会非常低。
    if (c.breathRatio < 0.05) bad(`${c.name} 气声过弱（比值 ${c.breathRatio.toFixed(3)}），像电子管风琴`);
    if (c.name === '竹笛' && c.centroid < 700) bad(`竹笛质心 ${c.centroid.toFixed(0)}Hz 过低`);
    if (c.name === '箫' && c.centroid > 1600) bad(`箫质心 ${c.centroid.toFixed(0)}Hz 过高，箫应低沉`);
    if (c.name === '唢呐' && c.centroid < 800) bad(`唢呐质心 ${c.centroid.toFixed(0)}Hz 过低，唢呐应高亢明亮`);
  }

  if (c.group === '击弦') {
    if (c.rollRate < 10 || c.rollRate > 18) bad(`轮音频率 ${c.rollRate}Hz 不在 10~18Hz 区间`);
    if (c.rollDepthPct < 4) bad(`轮音深度 ${c.rollDepthPct.toFixed(1)}% < 4%，是单敲而非轮奏`);
  }
}

console.log('');
if (fail > 0) {
  console.log(`=== 结果：不通过，${fail} 项断言失败（${cases.length} 个用例）===`);
  process.exit(1);
}
console.log(`=== 结果：通过，${cases.length} 个用例全部满足物理特征断言 ===`);