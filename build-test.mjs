/**
 * 用 Vite 的 SSR 能力把 TS 测试脚本打成 Node 可执行的 .mjs。
 * 不引入 tsx / vitest 等额外依赖。
 */
import { build } from 'vite';

const result = await build({
  logLevel: 'error',
  build: {
    ssr: 'tests/selfcheck.ts',
    outDir: '.selfcheck-dist',
    emptyOutDir: true,
    minify: false,
    target: 'node20',
    rollupOptions: {
      output: { entryFileNames: 'selfcheck.mjs', format: 'es' },
    },
  },
});

if (result) {
  console.log('自检包已生成 → .selfcheck-dist/selfcheck.mjs');
}