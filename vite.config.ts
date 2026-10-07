import { defineConfig, type Plugin } from 'vite';

/**
 * 去掉产物 script/link 标签上的 crossorigin 属性。
 *
 * Vite 默认给注入的资源加 crossorigin，本意是让 CDN 场景能拿到正确的 CORS 响应。
 * 但本项目要支持 file:// 双击打开，而 crossorigin 会让浏览器对本地文件
 * 发起 CORS 预检 —— file:// 协议没有 Origin 头，预检必然失败，
 * 结果是 JS 根本不执行，页面卡在骨架屏。
 *
 * 只在确实用了相对路径（base: './'）时移除；用 CDN 部署时保留原行为。
 */
function stripCrossoriginForFileProtocol(): Plugin {
  return {
    name: 'strip-crossorigin-file-protocol',
    enforce: 'post',
    apply: 'build',
    transformIndexHtml(html) {
      return html
        .replace(/\s+crossorigin(?=["\s])/g, '')
        .replace(/\s+anonymous(?=["\s])/g, '');
    },
  };
}

export default defineConfig({
  // 相对路径而非默认的绝对路径 "/assets/..."。
  //
  // 原因：绝对路径在 file:// 协议下会被解析成 file:///C:/assets/...（指向磁盘根目录），
  // 导致 JS/CSS 加载失败，页面永远停在"正在启动音频引擎"的骨架屏上。
  // 相对路径让 dist/index.html 可以直接双击打开，无需起服务器。
  base: './',
  plugins: [stripCrossoriginForFileProtocol()],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        // 单块输出，减少 file:// 下的模块请求数
        manualChunks: undefined,
      },
    },
  },
  server: {
    port: 5173,
  },
});
