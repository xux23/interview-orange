# 面试橙 · 独立环境

依据 `../reverse-engineered/` 文档集（01~25 号）对 面试橙（Tauri 2 桌面端，v0.3.25）的重实现。
本仓库**完全自包含**：自带依赖、自带 SQLite 数据、自带端口（8756）、自带提示词数据，不影响也不读取任何原安装。

提供**两套前端**：

| 路径 | 前端 | 说明 |
|---|---|---|
| `/`（#main 等） | 自研 UI（React 18 + Vite） | 代码可读、可改，四窗口模型与协议对齐文档 |
| `/legacy/` | **原版前端原样挂载**（`../reverse-engineered/www`） | 注入 Tauri 桩后原版 UI 直接跑在本项目后端上 |

```
面试橙/
├── server/             Node（零原生依赖）：node:http + express + node:sqlite + Socket.IO
│   ├── trpc/           tRPC v11 兼容层（101 个过程；单请求 + 批量 JSONL 惰性流双协议）
│   ├── ai/             官方提示词加载、systemPrompt 组装、mock/OpenAI 双 provider
│   ├── socket.js       root（面试）/desktop（笔试）双 namespace，逐字流式
│   ├── legacy-shim.js  原版前端挂载桩（54 cmd_* + 事件/store/OS 插件 + 网络重定向）
│   ├── db.js + seed.js 对齐 prisma AiSession 模型 + 演示数据
│   └── index.js        服务入口（tRPC / 上传 / /legacy / 静态前端 / Socket）
├── web/                自研 UI（React 18 + Vite，hash 分身四窗口）
├── public/             构建产物（npm run build 生成）
├── data/               app.db（SQLite）+ prompts（13 语言官方 presets）+ screenshots + uploads
├── scripts/            smoke.mjs（端到端冒烟）、socket-events.mjs（43 事件矩阵+真实转写）、asr-separation.mjs（双路说话人分离）、real-ai-e2e.mjs（真模型全链路）、ai-config-e2e.mjs / asr-config-e2e.mjs（配置中心热切换）、legacy-shot.mjs、cdp-*.mjs
├── native/             Rust 原生壳（唯一桌面路线：tao+wry，WDA/panic/伪装/WASAPI/焦点钩子）
├── 启动.bat / 启动.ps1  便携启动器（双击 = 服务 + Rust 原生壳）
└── shell/              浏览器降级方案（Edge --app + Win32 置顶）
```

## 快速开始

```powershell
cd 面试橙
npm install            # 独立 node_modules，不污染全局
npm run build          # 构建自研前端到 ./public
node server/index.js   # 首次启动自动建表 + seed
# 打开 http://127.0.0.1:8756          → 自研 UI
#     http://127.0.0.1:8756/legacy/   → 原版前端挂载（桩兼容 token）

# 或直接双击 启动.bat（= 自动起服务 + Rust 原生壳：原生浮窗/热键/防截屏/伪装）
#     命令行等价：powershell -ExecutionPolicy Bypass -File 启动.ps1
#     重新编译壳：.\启动.ps1 -Build    WDA 自检：.\启动.ps1 -SelfTest 1
```

- **账号模块已移除（2026-11-23）**：无登录/订阅/充值/额度——本地单用户直接用；`user.getTempToken` / `loginByTempToken` 降级为兼容桩（固定哑 token），`/legacy` 原版前端与既有测试脚本零改动继续工作
- 端口、数据目录、AI provider 都可在 `.env` 覆盖（见 `.env.example`）；AI 接入另可在**设置页运行时覆盖**（写 `data/app.db`，热切换、无需重启）
- 端到端自检：`node scripts/smoke.mjs`（当前 17 项全 PASS）

## 原版前端挂载（/legacy）——文档 8.5「浏览器桩」的服务端重实现

原版 UI 是压缩后的成品 bundle（无 sourcemap），不能直接改，但它**能直接运行**——缺的只是 Tauri 运行时。
`server/legacy-shim.js` 在页面加载前注入，补齐原版对宿主的全部期待：

| 层 | 实现 |
|---|---|
| `__TAURI_INTERNALS__`（invoke/transformCallback/metadata） | 54 个 `cmd_*` 全量浏览器语义，原生不可行者返回安全默认值 |
| `__TAURI_EVENT_PLUGIN_INTERNALS__` / `__TAURI_OS_PLUGIN_INTERNALS__` | 事件反注册、OS 信息直读全局 |
| 事件总线 | `plugin:event|listen/emit` + BroadcastChannel 跨标签（模拟 Tauri emit/listen） |
| store 插件 | `plugin:store|*` → localStorage 后端，v2 契约 `[value, exists]` 元组 |
| 子窗口 | `plugin:webview|create_webview` → `window.open`（overlay 弹出窗） |
| 网络定向 | fetch/XHR/WebSocket 三层拦截：`api.mianlingai.com`/`api.aceround.app` → 本地 |
| 鉴权 | 模块启动前同步 XHR 预取 token，按原版持久化钩子格式（JSON 字符串）写入 |
| 竞态防护 | jZ 壳渲染期 `kZ('')` 会先于 hydrate 删 token，启动期对非空 token 的删除吞掉 |
| 热更协议 | `enter_hot_ui` 抛错 → 原版留在内置前端（等价旧 serve.js 的无 Tauri 模式） |

服务端为原版客户端补了两件协议能力（自研 UI 不受影响）：

1. **tRPC v11 批量 JSONL 惰性流**：原版 `httpBatchStreamLink` 恒发 `trpc-accept: application/jsonl`，
   响应为逐行 `\n` 结尾的 superjson 惰性载荷（header 行声明 deferred id，后续行按引用链投递，错误内联）。
   按线上抓包逐字节还原；无该头则回落普通 JSON 数组。
2. **superjson meta 解包**：可选参数缺省时原版发 `null + meta.values:["undefined"]`，
   还原为真 undefined，避免 zod 校验误报。

实测（`shots/legacy-workbench.png`）：原版工作台完整渲染——面试/笔试/模拟面试入口、现有会话（本地库）、
简历/岗位选择、轮次枚举、线上/电话模式、剩余额度（本地计费）、公告横幅与「使用须知」5s 倒计时弹窗，全部走本地后端。

> 已知边界：截屏/系统音频/防检测等原生能力在浏览器挂载模式下为桩；原版 UI 的「进入面试」
> 会尝试创建原生窗口（桩转为弹出窗）；OS 版本提示条为装饰性误报。

## 四类窗口（同一份前端，靠 hash 分身）

| hash | 用途 | 说明 |
|---|---|---|
| `#main` | 工作台 | 记录 / 题库 / 资料 / 提示词工作室 / 设置 |
| `#overlay` | 浮窗 | 透明置顶；实现 seq 门禁握手 + 样式热键 + 一题一卡 |
| `#mock` | 模拟面试房间 | Socket 出题 / AI 辅助回答 / 作答 / 结束出报告 |
| `#mock-exam` | 笔试房间 | 截屏或粘贴题面 → `/desktop` namespace 解题 → 浮窗出答案 |

窗口之间用 `BroadcastChannel('interview-orange-bus')` 模拟 Tauri 的 `emit/listen`；Rust 原生壳
**预建 overlay 窗口**（无边框/置顶/不进任务栏/WDA 默认开），`#overlay` 由 `overlay.show` 激活。

## 已实现（对照文档）

| 能力 | 文档 | 实现 |
|---|---|---|
| 三窗口模型 + 启动状态机 | 02 | `web/src/lib/bridge.js`、`main.jsx` |
| 浮窗门禁（seq/心跳/sessionReady/三路激活） | 03 | `OverlayWindow.jsx` + `createOverlayGate()` |
| 浮窗样式（OverlayStyle 全字段 + 热键 patch 管线） | 03 | `settings` + `Ctrl+Alt` 组合键 |
| 会话生命周期（ACTIVE→COMPLETED、续接、报告） | 04/09 | `trpc/session.js` |
| tRPC 96 过程契约（92 个已挂载，含鉴权/限流/错误码） | 07 | `trpc/*` |
| Socket 双 namespace + `*Start→多次→*End` 流式 | 08 | `socket.js` |
| 笔试截图解题（reasoning/delta/end/quota，扣 2 分钟） | 08 | `socket.js` + `ExamRoom.jsx` |
| DB Schema（AiSession 全字段 + 关联模型） | 09 | `db.js`（node:sqlite） |
| 官方提示词 13 语言 / 4 面试风格 / 4 笔试风格 / 24 预设 | 10 | `data/prompts/*.json`（原样拷贝） |
| 面试答题 systemPrompt **官方拼装**（基础段 + 语言与转写 + 我的资料 + 风格前半 + 每一轮规则；自定义提示词路径同官方；zh/en 与线上官方逐字一致，仅首尾空行差异） | 20 + chain/online-interview | `ai/prompts.js` |
| 知识库注入（`【知识库：…】` / full-retrieval 双档） | 20 | `ai/prompts.js#buildKnowledge` |
| promptStudio 三过程 + 限流（run 6/min、assist 3/min） | 20/22 | `trpc/misc.js` |
| exam 24 预设策略（coding/choice/fill/ai_coding/psych…） | 22 | `ai/prompts.js` + `ai/mockBrain.js` |
| 客户端配置（localStorage + store.json 等价物 + 导入导出） | 06 | `SettingsPage` |
| **隐蔽与防检测**：WDA 防截屏 / panic 全窗隐藏 / 窗口+进程伪装 / 任务栏隐藏 | 05/15/24 | `native/src/win.rs` + 设置页 StealthPanel（实机验证） |
| 题库 / 押题 / 资料 / 官方资料库 / 求职进度 / 评分反馈 | 07/16/17 | `trpc/bank.js`、`resource.js` |
| Socket 全事件矩阵（43 项；ai.webSearch 假触发已移除，ai.interrupt 为真打断；prewarm/mergePrev/onMsg/turnKind、stt.data/pending/changed/turnEnd/speaker、audio.requestPermission、exam.session/error、perf.ping） | 08/23 | `server/socket.js` + `scripts/socket-events.mjs`（mock 43/43 PASS） |
| 转写落库（InterviewTranscript） | 09 | `trpc/session.js#insertTranscript`（实测 transcripts 表有行） |
| **真实语音识别（STT）**：能量 VAD 切句 → 整句转写 → 官方事件序列 | 23 | `server/ai/asr.js`（qwen3.5-omni-flash，实测中/英全对、~0.7s/句）+ `socket.js` VAD 管线 + `web/src/lib/voice.js` 采集（麦克风/共享音频） |
| 复盘报告 schema（status + fiveDimensions×5 + strengths/shortcomings×3 + suggestions×5 + relatedKnowledge×13 + conversationAnalysis） | 23 §9.2 | `ai/mockBrain.js#buildReport`（新建会话实测逐段/五维/知识点全对） |
| 报告导出 Markdown（DH 等价） | 23 §9.2 | `MainApp.jsx#exportReportMarkdown` |
| 公告 5min 轮询 / 使用须知 5s 倒计时（收银台与 refreshToken 轮询已随账号模块移除） | 06 §5 | `MainApp.jsx`、`server/index.js` |
| 浮窗 zones（350ms + JSON diff）、Alt+方向键移动、auto-palette（capture→suggestPalette→undo） | 03 §4/§5 | `OverlayWindow.jsx`（CDP 实测 zones=[body]，autoPalette 存在） |
| 押题流式订阅（prediction.item×N → end） | 17 | `socket.js` + 题库页（实测 12 条流式 PASS） |
| **押题生成 `questionPrediction.generate`**（简历+JD+题库检索 → 题目与解析） | 19 | `ai/enrich.js#generatePredictionItems` + `trpc/bank.js`（实测 6 题全模型，`source=model`） |
| **视觉配色 `overlay.suggestPalette`**（读壁纸出同色系底色+可读前景） | 21 §2.6 | `ai/enrich.js#generatePalette`（BMP→缩略 PNG 免依赖转码 + `config.ai.visionModel`，实测 `source=vision`） |
| **`tools.stt.stt` 真转写**（audioBase64 / http(s) audioUrl → 文本） | 04/07 | `ai/enrich.js#transcribeAudio`（复用千问 ASR，实测逐字正确） |
| **热词抽取**（JD+简历 → 20 术语 + 4 类目） | 21 §2.4 | `ai/enrich.js#extractHotWords`（实测 `source=model`，20 术语） |
| **岗位推荐**（简历 → 3 个匹配岗位） | 19 | `ai/enrich.js#suggestGoalsFromResume`（实测 3 条模型推荐） |
| **资料问答对生成**（资料 → 问答对） | 18 | `ai/enrich.js#generateMaterialEntries`（实测 3 组模型生成） |
| 副屏路由 `/session/interview/waiting`、`/session/exam/secondary` | 02 §4 | `server/index.js`（200） |
| 热更版本握手（ui-loaded / version-request → 不一致 reload） | 01 §5 | `web/src/lib/bridge.js` |
| PE 图标资源替换（RT_ICON ×2 + RT_GROUP_ICON ×6） | 24 | `native/src/win.rs#replace_icon`（ExtractAssociatedIcon 实测 32×32、中心像素 R99 G86 B192） |

## Rust 原生壳（Tauri 2 框架层，对齐原版技术栈）

`native/` 是 **Tauri 2 原生壳**（tauri 2.12：tao 窗口 + wry WebView2 + tauri 命令层，与原版同框架），
前端 shim（`orangeNative`）经 `window.__TAURI_INTERNALS__.invoke` 走单一 `ipc` 命令进入
`win.rs` 的 43 命令分发（含 54 个原版 `cmd_*` 名称映射）。

- **远程 IPC 放行**（Tauri v2 对外部 http 域默认禁 IPC）：`capabilities/default.json` 声明
  `remote.urls`（http://127.0.0.1:*）+ `permissions/default.toml` 放行 `ipc` 命令
- **构建链自包含**：rust-lld 链接；windres/gcc 不认中文路径，由项目内 `.tools/bin/` 的改写 shim
  解决——`windres`（含 `x86_64-w64-mingw32-windres` 同名）shim 把 resource.rc 里烙有的
  CARGO_MANIFEST_DIR 真实路径改写成 ASCII junction 后转调真工具（`native/tools/*-shim.c`，
  由 `native/toolchain.ps1` 自动编译）；`gcc` shim 同理改写参数与 `-E` 输出
- WebView2 用户数据目录放项目内 `data/webview`（默认 %LOCALAPPDATA% 在受限环境拒绝访问）

```powershell
powershell -ExecutionPolicy Bypass -File native\run.ps1 -Build   # 构建并启动
powershell -ExecutionPolicy Bypass -File native\run.ps1 -SelfTest 1   # WDA 自检
powershell -ExecutionPolicy Bypass -File native\run.ps1 -SelfTest 3   # IPC 探针
```

| 能力 | 实现 | 实机验证 |
|---|---|---|
| 窗口模型 | main + overlay 预建；overlay 无边框/置顶/不进任务栏 | 窗口枚举确认 |
| **WDA 防截屏** | `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` | 自检：开/关 WDA 两次截屏差 **1,477,065 字节** PASS |
| **WASAPI 系统音频** | `IAudioClient` loopback + `IAudioCaptureClient` RMS 电平 | 播放 440Hz，采集峰值 **2.13** PASS |
| **焦点钩子** | `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` 独立消息循环线程 | 开记事本 → `前台切换 → pid=9072 title=记事本` |
| **panic 热键** | `RegisterHotKey`（Ctrl+Alt+Esc，独立宿主窗口线程） | 真实按键 → `[panic] 已隐藏 1 个窗口` |
| **窗口伪装** | `SetWindowTextW` 改原生标题 | Win32 实证标题 →「记事本」 |
| **进程伪装（含 PE 资源）** | 复制自身 exe + `BeginUpdateResource/UpdateResource` 重写 `VS_VERSIONINFO`（ProductName/FileDescription/OriginalFilename/CompanyName） | `notepad.exe` 属性页读数：ProductName=notepad / FileDescription=notepad / CompanyName=Microsoft Corporation |
| **崩溃恢复握手** | `.recovery` 标记 + `isCrashRecovery` + seq/sessionReady/releaseIfNotReady | `crash:{bootOk:true,isCrashRecovery:false}` |
| **特性开关** | 46 项 flag 表 + `features.list/set` | 返回 **46** |
| IPC 桥 | `__TAURI_INTERNALS__.invoke('ipc')` ⇄ Rust（Tauri 2 命令层） | 探针返回 `shell:"rust-tauri2"` PASS |
| 截屏 | GDI BitBlt → BMP data URL（自带 base64） | 16 MB data URL 返回 |
| **浮窗显隐热键** | `Ctrl+Alt+H` 真切换窗口（置顶 + 可选 WDA），`Ctrl+Alt+Shift+X` 关闭 | 实机按键：`[hotkey] 浮窗显隐 → 显示（seq=N）`，`vis` 由 False→True→False |
| **浮窗透明** | Tauri `transparent(true)` + 页面 `html.overlay{background:transparent}` + 卡片 `rgba(bg,0.85)` | 截图实证：桌面图标/下层窗口透过卡片可见（`shots/overlay-check/overlay-fixed2.png`） |
| 排查开关 | `ML_NO_WDA=1` 全局不防截屏；`ML_OVERLAY_WDA=1` 启动即给浮窗开防截屏；`ML_IPCLOG=1` 打印 IPC | 见 RUN.md |

> **透明 与 防截屏 在系统层互斥**：`WDA_EXCLUDEFROMCAPTURE` 作用在透明窗口上时，部分显卡/DWM
> 组合会把浮窗渲染成纯黑块。因此**浮窗防截屏默认关闭**（保证半透明观感）；需要隐蔽时在
> 设置页「浮窗防截屏」开启，或启动前设 `ML_OVERLAY_WDA=1`——此时浮窗可能变黑/不透明，属预期取舍。

## 隐蔽与防检测（对照文档 05/15/24，唯一桌面路线 = Rust 原生壳）

**隔离与还原**（满足「不污染系统」）：

- Rust 工具链、crates 缓存、构建产物全在 `.tools/`；链接用 **rust-lld 自包含**，不需要 MSVC
- 构建路径动态解析（`native/run.ps1`）：项目路径为纯 ASCII 时直接用真实路径（零外部痕迹）；
  含中文路径时在**任一可用盘符根**自动创建/复用 ASCII junction `<盘符>:\ml-src → <项目根>`
  （`dlltool`/`lld`/`windres` 不认中文路径；产物目录与 TEMP 都经 junction 变 ASCII，
  物理文件仍在项目内，卸载时删除该 junction 即可）
- > **当前状态（2026-11-23 便携化检查后重建）**：`.tools/` 已按 `native/toolchain.ps1` 重建
  > （rustup stable-gnu 1.100 + mingw64 16.2 + windres/gcc 改写 shim），原生壳 exe 已构建并通过
  > WDA SelfTest。若日后再被清除，跑 `powershell -File native\toolchain.ps1` 一条命令即可恢复
  > （rustup 走 rsproxy.cn 镜像、mingw64 走 ghfast.top 中转，国内可达）。

隐蔽能力全部在 `native/`（Rust）实现并实机验证（见上表）：WDA 防截屏（浮窗启动即开）、
`Ctrl+Alt+Esc` panic 全窗隐藏、窗口伪装 + **进程级 PE 伪装**（改名/版本信息/图标）、
任务栏隐藏、WASAPI 系统音频采集、焦点钩子、崩溃恢复握手、46 项特性开关。

设置页「隐蔽与防检测」面板与 `/legacy` 桩的 `cmd_set_capture_excluded` /
`cmd_capture_protection_support` / `cmd_panic_hotkey_status` / `cmd_apply_disguise_title`
在原生壳下经 `win.rs` 的 cmd_* 映射桥接到上述真实现（浏览器下为安全默认值）。

> Electron 路线已于 2026-11-22 移除（其能力为 Rust 壳子集）：`desktop/`、`scripts/desktop.mjs`
> 已删，`electron` 依赖已卸载。桌面启动一律走 `启动.bat`（Rust 原生壳）。

## AI provider

> **超时与打断（2026-11-23 优化）**：所有上游调用带 AbortController 超时——非流式总超时 120s（`ML_AI_TOTAL_TIMEOUT_MS`）、
> 流式首字 30s（`ML_AI_FIRST_TOKEN_MS`）+ 空转 60s（`ML_AI_IDLE_TIMEOUT_MS`）、ASR 60s（`ML_ASR_TIMEOUT_MS`），超时即报错不挂起；
> `ai.interrupt` / `exam.abort` 为**真打断**（AbortSignal 贯穿生成管线，已吐出的增量保留）。流式转发为事件驱动队列（零轮询延迟）。


默认 `mock`：不联网、确定性，按官方输出协议产出「**核心要点** + **参考回答**」与「**答案：** + `[[FOLLOWUP: …]]`」，
用于本地开发与冒烟。本仓库 `.env` 已配置**真实模型**（MaaS 网关，OpenAI 兼容，千问 + DeepSeek 混合选型）：

```ini
ML_AI_PROVIDER=openai
ML_AI_BASE_URL=https://maas.qianwenaiapi.com/compatible-mode/v1   # 任意 OpenAI 兼容网关
ML_AI_API_KEY=sk-...
ML_AI_MODEL=deepseek-v4.1-flash        # 出题/面试答案/笔试文本解题/提示词改写/LLM 报告评分（flash 档，实测最快且答案最具体）
ML_AI_VISION_MODEL=qwen3.5-omni-flash  # 笔试截图识别题面（视觉，2026-11-24 复测：读题/解题延迟约为 3.8-omni 的 1/3，准确率持平）
ML_ASR_MODEL=qwen3.5-omni-flash        # 语音转写（2026-11-24 复测：~0.7s/句，比 3.8-omni 快约 200ms，逐字全对）
```

真实模式覆盖（`scripts/real-ai-e2e.mjs` 实测）：模拟面试官**真实出题**（带已问列表防重复）→
**真实辅助答案**（官方 5344 字 systemPrompt + 双段协议，TTFT ~1.1s）→ 笔试**截图视觉解题**
（OCR 认题 + 作答）→ promptStudio **真改写** → **LLM rubric 复盘报告**（五维/逐段/建议）。
**模型失败一律直接报错，不做静默降级**：面试出题/答题失败推送 `ai.error` 事件（房间与浮窗均显示错误卡片）、
笔试解题失败推送 `exam.error`（不扣时长、不记录）、tRPC 过程（押题/热词/岗位推荐/问答对/配色/STT/报告）失败返回错误信息；
`mock` provider 下的本地实现是离线模式的主路径，不受影响。改回 `ML_AI_PROVIDER=mock` 即恢复纯离线模式，
接口与页面均不变（`healthz.provider` 可查）。

### 运行时配置中心（不重启热切换）

`.env` 只在启动时读一次；实际接入参数可在 **设置 → AI 接入 / 语音识别** 里改，写进 `data/app.db` 的
`app_settings` 表（`key = 'ai' | 'asr'` 两个独立 section）并**立即生效**
（`provider.js` / `pipeline.js` / `asr.js` / `socket.js` 每次调用都读活的 `config.ai` / `config.asr`）：

| 能力 | 入口 | 说明 |
|---|---|---|
| 读当前配置 | `settings.ai.get` / `settings.asr.get` | 只回 `hasKey` + 掩码 `apiKeyMasked`，明文 key 不出服务端 |
| 保存热切换 | `settings.ai.set` / `settings.asr.set` | 字段级校验（AI：provider/baseUrl/model/visionModel/temperature；ASR：provider/baseUrl/model/silenceGateMs/maxUtteranceMs）；key 留空=保留原值，`clearApiKey` 显式清除 |
| 连通性自检 | `settings.ai.probe` / `settings.asr.probe` | AI：先 `GET /models`（best-effort）再真发一次 1-token `POST /chat/completions`；ASR：真发一段 0.4s 静音 WAV 走 `input_audio` 通道（验 key 权限、网关是否支持音频块、模型名）；都返回逐项 `checks` + 延迟，**不落库、不改生效配置**，可「先测后存」 |
| 回退基线 | `settings.ai.reset` / `settings.asr.reset` | 删掉 DB 覆盖，回到 `.env` / 出厂默认 |

优先级：设置页覆盖 > `.env` > 出厂默认；`/healthz` 用 `providerSource` / `asrSource`（`settings` / `env`）标明来源。
自检专项：`npm run test:ai`（`scripts/ai-config-e2e.mjs` 15/15）+ `npm run test:asr`
（`scripts/asr-config-e2e.mjs` 15/15：假音频网关、input_audio 真转写、热切换、越界校验、回退替身）。
运行口径：两套自检需先以 `ML_ALLOW_LOCAL_GATEWAY=1 node server/index.js` 启动服务（放行指向 127.0.0.1 假网关，默认关闭，不影响 SSRF 安全默认值）。

## 独立环境的含义

- **零全局污染**：依赖只装在 `面试橙/node_modules`；DB 是 `data/app.db` 单文件
- **零原生编译**：SQLite 用 Node 内置 `node:sqlite`，不需要 MSVC / node-gyp
- **零外部服务**：不请求 api.mianlingai.com，不外传任何数据；截图只落 `data/screenshots`
- **端口隔离**：8756（服务）、5191（dev 前端），与宿主其他服务不冲突
- **可搬迁**：整目录复制即可，路径全部相对项目根

## 已知边界（与文档对齐）

1. **OCR 已真**：笔试解题用 `qwen3.5-omni-flash` 读截图认题；截图无效且无题面文本、或模型失败时直接报 `exam.error`（不降级、不扣费）。
   **TTS 仍为本地替身**（1 秒正弦 WAV——网关无 TTS 模型）。
   **STT 已真实**：`.env` 配 `ML_ASR_API_KEY` 后，`stt.data` 音频帧走能量 VAD 切句 +
   `qwen3.5-omni-flash` 整句转写（实测中/英文全对，~0.7s/句；`healthz.asr` 可查状态）；
   `tools.stt.stt` 同样真转写（audioBase64 / audioUrl）；未配置 key 时两处都回退替身。
2. 模拟面试房间「🎤 语音作答」= 麦克风→转写→自动作答（说完停顿 ~2s 提交）；
   真实面试页可开「🎙 面试官声音（共享音频）」自动识别提问并流答案到浮窗，「🎤 我的回答」记录本人发言；
   浏览器共享音频需在弹窗中勾选「标签页/系统声音」；
3. 浏览器下浮窗是普通窗口、无任何隐蔽能力；桌面一律用 Rust 原生壳（`启动.bat`）；
4. **报告评分**：`openai` 模式为 LLM rubric（五维/逐段/建议全模型生成；生成失败直接报错，会话保持可重试）；`mock` 模式为本地 rubric。**TTS 仍为本地替身**（1 秒 WAV——网关无 TTS 模型）。

5. **Rust 原生壳的边界**：PE 伪装已重写版本信息**并替换图标资源**；
   overlay 启动即显示（原版是先建后隐）；hotpatch 实际切换（本地只做版本握手与 reload）、net:53 中继、46 项开关的**服务端下发**未接（本地为静态表）。
6. **`.tools` 重建**（曾被 `restore -Full` 清除，2026-11-23 已按 `native/toolchain.ps1` 重建并构建出 exe）：
   再被清除时跑 `native/toolchain.ps1` + `run.ps1 -Build` 即可恢复；构建路径自动解析（含中文路径时经
   `<盘符>:\ml-src` junction），不再依赖手工创建的 `D:\ml-build`。原生壳服务地址跟随 `ML_PORT`
   （优先级 `-Port` > 环境变量 > `.env` > 默认 8756，与启动器同口径）。
7. **热切换对「已建立的语音连接」不回溯**：`settings.asr.*` 保存后，`config.asr` 立即生效，
   但静音门限 / 单句上限在 `stt.start` 时快照进连接状态，正在进行的会话要重新 `stt.start`（或重连）才用新值；
   文本/视觉模型（`settings.ai.*`）则是每次调用都读活对象，无此限制。

细节见 `ARCHITECTURE.md`，运行与排错见 `RUN.md`。
