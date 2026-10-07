/**
 * 民乐频谱验证的宿主（Electron 主进程）。
 *
 * 为什么不用 Playwright：本机GPU 驱动异常，Playwright 的 Chromium 启动即挂
 * （与 Electron 遇到的是同一个 0xC0000005）。Electron 在本项目里已验证可用，
 * 且它同样提供完整的 OfflineAudioContext，实现测试目的足够。
 *
 * 用法：env -u ELECTRON_RUN_AS_NODE electron tests/folk-host.cjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const OUT = path.join(__dirname, '..', '.folk-test', 'result.json');

// 渲染环境。
//
// 关键：必须配合 --headless 启动（见folk-spectrum.mjs）。
// 本机实测结论：
//   · 有头模式下渲染进程必定崩溃（render-process-gone crashed），
//     加多少 GPU 开关都拦不住；
//   · --headless + disable-gpu 组合可以稳定跑完 OfflineAudioContext 渲染，
//     且音频数据与有头模式一致。
// 所以这里只需保留 headless 兼容所需的最小设置。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-dev-shm-usage');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 800, height: 600,
    webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
  });

  const html = path.join(__dirname, '..', '.folk-test', 'tests', 'folk-host.html');
  const errors = [];
  win.webContents.on('console-message', (_e, lvl, msg) => {
    if (lvl >= 2) errors.push(msg);
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    fs.writeFileSync(OUT, JSON.stringify({ fatal: 'render-process-gone ' + d.reason }, null, 2));
    app.exit(3);
  });

  await win.loadFile(html);

  // 等引擎挂载完成
  let ready = false;
  for (let i = 0; i < 60; i++) {
    ready = await win.webContents.executeJavaScript('!!window.FOLK').catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  if (!ready) {
    fs.writeFileSync(OUT, JSON.stringify({ fatal: 'window.FOLK 未挂载', errors }, null, 2));
    app.exit(4);
  }

  // 把测量逻辑注入页面
  //
  // 允许用 FOLK_SCRIPT 指定别的脚本，这样临时诊断不用覆盖正式测量脚本。
  // 之前调试时反复把 folk-measure.js 改写成一次性诊断代码，
  // 测完留下一堆无用的临时文件，正式脚本也被覆盖没了。
  const scriptPath = process.env.FOLK_SCRIPT
    ? path.resolve(__dirname, process.env.FOLK_SCRIPT)
    : path.join(__dirname, 'folk-measure.js');
  const script = fs.readFileSync(scriptPath, 'utf8');
  try {
    const r = await win.webContents.executeJavaScript(script);
    fs.writeFileSync(OUT, JSON.stringify({ result: r, errors }, null, 2));
    app.exit(0);
  } catch (e) {
    fs.writeFileSync(OUT, JSON.stringify({ fatal: '测量脚本异常: ' + e.message, errors }, null, 2));
    app.exit(5);
  }
});

setTimeout(() => { app.exit(9); }, 120000);
