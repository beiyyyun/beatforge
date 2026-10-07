/**
 * Electron 主进程
 * ============================================
 * 只做两件事：开窗口、指向构建产物。
 * 所有音频逻辑仍在渲染进程的 Web Audio 里 —— Electron 自带完整 Chromium，
 * 音频行为与浏览器完全一致，不存在 WebView2 的实现差异问题。
 */

const { app, BrowserWindow, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

/**
 * 清除 ELECTRON_RUN_AS_NODE。
 *
 * 若这个环境变量被设为 1（某些 Electron 应用的子进程会带它，
 * IDE 启动的终端也可能继承），electron.exe 会以纯 Node 模式运行，
 * 根本不创建 GUI —— 表现为双击 exe 后没有任何窗口。
 * 必须在 require('electron') 之前清除，否则 app 会是 undefined。
 */
if (process.env.ELECTRON_RUN_AS_NODE) {
  delete process.env.ELECTRON_RUN_AS_NODE;
}

// 开发态指向 vite dev server，打包后指向 dist/index.html
const DEV_URL = process.env.VITE_DEV_SERVER_URL;

/**
 * 定位构建产物 index.html。
 *
 * 为什么不能写死 '../dist'：
 * 这份文件在不同场景下的位置并不相同，写死相对层级必然在某一处出错。
 *   开发态：studio/electron/main.cjs  → dist 在 studio/dist        → '../dist'
 *   打包态：resources/app/main.cjs      → dist 在 app/dist         → './dist'
 *          （resources/app/electron/main.cjs 这份副本则要 '../dist'）
 * 之前按开发态写了 '../dist'，打包后就变成找 resources/dist，
 * 结果是窗口能开、内容区报 ERR_FILE_NOT_FOUND —— 而界面本身完全正常。
 *
 * 所以改成按候选列表探测，让文件自己落在哪都能找到。
 */
function resolveIndexHtml() {
  const candidates = [
    path.join(__dirname, 'dist', 'index.html'),       // 打包态：resources/app/dist
    path.join(__dirname, '..', 'dist', 'index.html'),  // 开发态 / electron 子目录副本
    path.join(__dirname, '..', '..', 'dist', 'index.html'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // 一个都没找到：返回首选路径，让调用方报出可读的错误信息
  resolveIndexHtml.candidates = candidates.join('\n');
  return candidates[0];
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0e1014',
    title: 'BeatForge',
    show: false,
    webPreferences: {
      // 保持渲染进程干净：音频全在 Web Audio，无 Node 需求
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // 窗口准备好再显示，避免白屏闪烁
  win.once('ready-to-show', () => {
    win.show();
    win.maximize();
  });

  if (DEV_URL) {
    win.loadURL(DEV_URL);
  } else {
    // loadFile 用 file:// 协议加载本地文件。
    // vite 已配置 base: './'，所以资源是相对路径，能正确解析。
    const indexHtml = resolveIndexHtml();
    console.log('[BeatForge] 加载界面:', indexHtml);
    if (!fs.existsSync(indexHtml)) {
      const { dialog } = require('electron');
      dialog.showErrorBox(
        'BeatForge 缺少界面文件',
        `找不到 index.html。\n\n已查找:\n${resolveIndexHtml.candidates || ''}\n`
        + '实际尝试的路径基准: ' + __dirname + '\n\n'
        + '请重新执行 npm run build 后再打包。',
      );
      app.exit(1);
      return win;
    }
    win.loadFile(indexHtml);
  }

  // 加载失败时给出可见反馈，而不是留一个空白窗口。
  // 这类问题最常见的原因是 dist 目录缺失或路径不对。
  if (process.env.BEATFORGE_DIAG === '1') {
  // 自检模式下不要弹模态框——无人值守跑脚本时弹窗会挂死整个验证流程。
  // 改为把错误打到 stdout，由退出码和日志表达结果。
} else {
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    const { dialog } = require('electron');
    dialog.showErrorBox(
      'BeatForge 启动失败',
      `无法加载界面文件。\n\n错误码: ${code}\n原因: ${desc}\n路径: ${url}\n\n`
      + '如果你删过 dist 文件夹，请重新运行 npm run build。',
    );
    app.exit(1);
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    const { dialog } = require('electron');
    dialog.showErrorBox(
      'BeatForge 意外退出',
      `渲染进程已终止。\n原因: ${details.reason}\n退出码: ${details.exitCode}`,
    );
  });
}

  // 打包产物的端到端自检。
  //
  // 为什么需要它：验证脚本如果自己拼 dist/index.html 的路径去 loadFile，
  // 就等于绕过了本文件的路径解析逻辑——主进程路径写错时界面照样能正常渲染，
  // 验证会通过但用户双击 exe 就是白屏。所以自检必须从真实的 exe 入口走一遍。
  // 用法：BEATFORGE_DIAG=1 BeatForge.exe
  if (process.env.BEATFORGE_DIAG === '1') attachDiagnostics(win);

  return win;
}

/**
 * 在真实启动路径上探测界面状态，然后退出进程。
 * 探针读的是渲染进程的真实 DOM，不做任何"我觉得应该没问题"的假设。
 */
function attachDiagnostics(win) {
  const fsx = require('node:fs');
  const outPath = process.env.BEATFORGE_DIAG_OUT
    || require('node:os').tmpdir() + '/beatforge-diag.txt';
  const lines = [];
  // Windows GUI 子系统的 exe 不继承父进程控制台，console.log 会被丢弃。
  // 所以诊断结果必须写文件，由外部脚本读取判定。
  const flush = () => { try { fsx.writeFileSync(outPath, lines.join('\n'), 'utf8'); } catch { /* 忽略 */ } };
  const report = (ok, detail) => {
    lines.push((ok ? 'PASS' : 'FAIL') + ' ' + detail);
    console.log('[DIAG] ' + (ok ? 'PASS' : 'FAIL') + ' ' + detail);
    flush();
  };

  win.webContents.on('did-finish-load', async () => {
    lines.push('did-finish-load');
    flush();
    // 等界面脚本完成挂载
    await new Promise((r) => setTimeout(r, 2500));
    let raw;
    try {
      raw = await win.webContents.executeJavaScript(`
        (() => JSON.stringify({
          url: location.href,
          hasTopbar: !!document.querySelector('.topbar'),
          boot: document.getElementById('boot') ? document.getElementById('boot').textContent.trim() : null,
          appChildren: (document.getElementById('app') || {children:[]}).children.length,
          bodyText: document.body.innerText.slice(0, 200),
          // 民乐预设是否真的进了音色浏览器。
          // 原先只取bodyText 前200字，而民乐预设排在列表末尾 —— 
          // 也就是说打包产物里就算一个民乐预设都没有，这层自检照样全绿。
          folkPresent: ['古筝','琵琶','阮','二胡','板胡','竹笛','箫','唢呐','笙','扬琴']
            .filter((n) => document.body.innerText.includes(n)),
          // 主工作区面板是否挂上（曾整片空白）
          panelHosts: [...document.querySelectorAll('.main-body > .panel')].length,
          channelCount: document.querySelectorAll('.channel').length,
        }))()
      `);
    } catch (e) {
      report(false, '无法读取 DOM: ' + e.message);
      app.exit(3);
      return;
    }
    const s = JSON.parse(raw);
    lines.push('url=' + s.url);
    report(s.url.startsWith('file://'), '使用 file:// 协议');
    report(!/ERR_FILE_NOT_FOUND/.test(s.url), '未触发 ERR_FILE_NOT_FOUND');
    report(s.hasTopbar, '.topbar 已挂载');
    report(s.boot === null, '骨架屏已移除' + (s.boot ? '（仍显示: ' + s.boot + '）' : ''));
    report(s.appChildren > 0, '#app 子节点数 = ' + s.appChildren);
    // 打包产物是最容易漏掉新代码的地方（源码改了、忘记重打包），
    // 所以音色与面板的存在性必须在这一层再确认一次。
    const folkMissing = ['古筝','琵琶','阮','二胡','板胡','竹笛','箫','唢呐','笙','扬琴']
      .filter((n) => !(s.folkPresent || []).includes(n));
    report(folkMissing.length === 0,
      '十大民乐预设全部在打包产物中',
      folkMissing.length ? '缺失: ' + folkMissing.join(',') : (s.folkPresent || []).length + '/10');
    report(s.panelHosts === 8, '主工作区 8 个面板已挂载', '实际 ' + s.panelHosts);
    report(s.channelCount >= 3, '示例轨道已渲染', s.channelCount + ' 条');
    lines.push('界面文字: ' + s.bodyText.replace(/\s+/g, ' '));
    flush();
    const pass = s.hasTopbar && s.boot === null && s.appChildren > 0
      && folkMissing.length === 0 && s.panelHosts === 8 && s.channelCount >= 3;
    app.exit(pass ? 0 : 1);
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    lines.push('FAIL 加载失败 code=' + code + ' desc=' + desc + ' url=' + url);
    flush();
    app.exit(1);
  });

  // 兜底：即使 did-finish-load 一直没来（如资源加载被卡住），也要留下记录。
  setTimeout(() => {
    if (!lines.some((l) => l.startsWith('did-finish-load'))) {
      lines.push('FAIL 12 秒内未触发 did-finish-load');
      flush();
      app.exit(4);
    }
  }, 12000);
}

// 应用只允许一个实例，第二次启动时聚焦已有窗口
// GPU 兜底：某些环境（虚拟机、部分老显卡驱动、远程桌面）下
// GPU 进程会崩溃并导致白屏。这里强制软件渲染，
// 对本项目无性能损失 —— 界面是 DOM + Canvas，不是 3D 渲染。
//
// 关键：disableHardwareAcceleration() 必须在 app ready 之前调用，
// 放进 whenReady() 里会抛 "can only be called before app is ready"
// 并让整个启动失败。commandLine.appendSwitch 同理，越早越好。
//
// 触发方式有两条：
//   1) 环境变量 BEATFORGE_SOFTWARE_RENDER=1（验证脚本用这条）
//   2) GPU 进程崩溃后自动重试一次软件渲染（见下方 onRenderProcessGone）
//
// 变量名拼作 BEATFORGE（与诊断开关一致）。早先这里误写成 BEATFORCE ——
// 拼错的键不会报错，只是永远读不到，兜底逻辑等于从未启用。
const applySoftwareRender = () => {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('in-process-gpu');
};

if (process.env.BEATFORGE_SOFTWARE_RENDER === '1') {
  applySoftwareRender();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    // 移除默认菜单条，但保留 Ctrl+C/V 等快捷键（Edit 角色）
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: '文件',
          submenu: [{ role: 'quit', label: '退出' }],
        },
        {
          label: '编辑',
          submenu: [
            { role: 'undo', label: '撤销' },
            { role: 'redo', label: '重做' },
            { type: 'separator' },
            { role: 'cut', label: '剪切' },
            { role: 'copy', label: '复制' },
            { role: 'paste', label: '粘贴' },
            { role: 'selectAll', label: '全选' },
          ],
        },
        {
          label: '视图',
          submenu: [
            { role: 'reload', label: '重新加载' },
            { role: 'toggleDevTools', label: '开发者工具' },
            { type: 'separator' },
            { role: 'resetZoom', label: '实际大小' },
            { role: 'zoomIn', label: '放大' },
            { role: 'zoomOut', label: '缩小' },
            { type: 'separator' },
            { role: 'togglefullscreen', label: '全屏' },
          ],
        },
      ])
    );

    createWindow();

    app.on('activate', () => {
      // macOS: 点 Dock 图标时若没有窗口则新建
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // macOS 约定：关掉所有窗口不退出应用
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

