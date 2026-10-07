/**
 * 界面自检宿主（Electron 主进程侧）。
 * 由 tests/verify-ui.mjs 以 --headless 启动。
 *
 * 关键约束：必须 loadFile 真实 dist/index.html，而不是自己拼一个页面。
 * 自己拼页面只能验证"测试页能跑"，验证不了"用户看到的界面是否正确"——
 * 那正是历史上掩盖过 bug 的做法。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const INDEX = process.env.UI_INDEX;
const OUT = process.env.UI_OUT;

function write(payload) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  const consoleErrors = [];
  win.webContents.on('console-message', (e) => {
    // level 3 = error
    const lvl = typeof e === 'object' && e !== null ? e.level : undefined;
    if (lvl === 3 || lvl === 'error') {
      consoleErrors.push(String((e && e.message) || e));
    }
  });

  win.webContents.on('did-fail-load', (_e, code, desc) => {
    write({ fatal: `did-fail-load ${code}: ${desc}` });
    app.exit(1);
  });

  try {
    await win.loadFile(INDEX);
  } catch (e) {
    write({ fatal: 'loadFile 抛错: ' + (e && e.message) });
    app.exit(1);
    return;
  }

  // 等界面渲染完：主入口同步构建 DOM，最多给 2s
  await new Promise((r) => setTimeout(r, 2000));

  let result;
  try {
    result = await win.webContents.executeJavaScript(`
      (() => {
        const out = {};
        // 音色浏览器：分类标题 + 预设卡片名
        const sections = [...document.querySelectorAll('.browser-section')];
        out.categories = sections.map((e) => e.textContent.trim());
        const names = [...document.querySelectorAll('.preset-name')].map((e) => e.textContent.trim());
        out.presetNames = names;
        const FOLK = ['古筝','琵琶','阮','二胡','板胡','竹笛','箫','唢呐','笙','扬琴'];
        out.folkPresetCount = FOLK.filter((n) => names.includes(n)).length;
        // 通道机架。取不到就报 0，由驱动侧判定失败 ——
        // 不猜 class 名去凑一个非零值，那样断言就失去了意义。
        out.trackCount = document.querySelectorAll('.channel').length;
        out.trackNames = [...document.querySelectorAll('.channel-name')].map((e) => e.textContent.trim());
        out.hasRack = !!document.querySelector('.rack');
        out.rackChildCount = document.querySelector('.rack')
          ? document.querySelector('.rack').children.length : -1;
        // 面板宿主：每个主标签一个 .panel[data-panel]。
        // 之前 main.ts 从没把这些面板挂进 mainBody（整个主工作区是空的），
        // 所以这里按 data-panel 逐个核对，8 个都必须存在。
        const hosts = [...document.querySelectorAll('.main-body > .panel')];
        out.panelHostIds = hosts.map((e) => e.getAttribute('data-panel'));
        out.panelHostCount = hosts.length;
        out.visiblePanelIds = hosts.filter((e) => !e.hidden).map((e) => e.getAttribute('data-panel'));
        // 首屏默认标签是不是"通道"。class 是 main-tab（不是 tab）。
        const tabs = [...document.querySelectorAll('.main-tab.is-active')].map((e) => e.textContent.trim());
        out.activeMainTab = tabs;
        out.isRackTab = tabs.some((t) => t.includes('通道'));
        // 拿不到模块内部状态时如实报告，不猜
        out.loaded = !!document.querySelector('.preset-name');
        return out;
      })()
    `);
  } catch (e) {
    write({ fatal: 'executeJavaScript 抛错: ' + (e && e.message) });
    app.exit(1);
    return;
  }

  result.loaded = result.loaded || result.folkPresetCount > 0;
  result.loadError = '';
  result.consoleErrors = consoleErrors;
  write(result);
  app.exit(0);
});

app.on('window-all-closed', () => app.exit(0));
setTimeout(() => {
  write({ fatal: '宿主超时（30s）' });
  app.exit(1);
}, 30000);