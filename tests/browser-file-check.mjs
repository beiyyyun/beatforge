// 用 Electron 的 Chromium（独立于 node）模拟「用户双击 html」
// 与 verify-package 的区别：直接加载 dist/index.html，走 file:// 协议，
// 不经过 Electron 主进程，验证的是「浏览器双击能不能开」
import { app, BrowserWindow } from 'electron';
import { resolve, join } from 'node:path';

if (process.env.ELECTRON_RUN_AS_NODE) delete process.env.ELECTRON_RUN_AS_NODE;

app.whenReady().then(async () => {
  const target = resolve('dist/index.html');
  console.log('模拟双击打开: ' + target);
  const win = new BrowserWindow({ show: false, width: 1280, height: 800,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false } });
  const errs = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errs.push(e.message); });
  win.webContents.on('did-fail-load', (_e, c, d) => errs.push('did-fail-load ' + c + ' ' + d));
  await win.loadFile(target);
  await new Promise(r => setTimeout(r, 3000));
  const raw = await win.webContents.executeJavaScript(`JSON.stringify({
    hasTopbar: !!document.querySelector('.topbar'),
    hasBoot: !!document.getElementById('boot'),
    text: document.body.innerText.slice(0,160)
  })`);
  const s = JSON.parse(raw);
  console.log('\n=== 浏览器双击 dist/index.html 结果 ===');
  console.log('界面挂载:', s.hasTopbar ? '✓ 成功' : '✗ 失败（仍卡在骨架屏）');
  console.log('骨架屏:', s.hasBoot ? '✗ 仍在' : '✓ 已移除');
  console.log('错误数:', errs.length);
  errs.slice(0,4).forEach(e => console.log('  · ' + e.slice(0,160)));
  console.log('\n界面文字:\n' + s.text);
  app.exit(s.hasTopbar ? 0 : 1);
});
setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 20000);
