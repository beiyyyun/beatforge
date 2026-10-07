/**
 * 乐器注册表静态校验
 * ====================
 *
 * 为什么需要它：模块化架构的承诺是"加新乐器只改register.ts 一处，
 * engine.ts / export.ts / editor.ts / layers.ts 一行都不用改"。
 * 这个承诺很容易悄悄失效 —— 比如某个调用方又写回了
 * `instrument === 'pluck'` 这样的硬判断，
 * 编译器不会报错（都是合法字符串比较），运行时才暴露。
 *
 * 所以这里做两件事：
 *   1. 确认 7 种乐器都已注册，且 trackKind / percussive 标注自洽
 *   2. 扫描调用方源码，禁止出现硬编码乐器名判断
 *
 * 为什么不走真实运行：注册表在 Vite 打包后的模块作用域里，
 * 页面上下文无法 import（见 verify-ui.mjs 里的同一处说明）。
 * 静态检查反而更严格 —— 它能覆盖到运行时测不到的死代码分支。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

let fail = 0;
const ok = (cond, label, detail = '') => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (detail ? '  → ' + detail : ''));
  if (!cond) fail++;
};

console.log('=== 乐器注册表静态校验 ===\n');

// ---------------------------------------------------------------
// 1. 注册完整性
// ---------------------------------------------------------------
console.log('--- 1. 注册完整性 ---');

const registerSrc = readFileSync(join(SRC, 'audio', 'register.ts'), 'utf8');

// 从 register.ts 里抠出 type: 'xxx' —— 用正则而不是 import，
// 因为 register.ts 顶部 import 引擎会拉进 AudioWorklet 加载逻辑，
// Node 环境没有 AudioContext，import 必然抛错。
//
// 正则必须锚定在 registerInstrument( 的直接子级位置：
// 只写 /type:\s*'([a-z]+)'/ 会把 filter: { type: 'lowpass' } 也抠出来
// （早先就误报成"注册了 9 种乐器"）。
// 这里改为切分每个注册块，只认块内第一个 type: 字段。
const blocks = registerSrc
  .split('registerInstrument({')
  .slice(1)
  .map((b) => {
    // 每个块到下一个 registerInstrument( 之前结束（split 已保证）
    const t = b.match(/^\s*type:\s*'([a-z]+)'/m);
    return t ? t[1] : null;
  })
  .filter(Boolean);
const registered = blocks;

const EXPECTED = [
  { type: 'poly', kind: 'melodic', label: '复音合成器' },
  { type: 'fm', kind: 'melodic', label: 'FM 合成器' },
  { type: 'drum', kind: 'drum', label: '鼓组', percussive: true },
  { type: 'pluck', kind: 'melodic', label: '拨弦', percussive: true },
  { type: 'bow', kind: 'melodic', label: '拉弦' },
  { type: 'wind', kind: 'melodic', label: '吹管' },
  { type: 'yangle', kind: 'melodic', label: '击弦', percussive: true },
];

ok(registered.length === EXPECTED.length,
  `注册了 ${EXPECTED.length} 种乐器`,
  '实际 ' + registered.length + '：' + JSON.stringify(registered));

for (const e of EXPECTED) {
  ok(registered.includes(e.type), `乐器 ${e.type} 已注册`);
}

// 每种乐器必须能定位到自己的注册块，检查 kind / percussive 标注。
// 标注错了不会报错，但会让 store.ts 把小鼓当旋律轨加载、把拨弦当持续音处理。
for (const e of EXPECTED) {
  // 从 type: 'xxx' 起，向后取到下一个 registerInstrument 之前
  const idx = registerSrc.indexOf(`type: '${e.type}'`);
  const next = registerSrc.indexOf('registerInstrument({', idx + 1);
  const block = registerSrc.slice(idx, next === -1 ? undefined : next);
  const kindMatch = block.match(/trackKind:\s*'(\w+)'/);
  ok(kindMatch?.[1] === e.kind,
    `乐器 ${e.type} 的 trackKind 是 ${e.kind}`,
    kindMatch ? '实际 ' + kindMatch[1] : '未声明');
  const hasPerc = /percussive:\s*true/.test(block);
  ok(hasPerc === !!e.percussive,
    `乐器 ${e.type} 的 percussive 标注正确`,
    `实际 ${hasPerc}，期望 ${!!e.percussive}`);
}

// 所有注册块的 factory 都必须存在 —— 缺 factory 的条目
// createInstrument() 会返回 undefined，轨道静默无声且无任何报错。
const factoryCount = (registerSrc.match(/factory:\s*\(/g) || []).length;
ok(factoryCount === EXPECTED.length,
  `每个注册都带 factory（共 ${EXPECTED.length} 个）`,
  '实际 ' + factoryCount);

// ---------------------------------------------------------------
// 2. 调用方禁止硬编码乐器判断
// ---------------------------------------------------------------
console.log('\n--- 2. 调用方硬编码检查 ---');

// 这些文件按注册表/接口写，不该出现 instrument === 'xxx' 形式的分支。
// register.ts / registry.ts / types.ts 本身就是定义处，排除。
const CALLERS = [
  'audio/engine.ts',
  'audio/export.ts',
  'core/store.ts',
  'ui/editor.ts',
  'ui/layers.ts',
  'main.ts',
];

// 反例模式：===' 后面紧跟乐器名。
//
// 两个必须处理的坑，都是早先误报的原因：
//   1. 注释里会引用旧的错误写法（layers.ts 的注释就写着
//      `instrument === 'fm' ? 青 : 紫`）—— 所以先剥掉注释再扫。
//   2. store.ts 有一处**有意**的 drum 判断：鼓预设不能作为叠加层，
//      要降级成 poly。这是唯一的合法例外，白名单放行并写明理由。
const HARDCODED = /(?:instrument|l\.instrument|preset\.instrument)\s*[!=]==?\s*'([a-z]+)'/g;

/** 剥掉行注释与块注释，避免把注释里的旧代码当成活代码 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

/** 允许的硬编码例外：文件 → 原因 */
const ALLOWED = {
  'core/store.ts':
    "preset.instrument === 'drum' ? 'poly' —— 鼓预设不能作为叠加层，必须降级",
};

let violations = 0;
for (const rel of CALLERS) {
  const p = join(SRC, rel);
  if (!existsSync(p)) {
    ok(false, `${rel} 存在`);
    continue;
  }
  const raw = readFileSync(p, 'utf8');
  const text = stripComments(raw);
  const hits = [...text.matchAll(HARDCODED)]
    .filter((m) => EXPECTED.some((e) => e.type === m[1]));
  if (hits.length === 0) {
    ok(true, `${rel} 无硬编码乐器判断`);
  } else if (ALLOWED[rel] && hits.every((m) => m[1] === 'drum')) {
    ok(true, `${rel} 仅有一处白名单硬编码`, ALLOWED[rel]);
  } else {
    const detail = hits
      .map((m) => `${m[1]} @行 ${text.slice(0, m.index).split('\n').length}`)
      .join(', ');
    ok(false, `${rel} 无硬编码乐器判断`, detail);
    violations += hits.length;
  }
}

// ---------------------------------------------------------------
// 3. InstrumentType 联合类型与注册表一致
// ---------------------------------------------------------------
console.log('\n--- 3. 类型与注册表一致 ---');

// types.ts 里的联合类型和 register.ts 的注册列表必须完全一致。
// 少写一个 → 预设里用了它就编译不过（好）；
// 多写一个 → 界面能选中但 createInstrument 返回 undefined，静默无声（坏）。
const typesSrc = readFileSync(join(SRC, 'core', 'types.ts'), 'utf8');
const unionMatch = typesSrc.match(/InstrumentType\s*=\s*([\s\S]*?);/);
const inUnion = unionMatch
  ? [...unionMatch[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1])
  : [];

ok(inUnion.length === EXPECTED.length,
  `InstrumentType 联合含 ${EXPECTED.length} 个成员`,
  '实际 ' + JSON.stringify(inUnion));

for (const e of EXPECTED) {
  ok(inUnion.includes(e.type), `InstrumentType 含 ${e.type}`);
}
// 反向：联合里不该有注册表之外的类型
const extra = inUnion.filter((t) => !EXPECTED.some((e) => e.type === t));
ok(extra.length === 0, '联合类型无多余成员', JSON.stringify(extra));

// ---------------------------------------------------------------
// 4. 鼓组默认参数单一来源
// ---------------------------------------------------------------
console.log('\n--- 4. 鼓组默认值单一来源 ---');

// register.ts 的 drum 条目必须直接引用 DEFAULT_DRUM_KIT，
// 而不是内联一份 —— 两份数值会静默走偏（改一处另一处不生效）。
const drumIdx = registerSrc.indexOf(`type: 'drum'`);
const drumNext = registerSrc.indexOf('registerInstrument({', drumIdx + 1);
const drumBlock = registerSrc.slice(drumIdx, drumNext === -1 ? undefined : drumNext);
ok(/defaultParams:\s*DEFAULT_DRUM_KIT/.test(drumBlock),
  'drum 注册直接引用 DEFAULT_DRUM_KIT',
  '内联鼓件参数会导致两份数值走偏');

const presetsSrc = readFileSync(join(SRC, 'audio', 'presets.ts'), 'utf8');
ok(/DEFAULT_DRUM_KIT/.test(presetsSrc),
  'presets.ts 也引用 DEFAULT_DRUM_KIT');

console.log(`\n=== ${fail === 0 ? '全部通过' : fail + ' 项未通过'} ===`);
process.exit(fail === 0 ? 0 : 1);