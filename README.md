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
│   ├── trpc/           tRPC v11 兼容层（92 个过程；单请求 + 批量 JSONL 惰性流双协议）
│   ├── ai/             官方提示词加载、systemPrompt 组装、mock/OpenAI 双 provider
│   ├── socket.js       root（面试）/desktop（笔试）双 namespace，逐字流式
│   ├── legacy-shim.js  原版前端挂载桩（54 cmd_* + 事件/store/OS 插件 + 网络重定向）
│   ├── db.js + seed.js 对齐 prisma AiSession 模型 + 演示数据
│   └── index.js        服务入口（tRPC / 上传 / /legacy / 静态前端 / Socket）
├── web/                自研 UI（React 18 + Vite，hash 分身四窗口）
├── public/             构建产物（npm run build 生成）
├── data/               app.db（SQLite）+ prompts（13 语言官方 presets）+ screenshots + uploads
├── scripts/            smoke.mjs（端到端冒烟）、socket-events.mjs（44 事件矩阵+真实转写）、asr-separation.mjs（双路说话人分离）、real-ai-e2e.mjs（真模型全链路）、legacy-shot.mjs、cdp-*.mjs
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
#     http://127.0.0.1:8756/legacy/   → 原版前端挂载（自动登录演示账号）

# 或直接双击 启动.bat（= 自动起服务 + Rust 原生壳：原生浮窗/热键/防截屏/伪装）
#     命令行等价：powershell -ExecutionPolicy Bypass -File 启动.ps1
#     重新编译壳：.\启动.ps1 -Build    WDA 自检：.\启动.ps1 -SelfTest 1
```

- 演示账号：`13800000000` / `demo1234`（自研 UI 启动时走 `user.getTempToken → loginByTempToken` 自动登录；`/legacy` 由桩同步预取）
- 端口、数据目录、AI provider 都可在 `.env` 覆盖（见 `.env.example`）
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
| 面试答题 systemPrompt 七节组装（简历注入 + 知识库 + 风格） | 20 | `ai/prompts.js` |
| 知识库注入（`【知识库：…】` / full-retrieval 双档） | 20 | `ai/prompts.js#buildKnowledge` |
| promptStudio 三过程 + 限流（run 6/min、assist 3/min） | 20/22 | `trpc/misc.js` |
| exam 24 预设策略（coding/choice/fill/ai_coding/psych…） | 22 | `ai/prompts.js` + `ai/mockBrain.js` |
| 客户端配置（localStorage + store.json 等价物 + 导入导出） | 06 | `SettingsPage` |
| **隐蔽与防检测**：WDA 防截屏 / panic 全窗隐藏 / 窗口+进程伪装 / 任务栏隐藏 | 05/15/24 | `native/src/win.rs` + 设置页 StealthPanel（实机验证） |
| 题库 / 押题 / 资料 / 官方资料库 / 求职进度 / 评分反馈 | 07/16/17 | `trpc/bank.js`、`resource.js` |
| Socket 全事件矩阵（44/44，含 ai.webSearch/prewarm/interrupt/mergePrev/onMsg/turnKind、stt.data/pending/changed/turnEnd/speaker、audio.requestPermission、exam.session/error、perf.ping） | 08/23 | `server/socket.js` + `scripts/socket-events.mjs`（44/44 PASS） |
| 转写落库（InterviewTranscript） | 09 | `trpc/session.js#insertTranscript`（实测 transcripts 表有行） |
| **真实语音识别（STT）**：能量 VAD 切句 → 整句转写 → 官方事件序列 | 23 | `server/ai/asr.js`（qwen3.8-omni-flash，实测中/英全对、~1.2s/句）+ `socket.js` VAD 管线 + `web/src/lib/voice.js` 采集（麦克风/共享音频） |
| 复盘报告 schema（status + fiveDimensions×5 + strengths/shortcomings×3 + suggestions×5 + relatedKnowledge×13 + conversationAnalysis） | 23 §9.2 | `ai/mockBrain.js#buildReport`（新建会话实测逐段/五维/知识点全对） |
| 报告导出 Markdown（DH 等价） | 23 §9.2 | `MainApp.jsx#exportReportMarkdown` |
| 公告 5min 轮询 / 使用须知 5s 倒计时 / 收银台 `/pay/mock` / refreshToken 1h 轮询 | 06 §5 | `MainApp.jsx`、`server/index.js`、`api/client.js`（接口+页面均已验证） |
| 浮窗 zones（350ms + JSON diff）、Alt+方向键移动、auto-palette（capture→suggestPalette→undo） | 03 §4/§5 | `OverlayWindow.jsx`（CDP 实测 zones=[body]，autoPalette 存在） |
| 押题流式订阅（prediction.item×N → end） | 17 | `socket.js` + 题库页（实测 12 条流式 PASS） |
| **押题生成 `questionPrediction.generate`**（简历+JD+题库检索 → 题目与解析） | 19 | `ai/enrich.js#generatePredictionItems` + `trpc/bank.js`（实测 6 题全模型，`source=model`） |
| **视觉配色 `overlay.suggestPalette`**（读壁纸出同色系底色+可读前景） | 21 §2.6 | `ai/enrich.js#generatePalette`（BMP→缩略 PNG 免依赖转码 + `qwen3.8-omni-flash`，实测 `source=vision`） |
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
- **构建链自包含**：rust-lld 链接；windres 需要的 `gcc -E` 由项目内
  `.tools/bin/gcc.exe`（直通 shim，兼把 ICON 路径改写到 ASCII junction）提供
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

- Rust 工具链、crates 缓存、构建产物全在 `.tools/`；链接用 **rust-lld 自包含**，不需要 gcc/MSVC
- 仅有一个 ASCII junction `D:\ml-build → <项目>\.tools\target`（`dlltool` 不支持中文路径，物理文件仍在项目内）
- 一键还原：`powershell -File .tools\restore.ps1`（`-Full` 连工具链一起删）

隐蔽能力全部在 `native/`（Rust）实现并实机验证（见上表）：WDA 防截屏（浮窗启动即开）、
`Ctrl+Alt+Esc` panic 全窗隐藏、窗口伪装 + **进程级 PE 伪装**（改名/版本信息/图标）、
任务栏隐藏、WASAPI 系统音频采集、焦点钩子、崩溃恢复握手、46 项特性开关。

设置页「隐蔽与防检测」面板与 `/legacy` 桩的 `cmd_set_capture_excluded` /
`cmd_capture_protection_support` / `cmd_panic_hotkey_status` / `cmd_apply_disguise_title`
在原生壳下经 `win.rs` 的 cmd_* 映射桥接到上述真实现（浏览器下为安全默认值）。

> Electron 路线已于 2026-11-22 移除（其能力为 Rust 壳子集）：`desktop/`、`scripts/desktop.mjs`
> 已删，`electron` 依赖已卸载。桌面启动一律走 `启动.bat`（Rust 原生壳）。

## AI provider

默认 `mock`：不联网、确定性，按官方输出协议产出「**核心要点** + **参考回答**」与「**答案：** + `[[FOLLOWUP: …]]`」，
用于本地开发与冒烟。本仓库 `.env` 已配置**真实模型**（千问 MaaS，OpenAI 兼容）：

```ini
ML_AI_PROVIDER=openai
ML_AI_BASE_URL=https://maas.qianwenaiapi.com/compatible-mode/v1   # 任意 OpenAI 兼容网关
ML_AI_API_KEY=sk-...
ML_AI_MODEL=qwen3.8-flash             # 出题/面试答案/笔试文本解题/提示词改写/LLM 报告评分
ML_AI_VISION_MODEL=qwen3.8-omni-flash  # 笔试截图识别题面（视觉）
```

真实模式覆盖（`scripts/real-ai-e2e.mjs` 9/9 实测）：模拟面试官**真实出题**（带已问列表防重复）→
**真实辅助答案**（官方 5344 字 systemPrompt + 双段协议，TTFT ~1.1s）→ 笔试**截图视觉解题**
（OCR 认题 + 作答；截图 <16px 或视觉失败自动降级文本/mock，上游故障不崩服务）→
promptStudio **真改写** → **LLM rubric 复盘报告**（五维/逐段/建议，解析失败回退本地规则）。
改回 `ML_AI_PROVIDER=mock` 即恢复纯离线模式，接口与页面均不变（`healthz.provider` 可查）。

## 独立环境的含义

- **零全局污染**：依赖只装在 `面试橙/node_modules`；DB 是 `data/app.db` 单文件
- **零原生编译**：SQLite 用 Node 内置 `node:sqlite`，不需要 MSVC / node-gyp
- **零外部服务**：不请求 api.mianlingai.com，不外传任何数据；截图只落 `data/screenshots`
- **端口隔离**：8756（服务）、5191（dev 前端），与宿主其他服务不冲突
- **可搬迁**：整目录复制即可，路径全部相对项目根

## 已知边界（与文档对齐）

1. **OCR 已真**：笔试解题用 `qwen3.8-omni-flash` 读截图认题（<16px 或视觉失败自动降级文本/mock）。
   **TTS 仍为本地替身**（1 秒正弦 WAV——网关无 TTS 模型）。
   **STT 已真实**：`.env` 配 `ML_ASR_API_KEY` 后，`stt.data` 音频帧走能量 VAD 切句 +
   `qwen3.8-omni-flash` 整句转写（实测中/英文全对，~1.2s/句；`healthz.asr` 可查状态）；
   `tools.stt.stt` 同样真转写（audioBase64 / audioUrl）；未配置 key 时两处都回退替身。
2. 模拟面试房间「🎤 语音作答」= 麦克风→转写→自动作答（说完停顿 ~2s 提交）；
   真实面试页可开「🎙 面试官声音（共享音频）」自动识别提问并流答案到浮窗，「🎤 我的回答」记录本人发言；
   浏览器共享音频需在弹窗中勾选「标签页/系统声音」；
3. 浏览器下浮窗是普通窗口、无任何隐蔽能力；桌面一律用 Rust 原生壳（`启动.bat`）；
4. **报告评分**：`openai` 模式为 LLM rubric（五维/逐段/建议全模型生成，JSON 失败自动回退本地规则）；
   `mock` 模式为本地 rubric。**TTS 仍为本地替身**（1 秒 WAV——网关无 TTS 模型）。

5. **Rust 原生壳的边界**：PE 伪装已重写版本信息**并替换图标资源**；
   overlay 启动即显示（原版是先建后隐）；hotpatch 实际切换（本地只做版本握手与 reload）、net:53 中继、46 项开关的**服务端下发**未接（本地为静态表）。
6. **`.tools` 体积约 2.3 GB**（Rust 工具链 + crates + 构建产物）；不想要时 `restore.ps1 -Full` 一次性清除。

细节见 `ARCHITECTURE.md`，运行与排错见 `RUN.md`。
