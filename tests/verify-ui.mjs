/**
 * 端到端界面自检（headless）
 * ============================================
 *
 * 为什么需要它：tests/verify-package.mjs 的第二层要启动真正的 exe，
 * 但本机 GPU 驱动崩溃（0xC0000005），有头模式跑不起来，
 * 于是那一层长期处于"未能验证"状态 —— 意味着
 * "民乐预设有没有真的出现在音色浏览器里"这种问题，
 * 到今天为止没有任何自动化手段能回答。
 *
 * --headless 可以绕过 GPU 崩溃。本脚本据此做三件事：
 *   1. 加载真实 dist/index.html（与主进程同一个文件）
 *   2. 读真实 DOM：音色浏览器里有没有民乐分类与10 个预设
 *   3. 检查控制台有无异常
 *
 * 它不替代 verify-package.mjs 的路径检查（那层校验的是主进程的路径解析规则，
 * 必须走真实 exe）；它补的是"界面到底渲染出了什么"这一层。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const OUT = join(ROOT, '.folk-test', 'ui-diag.json');
const HOST = join(ROOT, 'tests', 'ui-host.cjs');
const INDEX = join(ROOT, 'dist', 'index.html');

mkdirSync(join(ROOT, '.folk-test'), { recursive: true });
if (existsSync(OUT)) rmSync(OUT);

if (!existsSync(INDEX)) {
  console.log('dist/index.html 不存在，请先 npm run build');
  process.exit(1);
}

const childEnv = { ...process.env };
// 必须整个删除，不能设成空字符串。详见 folk-run.mjs 里的同一处注释。
delete childEnv.ELECTRON_RUN_AS_NODE;
childEnv.UI_INDEX = INDEX;
childEnv.UI_OUT = OUT;

const child = spawn(
  ELECTRON,
  ['--headless', '--disable-gpu', '--no-sandbox', '--disable-software-rasterizer', HOST],
  { env: childEnv, stdio: 'ignore', detached: true, windowsHide: true, cwd: ROOT },
);
child.unref();

const deadline = Date.now() + 90000;
while (Date.now() < deadline && !existsSync(OUT)) {
  await new Promise((r) => setTimeout(r, 300));
}
await new Promise((r) => setTimeout(r, 400));

if (!existsSync(OUT)) {
  console.log('界面宿主未产出结果（90s 超时）—— 可能是 Electron 启动失败，不是断言失败');
  process.exit(2);
}

const payload = JSON.parse(readFileSync(OUT, 'utf8'));
if (payload.fatal) {
  console.log('宿主异常: ' + payload.fatal);
  process.exit(1);
}

// 宿主把诊断结果平铺写在顶层（fatal 字段与结果同级），
// 不是包一层 result —— 早先按result 取值拿到 undefined，
// 报出 "Cannot read properties of undefined"，
// 看起来像脚本坏了，其实是读取契约写错了。
const r = payload;
let fail = 0;
const ok = (cond, label, detail = '') => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (detail ? '  → ' + detail : ''));
  if (!cond) fail++;
};

console.log('=== 界面端到端自检（headless，加载真实 dist/index.html）===\n');

ok(r.loaded, '页面加载完成', r.loadError || '');
ok(Array.isArray(r.consoleErrors) && r.consoleErrors.length === 0,
  '无控制台错误',
  r.consoleErrors?.length ? JSON.stringify(r.consoleErrors.slice(0, 3)) : '');

console.log('\n--- 音色浏览器（真实 DOM）---');
console.log('  分类:', JSON.stringify(r.categories));
ok(r.categories.includes('拨弦'), '存在「拨弦」分类');
ok(r.categories.includes('拉弦'), '存在「拉弦」分类');
ok(r.categories.includes('吹管'), '存在「吹管」分类');
ok(r.categories.includes('击弦'), '存在「击弦」分类');

for (const want of ['古筝', '琵琶', '阮', '二胡', '板胡', '竹笛', '箫', '唢呐', '笙', '扬琴']) {
  ok(r.presetNames.includes(want), `预设「${want}」已渲染`);
}
ok(r.folkPresetCount === 10, '民乐预设共 10 个', '实际 ' + r.folkPresetCount);

console.log('\n--- 面板宿主（.main-body > .panel）---');
// 曾经的真实缺陷：main.ts 建好 mainBody 之后从来没把任何面板 root 挂进去，
// 于是 refresh() 渲染的所有内容都没有落脚点 —— 整个主工作区是空白。
// 这类缺陷编译期查不出、也不影响音色浏览器，正是本脚本要守的边界。
const PANELS = ['rack', 'step', 'piano', 'harmony', 'record', 'mixer', 'tone', 'fx'];
console.log('  宿主:', JSON.stringify(r.panelHostIds));
ok(r.panelHostCount === PANELS.length,
  `${PANELS.length} 个面板宿主全部挂载`,
  '实际 ' + r.panelHostCount);
for (const p of PANELS) {
  ok(r.panelHostIds?.includes(p), `面板宿主 ${p} 存在`);
}
// 同一时刻只能有一个面板可见，多个可见会导致两块内容叠在一起
ok(r.visiblePanelIds?.length === 1,
  '仅当前标签的面板可见',
  '可见: ' + JSON.stringify(r.visiblePanelIds));

console.log('\n--- 轨道机架 ---');
// 严格断言：首屏默认就是「通道」标签，所以机架必须有 3 条示例轨道。
// 之前这里写的是 trackCount >= 3 || !r.isRackTab —— 而 isRackTab 来自
// [].some(...) 恒为 false，取反恒为 true，等于无条件通过。
// 那种断言看起来是绿的，实际什么都没验证。
console.log('  当前标签:', JSON.stringify(r.activeMainTab));
ok(r.activeMainTab.includes('通道'), '首屏默认标签是「通道」');
ok(r.hasRack, '机架容器已挂载');
ok(r.trackCount >= 3,
  '示例工程 3 条轨道已渲染',
  '实际 ' + r.trackCount + '，轨道名 ' + JSON.stringify(r.trackNames));
ok(r.rackChildCount >= 3, '机架子节点数与轨道数一致', '实际 ' + r.rackChildCount);

// 注册表完整性由 tests/registry-check.mjs 单独校验。
// 这一层拿不到：页面里的模块作用域被 Vite 打包封住，
// 页面上下文无法 import 注册表 —— 硬要取只能往生产代码里塞一个调试全局变量，
// 那是为测试污染产品，不是好交易。

console.log(`\n=== ${fail === 0 ? '全部通过' : fail + ' 项未通过'} ===`);
process.exit(fail === 0 ? 0 : 1);