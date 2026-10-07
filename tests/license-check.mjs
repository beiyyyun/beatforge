/**
 * 逐字核验 LICENSE 的 MIT 正文是否与官方原文一致。
 *
 * 为什么必须核验：MIT 正文是标准文本，凭记忆写容易出现细微差异
 * （漏词、改标点）。许可文本本身若有歧义，授权范围就可能不是你以为的那个。
 *
 * 比较方法：去掉所有换行与空白后逐字比对。electron 的 LICENSE 是
 * 单一MIT（未混入 ISC），可直接作为权威参照。
 */
import { readFileSync } from 'node:fs';

// MIT 官方的规范化形式（choosealicense.com / SPDX 的标准写法）
const OFFICIAL = [
  'Permission is hereby granted, free of charge, to any person obtaining',
  'a copy of this software and associated documentation files (the',
  '"Software"), to deal in the Software without restriction, including',
  'without limitation the rights to use, copy, modify, merge, publish,',
  'distribute, sublicense, and/or sell copies of the Software, and to',
  'permit persons to whom the Software is furnished to do so, subject to',
  'the following conditions:',
  'The above copyright notice and this permission notice shall be',
  'included in all copies or substantial portions of the Software.',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,',
  'EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF',
  'MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND',
  'NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE',
  'LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION',
  'OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION',
  'WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
].join('\n');

/** 归一化：去掉换行、连续空格、末尾空白 —— 只留实义文字 */
function norm(s) {
  return s.replace(/\s+/g, ' ').trim();
}

const my = readFileSync('LICENSE', 'utf8');
const electron = readFileSync('node_modules/electron/LICENSE', 'utf8');

const myLines = my.split('\n');
// 结构：0=许可名称, 1=空行, 2=Copyright 行, 3=空行, 4+=正文
const copyLine = myLines[0];
const copyLineText = myLines[2];
const myBody = norm(myLines.slice(4).join('\n'));
const refBody = norm(electron.split('\n').filter((l) => !l.startsWith('Copyright')).join('\n'));
const official = norm(OFFICIAL);

let fail = 0;
const ok = (c, label, detail = '') => {
  console.log((c ? '  ✓ ' : '  ✗ ') + label + (detail ? '  → ' + detail : ''));
  if (!c) fail++;
};

console.log('=== MIT 正文逐字核验 ===\n');
console.log('--- 与 electron/LICENSE 正文比对（去空白后）---');
ok(myBody === refBody, '我的正文与 electron 官方 MIT 正文完全一致');

console.log('\n--- 与 choosealicense 标准写法比对 ---');
ok(myBody === official, '我的正文与 MIT 标准写法完全一致');

// 逐句定位差异，便于精确修正
if (myBody !== official) {
  console.log('\n差异定位:');
  const a = myBody.split(' '), b = official.split(' ');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      console.log(`  第 ${i + 1} 词：我方="${a[i]}"  官方="${b[i]}"`);
      console.log(`  上下文: ...${a.slice(Math.max(0, i - 4), i + 5).join(' ')}...`);
      break;
    }
  }
}

console.log('\n--- 版权行---');
ok(copyLine === 'MIT License', '首行是许可名称', copyLine);
ok(/^Copyright \(c\) 2026 beiyyun$/.test(copyLineText || ''),
  '版权行格式正确且年份/署名与仓库一致', copyLineText || '(未找到)');

// 反向检查：不能残留双许可的痕迹
ok(!/ISC License/.test(my), '未混入 ISC 许可文本');
ok(!/either of the following licenses/i.test(my), '未残留"二选一"的双许可表述');
// MIT 必须包含这三段，缺一段授权范围就不完整
ok(/WITHOUT WARRANTY OF ANY KIND/.test(my), '含免责声明段');
ok(/shall be\s+included in all\s+copies/i.test(my), '含版权声明保留条款');
ok(/free of charge/.test(my), '含免费授权条款');

console.log(`\n=== ${fail === 0 ? '全部通过' : fail + ' 项未通过'} ===`);
process.exit(fail === 0 ? 0 : 1);