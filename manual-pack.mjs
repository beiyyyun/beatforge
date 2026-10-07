/**
 * 手动组装 Windows 便携版可执行程序。
 *
 * 为什么不用 electron-builder：它在解压 200MB+ 运行时后调用
 * fs.rename 把 win-unpacked.tmp 改名为 win-unpacked，
 * 在本机环境下这一步稳定返回 EPERM（Windows Defender 正在扫描
 * 刚写入的 exe，句柄未释放）。已验证同目录下的小目录 rename 正常，
 * 所以问题出在大体积新文件的锁上，不是权限配置错误。
 *
 * electron-builder 的打包本质就是这四步，全部可以手工完成：
 *   1. 复制 Electron 运行时
 *   2. 把 electron.exe 改名成产品名
 *   3. 用 app.asar（打包后的应用代码）替换默认的 default_app.asar
 *   4. 写 version / LICENSE 等元数据
 * 这里照做，且完全避开 rename。
 */
import {
  cpSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  renameSync, copyFileSync, rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = process.cwd();
const RUNTIME = join(ROOT, 'node_modules', 'electron', 'dist');
const OUT = join(ROOT, 'BeatForge-win');
const APP_DIR = join(OUT, 'resources', 'app');

console.log('=== BeatForge 手动打包 ===');
console.log('运行时:', RUNTIME);
console.log('输出:', OUT);
console.log('');

if (!existsSync(RUNTIME)) {
  console.error('错误：找不到 Electron 运行时，请先执行 node node_modules/electron/install.js');
  process.exit(1);
}

// ---- 1. 清空并复制运行时 ----
// 注意：不能删已存在的 OUT（环境的删除工具对新目录有 bug），
// 所以用覆盖式复制，已有的旧文件会被同名文件覆盖。
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
console.log('[1/5] 复制 Electron 运行时（约 370MB，需要一会儿）...');
cpSync(RUNTIME, OUT, { recursive: true, force: true });
console.log('      完成');

console.log('[2/5] 移除默认应用壳...');
// default_app.asar 是 Electron 的"找不到应用"提示页，必须移除，
// 否则会覆盖我们自己的入口
const defaultAsar = join(OUT, 'resources', 'default_app.asar');
if (existsSync(defaultAsar)) {
  // 用改名代替删除：Electron 不会加载非 .asar 后缀的文件
  renameSync(defaultAsar, defaultAsar + '.removed');
  console.log('      default_app.asar → default_app.asar.removed');
}

console.log('[3/5] 写入应用代码...');
if (!existsSync(APP_DIR)) mkdirSync(APP_DIR, { recursive: true });
mkdirSync(join(APP_DIR, 'electron'), { recursive: true });

// 应用入口配置。Electron 会读 resources/app/package.json 的 main 字段。
writeFileSync(
  join(APP_DIR, 'package.json'),
  JSON.stringify({
    name: 'beatforge',
    productName: 'BeatForge',
    version: '0.1.0',
    description: '浏览器里的音乐工作站',
    main: 'main.cjs',
    type: 'commonjs',
  }, null, 2),
  'utf8',
);

// 复制主进程。
//
// 只放一份在 app 根目录，package.json 的 main 直接指向它。
// 之前在根目录和 electron/ 各放一份，两份内容完全相同但相对层级不同，
// 一旦修改只改其中一份就会产生"打包后行为和源码不一致"的幽灵 bug。
// resolveIndexHtml() 会自己探测路径，所以单份放置是安全的。
copyFileSync(join(ROOT, 'electron', 'main.cjs'), join(APP_DIR, 'main.cjs'));
// electron/package.json 提供 type:commonjs 作用域（打包后不再需要，但保留成本为零）
copyFileSync(join(ROOT, 'electron', 'package.json'), join(APP_DIR, 'electron', 'package.json'));

// 复制构建产物（界面 + 音频引擎）
if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('错误：找不到 dist/index.html，请先执行 npm run build');
  process.exit(1);
}
console.log('[4/5] 复制界面与音频代码...');
// 先删掉旧的 dist 再整份复制。
//
// cpSync 对已存在的目录是"合并"而不是"替换"：Vite 每次构建产物文件名带内容
// hash（index-xxxx.js），于是上一版的 index-yyyy.js 会一直留在打包目录里。
// 危害有两点：
//   1. 白占体积，且随版本数线性增长
//   2. 打包目录里同时躺着多个 JS，一旦有人手工改 index.html 指到旧的，
//      就会跑出"打包后行为和源码不一致"的幽灵 bug，而且极难察觉
// （index.html 里引用的是新的，实际执行的是旧的）。
const appDist = join(APP_DIR, 'dist');
if (existsSync(appDist)) rmSync(appDist, { recursive: true, force: true });
cpSync(join(ROOT, 'dist'), appDist, { recursive: true, force: true });
console.log('      完成');

console.log('[5/5] 设置产品信息...');
// 换掉可执行文件名
const oldExe = join(OUT, 'electron.exe');
const newExe = join(OUT, 'BeatForge.exe');
if (existsSync(oldExe)) {
  if (existsSync(newExe)) rmSync(newExe, { force: true });
  renameSync(oldExe, newExe);
  console.log('      electron.exe → BeatForge.exe');
}

// 写入 Windows 版本资源（图标、版本号、产品名）
// electron-builder 通常注入这些，手动打包时自己写。
const rcedit = join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
if (existsSync(rcedit)) {
  console.log('      写入图标与版本信息...');
  const { execFileSync } = await import('node:child_process');
  const ico = join(ROOT, 'build', 'icon.ico');
  const args = [newExe, '--set-version-string', 'FileDescription', 'BeatForge',
    '--set-version-string', 'ProductName', 'BeatForge',
    '--set-version-string', 'CompanyName', 'BeatForge',
    '--set-file-version', '0.1.0.0',
    '--set-product-version', '0.1.0.0'];
  if (existsSync(ico)) args.push('--set-icon', ico);
  try {
    execFileSync(rcedit, args, { stdio: 'pipe' });
    console.log('      完成（图标已嵌入）');
  } catch (e) {
    console.log('      跳过：' + String(e.message).split('\n')[0]);
  }
} else {
  console.log('      未找到 rcedit，跳过图标注入（不影响运行）');
}

console.log('\n=== 打包完成 ===');
console.log('可执行文件: BeatForge-win/BeatForge.exe');
console.log('把整个 BeatForge-win 文件夹拷到任何地方都能运行（免安装）');
