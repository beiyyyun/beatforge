/**
 * 用 Node 内置能力验证 dist/index.html 在 file:// 下的资源可解析性。
 * 不启动浏览器，只检查 HTML 引用的资源在磁盘上是否存在且路径正确。
 *
 * 背景：之前交付的产物用绝对路径 /assets/...，双击打开时被解析成
 * file:///C:/assets/...（磁盘根目录），JS 加载失败，页面永远卡在骨架屏。
 * vite 改为 base: './' 后需要确认引用确实是相对路径且文件存在。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const htmlPath = resolve('dist/index.html');
const html = readFileSync(htmlPath, 'utf8');
const htmlDir = dirname(htmlPath);

console.log('=== 产物资源引用检查 ===');
console.log('HTML: ' + htmlPath);
console.log('');

let allOk = true;

// 抓取 src="..." 与 href="..."
const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);

for (const ref of refs) {
  if (ref.startsWith('data:') || ref.startsWith('#') || ref.startsWith('http')) {
    console.log('  跳过（内联/外链）: ' + ref);
    continue;
  }

  const isAbsolute = ref.startsWith('/');
  if (isAbsolute) {
    allOk = false;
    console.log('  ✗ 绝对路径（file:// 下会解析到磁盘根目录）: ' + ref);
    console.log('     实际会去找: file://' + ref.replace(/^\//, '/'));
    continue;
  }

  const target = join(htmlDir, ref);
  const exists = existsSync(target);
  if (!exists) allOk = false;
  console.log(
    '  ' + (exists ? '✓' : '✗') + ' 相对路径: ' + ref +
    (exists ? '' : '  ← 文件不存在'),
  );
}

// 额外检查：crossorigin 属性在 file:// 下会触发 CORS 预检
console.log('');
const hasCrossorigin = /<script[^>]+crossorigin/.test(html);
if (hasCrossorigin) {
  console.log('  ⚠ script 标签带 crossorigin 属性');
  console.log('     file:// 协议下可能触发 CORS 检查而失败');
  console.log('     建议移除（对本地加载无必要）');
}

// 模拟浏览器解析，确认 URL 构造正确
console.log('\n=== 浏览器 URL 解析模拟 ===');
for (const ref of refs) {
  if (ref.startsWith('data:') || ref.startsWith('#')) continue;
  const url = new URL(ref, pathToFileURL(htmlPath).href);
  console.log('  ' + ref.padEnd(34) + ' → ' + decodeURIComponent(url.pathname));
}

console.log('\n结论: ' + (allOk && !hasCrossorigin
  ? '所有资源引用正确，file:// 双击可正常打开'
  : allOk
    ? '路径已修正，但 crossorigin 可能阻止 file:// 加载'
    : '仍有绝对路径引用，file:// 下会失败'));

process.exit(allOk && !hasCrossorigin ? 0 : 1);
