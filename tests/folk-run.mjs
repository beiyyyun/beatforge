/**
 * 通用测量宿主驱动：构建 bundle → Electron 跑指定脚本 → 打印结果。
 *
 * 用法：node tests/folk-run.mjs [脚本相对路径] [--raw]
 *   node tests/folk-run.mjs                # 跑正式测量 folk-measure.js
 *   node tests/folk-run.mjs folk-diag-ks.js --raw   # 跑诊断脚本，原样输出
 *
 * 存在的意义：folk-spectrum.mjs 硬编码了测量脚本和断言，
 * 诊断时就得去覆盖那个文件 —— 历史上正是这样把正式测量脚本弄丢的。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const OUT = join(ROOT, '.folk-test', 'result.json');

const args = process.argv.slice(2);
const raw = args.includes('--raw');
const scriptRel = args.find((a) => !a.startsWith('--')) || 'folk-measure.js';

mkdirSync(join(ROOT, '.folk-test'), { recursive: true });

console.log(`[1/3] 构建 bundle（目标 ${scriptRel}）...`);
const { build: viteBuild } = await import('vite');
try {
  await viteBuild({ configFile: join(ROOT, 'vite.folk-test.config.ts'), logLevel: 'error' });
} catch (e) {
  console.log('构建失败: ' + (e?.message || String(e)));
  process.exit(1);
}

console.log('[2/3] 运行 Electron...');
if (existsSync(OUT)) rmSync(OUT);

const childEnv = { ...process.env };
// 必须整个删除，不能设成空字符串 —— Electron 判断的是键是否存在。
// 写成 '' 会让它以 Node 模式运行，app.whenReady() 永不触发，
// 宿主静默跑完不产出结果，表现为"环境问题"，实际是这一行代码。
delete childEnv.ELECTRON_RUN_AS_NODE;
childEnv.FOLK_SCRIPT = scriptRel;

// 参数顺序要紧：Electron 只把脚本路径之前的参数当全局开关。
const child = spawn(
  ELECTRON,
  ['--headless', '--disable-gpu', '--no-sandbox', join(ROOT, 'tests', 'folk-host.cjs')],
  { env: childEnv, stdio: 'ignore', detached: true, windowsHide: true, cwd: ROOT },
);
child.unref();

const deadline = Date.now() + 120000;
while (Date.now() < deadline && !existsSync(OUT)) {
  await new Promise((r) => setTimeout(r, 300));
}
await new Promise((r) => setTimeout(r, 500));

if (!existsSync(OUT)) {
  console.log('宿主未产出结果（120s 超时）');
  process.exit(2);
}
const payload = JSON.parse(readFileSync(OUT, 'utf8'));
if (payload.fatal) {
  console.log('测量失败: ' + payload.fatal);
  process.exit(1);
}

if (raw) {
  console.log(JSON.stringify(payload.result, null, 2));
} else {
  writeFileSync(join(ROOT, '.folk-test', 'cases.json'), JSON.stringify(payload.result, null, 2));
  console.log('[3/3] 完成，结果写入 .folk-test/cases.json');
}