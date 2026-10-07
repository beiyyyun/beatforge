# BeatForge

浏览器里的音乐工作站。通道机架、步进序列器、钢琴卷帘、编曲助手、录音识别、混音台，
7 种合成引擎 / 36 个音色预设全部实时合成，零采样文件。

音色分九类：鼓组、贝斯、主音、氛围、键盘，以及拨弦、拉弦、吹管、击弦
四类传统民族乐器（古筝、琵琶、阮、二胡、板胡、竹笛、箫、唢呐、笙、扬琴）。

新增一种乐器只需两处改动：在 `src/audio/` 实现 `InstrumentEngine` 接口，
再在 `src/audio/register.ts` 加一条注册。引擎、导出、音色面板、图层
均不需要修改 —— 这条约束由 `tests/registry-check.mjs` 自动校验，
一旦有人在调用方写回 `instrument === 'xxx'` 硬判断就会失败。

## 许可证

[MIT](LICENSE) © 2026 beiyyun

可以自由使用、复制、修改、合并、发布、分发、再许可、出售，
也可以闭源商用，只需保留版权声明与许可声明。

## 从源码运行

需要 **Node.js 22.12 或更高**（Electron 44 的硬性要求；Vite 8 另支持 20.19+，
但 Electron 那条更严格，取交集即为 22.12+）。

```bash
git clone https://github.com/beiyyyun/beatforge.git
cd beatforge
npm install
npm run dev          # 浏览器打开开发服务器
```

打 Windows 可执行文件（见下文"重新打包 exe"）：

```bash
npm run pack:win     # 产出 BeatForge-win/BeatForge.exe
```

## 三种运行方式

### 1. Windows 可执行文件（推荐）

**免安装版**（368MB，整个文件夹拷到哪都能跑）：

```
studio/BeatForge-win/BeatForge.exe
```

直接双击。首次运行如果窗口白屏或打不开，用软件渲染模式启动：

```
set BEATFORGE_SOFTWARE_RENDER=1
BeatForge-win\BeatForge.exe
```

### 2. 本地开发

```bash
npm install
npm run dev          # 开发服务器，改代码即时热更新
```

### 3. 静态网页

```bash
npm run build
```

产出在 `dist/`，**可以双击 dist/index.html 直接打开**（已实测验证），
也可以部署到任意静态服务器。

## 排错

| 现象 | 原因与解决 |
|---|---|
| 双击 exe 没反应 | 环境变量 `ELECTRON_RUN_AS_NODE=1` 会让 Electron 以纯 Node 模式运行。启动前 `set ELECTRON_RUN_AS_NODE=` 清除即可。主进程已内置清除逻辑，但极少数环境下仍需手动清 |
| 窗口白屏 / 双击 exe 秒退 | GPU 进程崩溃（退出码 0xC0000005）。用 `set BEATFORGE_SOFTWARE_RENDER=1 && BeatForge.exe` 启动。注意 `--use-angle=swiftshader` 在 Windows 上不管用（会被当成 Node 的 bad option 拒绝） |
| 内容区显示 `ERR_FILE_NOT_FOUND - 文件不存在` | 旧版本主进程路径多退一层目录，找的是 `resources/dist/index.html`（实际在 `resources/app/dist/`）。已修复为按候选路径探测。若仍出现，确认 `resources/app/dist/index.html` 存在 |
| 弹「BeatForge 启动失败」 | `dist` 目录缺失。重新执行 `npm run build` |
| 卡在"正在启动音频引擎" | 旧版本产物（用了绝对路径 `/assets/`）。重新 `npm run build` |
| 音频没声音 | 浏览器自动播放策略要求先点击或按键一次，音频引擎才会启动 |

## 重新打包 exe

```bash
npm run pack:win
```

`BeatForge-win/`、`release*/` 等打包产物**不在版本库里**（含 300MB+ 的
Electron 运行时，提交会让仓库膨胀到 GB 级）。clone 之后自己跑上面这条命令生成。

**为什么用 `manual-pack.mjs` 而不是 electron-builder**：
electron-builder 在本机环境下稳定失败于 `EPERM: rename win-unpacked.tmp ->
win-unpacked`（解压 200MB+ 运行时后 Windows Defender 仍在扫描新写入的 exe，
句柄未释放）。已验证同目录下小目录的 rename 正常，所以不是权限配置问题。
手动打包做的正是 electron-builder 的核心四步：复制运行时 → 改 exe 名 →
替换默认应用壳 → 写入元数据。

若你的环境能正常跑 electron-builder，直接 `npm run package` 即可。

## 采样率

导出 WAV 默认 **44100Hz / 16bit / 立体声**，即 CD 音质。这是音乐制作的标准规格，
实测确认（WAV 文件头读取验证）。

如需 48kHz（视频制作常用），在 `src/audio/export.ts` 的 `exportWav` 中传入
`sampleRate: 48000` 即可。`OfflineAudioContext` 原生支持任意采样率，无需重采样。

**注意**：采样率数字不等于音质。听起来发闷通常不是采样率问题，
而是某条轨道开了失真且 tone 拉低——`fx.ts` 里的失真低通在 tone=0 时
截止频率只有 700Hz，会把 700Hz 以上全部砍掉。实测导出文件 16kHz 以上
能量为 -89dB，指向的就是这条低通，而不是采样率不足。

## 录音识别的音域限制

麦克风转音符的识别范围约 **#B1 ~ G#5**（61.7Hz ~ 830Hz），两个八度出头。

超出范围的音会被**明确拒绝**而不是猜一个错的。这是刻意的取舍：
错误音高比缺音更让人难受。上限 830Hz 是实测标定的结果，
再往上（880Hz 以上）自相关峰会摊平，算法会"自信地选错"一个低八度的值。

## 已知限制

- 录音分析在主线程同步计算，10 秒录音约需 200~400ms，期间界面会短暂无响应
- 浏览器自动播放策略要求先有一次点击/按键，音频引擎才会启动
- 1300Hz 附近的折叠检测有盲区（周期恰好落在两个整数 lag 正中间），
  该频率远超人声范围，不影响正常使用

## 技术栈

- Vite + TypeScript（无框架，直接操作 DOM）
- Web Audio API 全量实时合成。7 种引擎：减法合成 / 2 算子 FM / 鼓组 /
  拨弦（物理弦模型+AudioWorklet）/ 拉弦（颤音揉弦）/ 吹管（气声+噪声）/ 击弦（轮音）
- 算法生成混响 IR（`ConvolverNode` + 指数衰减包络，不加载 IR 文件）
- AudioWorklet 负责弦模型与滤波器反馈环（`BiquadFilter` 放反馈环会指数发散）
- OfflineAudioContext 离线渲染导出
- Electron 打包为 Windows exe
- 零运行时依赖

## 目录结构

```
studio/
├─ src/
│  ├─ audio/       音频引擎：合成器、效果器、录音、导出
│  ├─ core/        状态管理、和弦库、音高分析、工程数据
│  ├─ ui/          界面组件
│  ├─ main.ts      入口：组装界面、接线、快捷键
│  └─ style.css    全部样式
├─ electron/       Electron 主进程（type:commonjs 作用域）
├─ BeatForge-win/  打包产物（免安装版，不入版本库）
├─ build/          图标
├─ tests/
│  ├─ selfcheck.ts            493 项单元断言
│  ├─ folk-spectrum.mjs       民乐物理特征测量（频谱质心/衰减/颤音/气声比）
│  ├─ folk-measure.js         上者的测量脚本（由 folk-run.mjs 驱动）
│  ├─ folk-diag-starttime.js  离线渲染的起音时刻回归
│  ├─ registry-check.mjs      乐器注册表校验 + 调用方硬编码扫描
│  ├─ verify-ui.mjs           headless 加载真实产物，读真实 DOM
│  ├─ check-relative-paths.mjs 产物资源路径检查
│  ├─ verify-package.mjs      打包产物验证（离线结构 + 真实 exe 启动）
│  └─ folk-run.mjs测量脚本通用宿主
├─ manual-pack.mjs 手动打包脚本
└─ vite.config.ts
```

## 打包

```bash
npm run pack:win        # 构建 + 打包（等价于 build 后跑 manual-pack.mjs）
npm run verify          # 路径检查 + 打包产物验证
```

注意 `npm run package`（electron-builder）在本机会稳定失败于 EPERM，已改为提示信息。

## 自检

```bash
node build-test.mjs
node .selfcheck-dist/selfcheck.mjs
```

覆盖和弦库、叠加层、录音分析、量化、撤销重做、工程序列化等，共 493 项断言。

产物与民乐验证：

```bash
node tests/check-relative-paths.mjs                       # 路径与 crossorigin
node tests/registry-check.mjs                             # 乐器注册表 + 无硬编码
node tests/folk-spectrum.mjs                              # 民乐物理特征（13 用例）
node tests/verify-ui.mjs                                  # headless 真实 DOM
npm run verify                                            # 打包产物（含真实 exe 启动）
```

`folk-spectrum.mjs` 是民乐的物理测量：每个乐器的音高误差、频谱质心、
T60 衰减、颤音频率与深度、气声比、轮音深度都是**实测值**，
不是"听起来差不多"调的。改`src/audio/presets.ts` 里的乐器参数前，
必须先跑它，改完必须复测。
