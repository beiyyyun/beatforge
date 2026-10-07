/**
 * 民乐引擎测试的构建配置。
 *
 * 单独一份 vite 配置，把 tests/folk-entry.ts 打成固定文件名的 IIFE，
 * 避免依赖主应用产物里带 hash 的文件名（每次构建都变，测试脚本无法稳定引用）。
 */
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: '.folk-test',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(process.cwd(), 'tests/folk-host.html'),
      output: {
        format: 'es',
        entryFileNames: 'folk-bundle.js',
        assetFileNames: 'folk-[name][extname]',
      },
    },
  },
});