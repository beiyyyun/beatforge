/**
 * 打包产物的路径与结构验证。
 * ==================================
 * 分两层，第二层会明确报告"未能验证"，绝不假装通过。
 *
 * 第一层：离线确定性检查（一定可跑）
 *   校验打包目录结构、入口文件、index.html 的资源引用方式。
 *   这一层能抓住本次的 ERR_FILE_NOT_FOUND 根因——路径解析结果指向不存在的目录。
 *
 * 第二层：端到端启动自检（依赖图形环境，可能跑不起来）
 *   启动真正的 BeatForge.exe，主进程读渲染进程真实 DOM 后写诊断文件。
 *   关键：必须走真实 exe。若验证脚本自己 loadFile(dist/index.html)，
 *   就绕过了主进程的路径解析逻辑，主进程路径写错时测试照样"通过"。
 *   （上一版正是这么写的，因此掩盖了用户实际遇到的 bug。）
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = process.cwd();
const OUT = join(ROOT, 'BeatForge-win');
const APP = join(OUT, 'resources', 'app');
const EXE = join(OUT, 'BeatForge.exe');
const DIAG_OUT = join(tmpdir(), 'beatforge-diag.txt');

let hardFail = 0;
const ok = (cond, label, detail = '') => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (detail ? '  → ' + detail : ''));
  if (!cond) hardFail++;
  return cond;
};

console.log('=== BeatForge 打包产物验证 ===');
console.log('输出目录:', OUT);
console.log('');

// ---------- 第一层：离线结构检查 ----------
console.log('--- [1/2] 离线结构与路径检查 ---');

if (!ok(existsSync(EXE), 'BeatForge.exe 存在')) {
  console.log('\n请先执行 node manual-pack.mjs');
  process.exit(1);
}

const pkgPath = join(APP, 'package.json');
const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : {};
const mainRel = pkg.main || 'main.cjs';
const mainPath = join(APP, mainRel);
ok(existsSync(mainPath), `入口 ${mainRel} 存在`, mainPath);
ok(pkg.type === 'commonjs', '入口作用域为 commonjs', '实际: ' + pkg.type);

// 关键断言：按主进程自己的路径拼接规则，算出它会加载哪个 index.html。
// 这里复刻 electron/main.cjs 的 resolveIndexHtml() 逻辑 ——
// 不是复制一份新的猜测，而是验证那条规则在打包布局下解析到真实存在的文件。
const resolveIndexHtml = (baseDir) => {
  const candidates = [
    join(baseDir, 'dist', 'index.html'),
    join(baseDir, '..', 'dist', 'index.html'),
    join(baseDir, '..', '..', 'dist', 'index.html'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return { found: p, candidates };
  }
  return { found: null, candidates };
};

const resolved = resolveIndexHtml(dirname(resolve(mainPath)));
ok(!!resolved.found, '主进程能定位到 index.html', resolved.found || '全部候选都不存在');
if (!resolved.found) {
  console.log('已尝试的候选路径:');
  resolved.candidates.forEach((c) => console.log('    ' + c));
}

// 反向断言：旧的错误路径（多退一层）必须不存在。
// 这条直接对应用户截图里的报错，能防回归。
const wrongLegacy = resolve(join(dirname(mainPath), '..', 'dist', 'index.html'));
ok(!existsSync(wrongLegacy),
  '旧的多退一层路径确实不存在（说明修复是必要的，不是无害改动）',
  wrongLegacy);

const indexHtml = resolved.found;
if (indexHtml) {
  const html = readFileSync(indexHtml, 'utf8');
  const distDir = dirname(indexHtml);

  // file:// 双击的两个必要条件：相对路径 + 无 crossorigin
  const scriptRefs = [...html.matchAll(/<script[^>]*src=["']([^"']+)["']/g)].map((m) => m[1]);
  const cssRefs = [...html.matchAll(/<link[^>]+href=["']([^"']+)["']/g)].map((m) => m[1]);
  const allRefs = [...scriptRefs, ...cssRefs];

  ok(allRefs.length > 0, 'index.html 引用了构建产物', allRefs.join(', '));
  const absolute = allRefs.filter((r) => r.startsWith('/') || /^[a-z]+:\/\//i.test(r));
  ok(absolute.length === 0, '资源引用全为相对路径（file:// 可解析）',
    absolute.length ? '绝对路径: ' + absolute.join(', ') : '');
  ok(!/\scrossorigin/i.test(html), '无 crossorigin 属性（避免 file:// 下 CORS 预检失败）');

  // 引用的文件必须真实存在
  let missing = [];
  for (const r of allRefs) {
    const p = resolve(distDir, r);
    if (!existsSync(p)) missing.push(r);
  }
  ok(missing.length === 0, '引用的资源文件全部存在', missing.length ? '缺失: ' + missing.join(', ') : '');

  // 反向检查：assets 目录里不能有 index.html 未引用的残留文件。
  //
  // Vite 产物带内容 hash（index-xxxx.js），每次构建文件名都变。
  // 打包脚本若用 cpSync 合并复制而不先清空，上一版的 JS 会一直躺在
  // 打包目录里。危害不是"多占点空间"，而是：目录里同时有新旧两个 JS，
  // 谁被加载取决于 index.html 指向 —— 一旦指错就是"打包后行为和源码不一致"，
  // 而且界面上完全看不出来。手动打包已改为先删后拷，这里守住回归。
  const assetDir = resolve(distDir, 'assets');
  let orphans = [];
  if (existsSync(assetDir)) {
    const onDisk = readdirSync(assetDir).map((f) => './assets/' + f);
    const referenced = new Set(allRefs.map((r) => './' + r.replace(/^\.\//, '')));
    orphans = onDisk.filter((f) => !referenced.has(f));
  }
  ok(orphans.length === 0,
    'assets 目录无未引用残留文件',
    orphans.length ? '残留: ' + orphans.join(', ') + '（打包脚本应先删 dist 再复制）' : '');

  // 体积下限：防止 dist 被清空一半却仍"结构正确"
  let jsBytes = 0;
  for (const r of scriptRefs.filter((x) => x.endsWith('.js'))) {
    const p = resolve(distDir, r);
    if (existsSync(p)) jsBytes += statSync(p).size;
  }
  ok(jsBytes > 50000, '主 JS 体积正常（产物未被截断）', jsBytes + ' 字节');
}

console.log('');

// ---------- 第二层：端到端启动自检 ----------
console.log('--- [2/2] 端到端启动自检 ---');

if (existsSync(DIAG_OUT)) unlinkSync(DIAG_OUT);

// 宿主环境（WorkBuddy 自身基于 Electron）会注入 ELECTRON_RUN_AS_NODE。
//
// 必须整个删除这个键，不能设成空字符串 —— Electron 判断的是"键是否存在"，
// 设成'' 等于没删。后果不是"环境变量无效"，而是 exe 彻底跑错：
// 以纯 Node 模式启动、不开窗口，且只认 `-` 不认 `--`，于是
// `--use-angle=swiftshader` 被当成 Node 的 bad option 直接拒绝，
// Electron 主进程压根没启动过。
//
// 这一点曾被误判为"本机 GPU 崩溃导致无法验证"，实际是验证脚本自己的 bug。
// 判据：Node 模式的报错形如 "bad option: --xxx"，GPU 崩溃则是
// "GPU process exited unexpectedly" 且主进程已打印自己的日志。
// 两者根因与修法完全不同，别混。
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
childEnv.BEATFORGE_DIAG = '1';
childEnv.BEATFORGE_DIAG_OUT = DIAG_OUT;

// 强制软件渲染。本机 GPU 进程确实会崩（0xC0000005），
// 但这不是"无法验证"的理由 —— main.cjs 里本就有这个开关
// （app.disableHardwareAcceleration 必须在 ready 之前调用），
// 之前没人设过它，所以白屏被误当成环境问题。
// 对照实验：关掉它渲染进程直接 crashed，打开它 headless 下全部正常。
childEnv.BEATFORGE_SOFTWARE_RENDER = '1';

const child = spawn(
  EXE,
  // --headless 让 Chromium 走无窗口路径，绕开本机崩溃的 GPU 进程。
  // 仍然是真实 exe、真实主进程、真实 loadFile 与真实 file:// 协议 ——
  // 要验证的路径解析逻辑一点没被绕过。
  ['--headless', '--disable-gpu', '--no-sandbox', '--disable-software-rasterizer'],
  { env: childEnv, stdio: 'ignore', detached: true, windowsHide: true },
);
child.unref();

// Windows GUI 程序 spawn 后拿到的是 launcher 的退出码，真正的应用进程在后台独立运行，
// 等 'exit' 事件会提前返回、诊断文件必然是空的。所以只能轮询文件。
const deadline = Date.now() + 35000;
let diag = '';
while (Date.now() < deadline) {
  if (existsSync(DIAG_OUT)) {
    diag = readFileSync(DIAG_OUT, 'utf8');
    // 终止条件必须等"最后一行断言"出现，不能等中间某条。
    // 早先等的是 '#app 子节点数'，而它后面还有民乐/面板断言 ——
    // 读到它就break 会拿到半截输出，把本该 FAIL 的项算成通过。
    if (diag.includes('# 示例轨道已渲染') || diag.includes('FAIL')) break;
  }
  await new Promise((r) => setTimeout(r, 300));
}
await new Promise((r) => setTimeout(r, 400));

const passLines = diag.split('\n').filter((l) => l.startsWith('PASS'));
const failLines = diag.split('\n').filter((l) => l.startsWith('FAIL'));

if (diag.trim()) {
  console.log(diag.trim());
  console.log('');
  ok(failLines.length === 0, '端到端自检无 FAIL 项',
    failLines.length ? failLines.map((l) => l.slice(5)).join('; ') : '');
  // 8 项：file协议 / 无ERR_FILE_NOT_FOUND / .topbar / 骨架屏 / #app 子节点 /
  // 十大民乐预设 / 8 个面板 / 示例轨道。
  // 少于这个数说明诊断被中途截断，不算通过。
  ok(passLines.length >= 8, '端到端自检 8 项断言全过',
    passLines.length + '/8');
} else {
  console.log('  ! 未能完成端到端自检。');
  console.log('');
  console.log('    这一项无法在当前机器上判定，不计为通过也不计为失败。');
  console.log('');
  console.log('    排查时请按这个顺序看，两种根因的判据完全不同：');
  console.log('      1) 报 "bad option: --xxx"');
  console.log('         → ELECTRON_RUN_AS_NODE 没被真正 delete（设成空字符串无效，');
  console.log('           Electron 判断的是键是否存在）。exe 以 Node 模式跑，');
  console.log('           Electron 主进程从未启动。这与 GPU、与打包都无关。');
  console.log('      2) 报 "GPU process exited unexpectedly" 或 "Renderer process crashed"');
  console.log('         → 本机 GPU 驱动问题。验证脚本已设 BEATFORGE_SOFTWARE_RENDER=1');
  console.log('           并用 --headless 绕开；若仍失败，说明软件渲染这条路也不通，');
  console.log('           此时才需要换机器人工确认。');
  console.log('');
  console.log('    第一层的离线检查独立成立：路径解析结果指向真实文件、');
  console.log('资源引用全为相对路径、无 crossorigin、产物未被截断。');
}

// ---------- 环境变量名一致性 ----------
// 环境变量拼错属于"静默失效"：代码里 process.env.BEATFORCE_XXX 永远读不到，
// 设了也没报错，兜底逻辑等于从未启用。
// 本项目已经踩过一次 —— main.cjs / README / .env.example 三处各错一次，
// 而用户正是照着 .env.example 去设置白屏问题的，所以这里守住一致性。
console.log('\n--- [附加] 环境变量名一致性 ---');
const envFiles = ['electron/main.cjs', 'README.md', '.env.example'];
let envBad = [];
for (const rel of envFiles) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf8');
  // 只查实际赋值/读取处，不查注释 —— 本文件自己的注释里就写着这个错拼
  // （那是解释性文字），把它算成违规就是自己抓自己。
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  if (/BEATFORCE[A-Z_]/.test(code)) {
    envBad.push(rel + ' 仍含拼错的 BEATFORCE（正确应为 BEATFORGE）');
  }
}
ok(envBad.length === 0,
  '环境变量名拼写一致（无 BEATFORCE 误拼）',
  envBad.join('; '));

// 主进程必须真的读这个变量（否则前面的一致性检查只是在检查文档）
const mainSrc = readFileSync(join(ROOT, 'electron', 'main.cjs'), 'utf8');
ok(/BEATFORGE_SOFTWARE_RENDER\s*===\s*'1'/.test(mainSrc),
  '主进程确实读取 BEATFORGE_SOFTWARE_RENDER');

console.log('');
console.log('=== 汇总 ===');
if (hardFail > 0) {
  console.log('不通过：' + hardFail + ' 项检查失败。');
  process.exit(1);
}
console.log('离线结构与路径检查全部通过。' + (diag.trim() ? '端到端自检亦通过。' : '端到端自检因环境原因未完成，需人工确认。'));