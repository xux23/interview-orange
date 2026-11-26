# 运行手册（RUN）

## 0. 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **≥ 22.5**（推荐 24/26） | 需要内置 `node:sqlite` |
| WebView2 | Windows 10/11 自带 | Rust 原生壳依赖 |
| 网络 | 首次安装依赖需联网；运行期完全离线（配真实模型则调用所配网关） | — |

> 本仓库已自带 `node_modules`；最省事的方式是**双击 `启动.bat`**。
> Rust 工具链（`.tools/`）当前已重建就绪；若被清除，先按 §3「重建工具链」跑一条命令即可恢复，
> 服务与浏览器模式（`.\启动.ps1 -Browser`）不依赖工具链，任何时候可用。

## 1. 首次启动

```powershell
cd <项目根>               # 整目录放哪都行，路径全相对项目根
npm run build            # 构建前端到 ./public（改过前端才需要重跑）
node server/index.js     # 起本地服务，首次自动建表 + seed 演示数据
```

浏览器打开 **http://127.0.0.1:8756** —— 账号模块已移除：无需登录，直接进入本地档案工作台。

## 2. 两套前端

| 地址 | 前端 | 说明 |
|---|---|---|
| http://127.0.0.1:8756 | 自研 UI（#main/#overlay/#mock/#mock-exam） | 代码可读可改 |
| http://127.0.0.1:8756/legacy/ | **原版前端原样挂载** | 桩兼容 token（账号已移除）；公告/使用须知/工作台读本地数据 |

原版模式原理与边界见 README「原版前端挂载」一节；截图自检：`node scripts/legacy-shot.mjs <cdp端口> out.png`。

## 3. Rust 原生壳（推荐，原版技术栈）

```powershell
powershell -ExecutionPolicy Bypass -File native\run.ps1 -Build          # 首次构建 + 启动
powershell -ExecutionPolicy Bypass -File native\run.ps1 -Build -Release -BuildOnly  # release 构建（strip+lto，exe ~6MB）不启动
powershell -ExecutionPolicy Bypass -File native\run.ps1 -Release        # 运行 release 版
powershell -ExecutionPolicy Bypass -File native\run.ps1 -Build -BuildOnly  # 只构建不启动（脚本/自检用）
powershell -ExecutionPolicy Bypass -File native\run.ps1                 # 之后直接启动
powershell -ExecutionPolicy Bypass -File native\run.ps1 -SelfTest 1     # WDA 防截屏自检
powershell -ExecutionPolicy Bypass -File native\run.ps1 -SelfTest 2     # WASAPI 采集自检
```

- 环境：Rust 1.100（gnu）+ rust-lld 自包含链接，全部在 `.tools/`，不需要 MSVC/gcc/MSYS2
  （`.tools/` 被清除后先跑下述「重建工具链」）
- 产物：`<构建目录>\debug\interview-orange.exe`。构建路径由 `run.ps1` 动态解析：
  项目路径纯 ASCII → 直接用项目内真实路径；含中文 → 自动在任一可用盘符根创建/复用
  ASCII junction `<盘符>:\ml-src → <项目根>`，产物目录（CARGO_TARGET_DIR）与 `TMP/TEMP`
  都经它变成 ASCII（物理文件仍在项目内，卸载删 junction 即可；dlltool/lld/windres 不认中文路径）。
  windres/gcc 的路径改写 shim 装在 `.tools\bin\`（`toolchain.ps1` 自动编译，见「重建工具链」）
- 端口：原生壳跟随 `ML_PORT`（默认 8756），与 `.env` / `启动.ps1 -Port` 同口径
- 热键：`Ctrl+Alt+Esc` panic · `Ctrl+Alt+H` 浮窗显隐 · `Ctrl+Alt+Shift+X` 关闭浮窗 · `Ctrl+Alt+Shift+Q` 退出
- 自检日志会直接打印 `PASS/FAIL`，见上面「Rust 原生壳」表

### 重建工具链（.tools 被清除 / 搬到新机器后）

一条命令（国内镜像直连，约 300 MB，全部装入项目内 `.tools`）：

```powershell
powershell -ExecutionPolicy Bypass -File native\toolchain.ps1   # rustup(stable-gnu) + mingw64(gcc/windres/dlltool)
powershell -ExecutionPolicy Bypass -File native\run.ps1 -Build -BuildOnly  # 然后构建
```

- Rust 工具链：`rsproxy.cn` 镜像（`RUSTUP_DIST_SERVER=https://rsproxy.cn`，注意 dist 根不在 /rustup 子路径）
- mingw64：niXman `16.2.0-rt_v14-rev1`（posix-seh-ucrt），GitHub release 经 `ghfast.top` 中转下载，
  备选 `ghproxy.net`；解压用 Bandizip 控制台 `bz.exe`（或系统 7-Zip）
- crates 依赖：`native/.cargo/config.toml` 已配 rsproxy sparse 镜像，`cargo build` 自动走
- 幂等：已存在的组件自动跳过；强制重装删对应子目录（`.tools\rustup` / `.tools\cargo` / `.tools\binutils`）

### 还原

`restore.ps1` 原随 `.tools/` 分发，已随之删除。手工还原口径：

```powershell
# 清构建产物（物理文件在项目内）
Remove-Item -Recurse -Force .tools\target, .tmp-build
# 拆掉盘符根的 ASCII junction（如果存在，只删 junction 本身）
Get-PSDrive -PSProvider FileSystem | ForEach-Object { Join-Path $_.Root 'ml-src' } |
  Where-Object { (Get-Item $_ -Force).LinkType -eq 'Junction' } | Remove-Item -Force
# 连工具链一起删
Remove-Item -Recurse -Force .tools
```

系统级零改动：不写注册表、不改用户/系统 PATH、不装全局包（脚本末尾会打印残留检查）。

## 4. 便携启动（推荐：双击 `启动.bat`）

```powershell
.\启动.ps1              # 服务 + Rust 原生壳（默认）
.\启动.ps1 -Build       # 重新编译原生壳后启动
.\启动.ps1 -SelfTest 1  # WDA 防截屏自检（打印 PASS/FAIL）
.\启动.ps1 -Browser     # 仅浏览器模式（调试用，无隐蔽能力）
```

Rust 原生壳提供（唯一桌面路线，Electron 已移除）：
- 预建浮窗：无边框/置顶/不进任务栏/**OS 级透明**（卡片半透明，桌面可见），**WDA 防截屏启动即开**；头按钮 `—` 隐藏、`×` 关闭
- 全局热键（**真显隐窗口**）：`Ctrl+Alt+H` 浮窗显隐（无会话时进入预览态）· `Ctrl+Alt+Shift+X` 关浮窗 ·
  `Ctrl+Alt+Esc` panic（隐藏**全部**窗口并叠加防截屏，再按恢复） · `Ctrl+Alt+Shift+Q` 退出
- 隐蔽与防检测（主窗设置页面板）：WDA 开关、窗口伪装标题、**进程级 PE 伪装**、任务栏隐藏、panic 即时按钮
- WASAPI 系统音频采集 / 焦点钩子 / 崩溃恢复握手 / 46 项特性开关
- 系统截屏（笔试房间「截取屏幕」）

**排查开关**（环境变量，仅调试用）：

```powershell
$env:ML_NO_WDA = '1'   # 不启用防截屏 → 外部截图/录屏能看到浮窗（验收透明与排版）
$env:ML_IPCLOG = '1'   # 打印每条 IPC 命令（[ipc] cmd ← window）
$env:ML_DIAG   = '1'   # 启动 4s 后把 DOM 诊断经 /__diag 回传，打印到 [page] 日志
```

## 5. 典型流程

1. **模拟面试**：主窗「模拟面试」→ 选简历/岗位/难度/轮次/回答风格 → 开始 → 房间窗逐字出题，
   你作答后给出「核心要点 + 参考回答」→ 结束并生成报告（工作台「查看报告」）。
2. **真实面试浮窗**：主窗「真实面试辅助」→ 开启浮窗 → 浮窗底部输入框注入面试官问题（本地 STT 替身）
   → 浮窗逐字刷新答案卡片 → 结束后 `Ctrl+Alt+Shift+X` 关闭浮窗。
3. **笔试助手**：主窗「笔试助手」→ 打开笔试房间 → 截取屏幕或粘贴题面 → 解题（扣 2 分钟）
   → 浮窗显示「答案：」+ 追问标签。

## 6. 切换 AI provider / 启用真实语音识别

**首选：设置页（运行时，不用重启）**

主窗 → 设置 → **AI 接入**：填 provider（mock/openai）、Base URL、API Key、文本模型、视觉模型、temperature，
点「连通性自检」先验证（真发一次 1-token 补全，返回逐项 checks 与延迟），再「保存并热切换」。

同一页下方 **语音识别**：provider（mock/qianwen）、Base URL、API Key、转写模型、静音收句门限、单句最长；
自检真发一段 0.4s 静音 WAV 走 `input_audio` 通道（验 key 权限 + 网关是否支持音频块 + 模型名）。

两处都写进 `data/app.db.app_settings`（`key='ai'` / `key='asr'`），优先级 **设置页 > .env > 出厂默认**，
「回退 .env」一键清掉覆盖。`http://127.0.0.1:8756/healthz` 的
`provider` / `model` / `providerSource` / `asr` / `asrSource` 反映当前生效值。

**备选：编辑 `面试橙/.env`**（可从 `.env.example` 复制，改完要重启服务）：

```ini
# 文本生成（可选）
ML_AI_PROVIDER=openai
ML_AI_BASE_URL=https://maas.qianwenaiapi.com/compatible-mode/v1
ML_AI_API_KEY=sk-xxxx
ML_AI_MODEL=deepseek-v4.1-flash
ML_AI_VISION_MODEL=qwen3.5-omni-flash

# 语音识别（可选，不配则保持本地替身；也可在设置页改并热切换）
ML_ASR_BASE_URL=https://maas.qianwenaiapi.com/compatible-mode/v1
ML_ASR_API_KEY=sk-xxxx
ML_ASR_MODEL=qwen3.5-omni-flash
```

接口与页面不变。`http://127.0.0.1:8756/healthz` 的 `asr` 字段可查当前 STT 状态。

启用真实 STT 后：

| 入口 | 用法 |
|---|---|
| 模拟面试房间 | 「🎤 语音作答」：对着麦克风回答，说完停顿 ~2s 自动转写提交并触发追问 |
| 真实面试辅助页 | 「🎙 面试官声音（共享音频）」：弹窗勾选标签页/系统声音，识别到提问自动流答案到浮窗 |
| 真实面试辅助页 | 「🎤 我的回答（麦克风）」：本人发言转写并记录到会话 |

## 7. 端到端自检

```powershell
node scripts/smoke.mjs
```
覆盖：健康检查 → 鉴权 → 资源/契约 → 会话创建 → 面试 socket 流式 → 报告 → 笔试 `/desktop` 流式 →
扣费 → 记录列表。预期 **17/17 PASS**。

语音与真实模型专项：

```powershell
node scripts/socket-events.mjs   # 43 项事件矩阵，含真实转写实测（打印 [asr] 实测转写）
node scripts/asr-separation.mjs  # 双路并发分离（双中文样本）：面试官(Guest-1)/本人(self) 互不混音
node scripts/real-ai-e2e.mjs     # 真实模型全链路 9 项：出题/答案/笔试视觉解题/改写/LLM 报告
node scripts/p0p1-verify.mjs     # P0/P1 专项 6 项：押题生成/视觉配色/真转写/热词/岗位推荐/资料生成
npm run test:ai                  # AI 配置中心 15 项：假网关+热切换+双链路+不可达+回退（会自动 reset；需 ML_ALLOW_LOCAL_GATEWAY=1 启动服务）
npm run test:asr                 # ASR 配置中心 15 项：假音频网关+input_audio 真转写+热切换+回退替身（同上，需 ML_ALLOW_LOCAL_GATEWAY=1）
```

## 8. 常见问题

| 现象 | 处理 |
|---|---|
| 端口被占用 | 设 `ML_PORT=8757`（.env 或环境变量）后重启 |
| 页面 503「前端尚未构建」 | 先 `npm run build` |
| 浮窗打不开 | 用 `启动.bat` 走原生壳；按 `Ctrl+Alt+H` 直接显隐浮窗（无会话时显示空态卡片）；或在主窗点「真实面试浮窗 / 笔试助手」 |
| **找不到浮窗 / 截图拍不到它** | 按 `Ctrl+Alt+H` 显隐（无会话时显示预览卡片）。浮窗默认**不做**防截屏，能正常截图 |
| **浮窗变成黑块** | 是因为开了「浮窗防截屏」（设置页）——透明窗口 + WDA 在部分显卡/DWM 下互斥。关掉该项即恢复半透明 |
| 浮窗看起来是实心不透明 | 确认壳是 Tauri 版（`healthz` 版本 `interview-orange/1.1.0`）；页面 `#overlay` 需带 `.overlay` 类 |
| 浮窗关不掉 | 头部 `×` 关闭、`—` 隐藏，或热键 `Ctrl+Alt+Shift+X`；`Ctrl+Alt+Esc` 紧急隐藏全部窗口 |
| 截屏黑屏 | 用「粘贴截图」兜底；原生壳下用「截取屏幕」按钮（浮窗区域因 WDA 不会入屏，属预期） |
| /legacy 白屏/报 Stream closed | 确认服务是新代码（JSONL 协议需重启生效）；刷新页面重试 |
| 语音无转写 | 查 `healthz` 的 `asr` 字段是否为模型名（`mock` = 未读到位 key，需重启）；控制台看 `[stt]` 日志 |
| 共享音频采不到面试官声音 | getDisplayMedia 弹窗必须勾选「共享标签页音频/系统声音」；只共享画面无声音 |
| 转写延迟偏高 | 正常为句末停顿 2s + 转写 ~1.2s；可调小 `ML_ASR_SILENCE_GATE_MS`（200~6000） |
| 面试 socket 连不上 | 确认 `sessionId` 已传（缺省会报 prisma 形态错误，这是对齐实测的行为） |
| 笔试无输出 | 笔试必须走 `/desktop` namespace（已内置） |
| 重新初始化数据 | 停止服务 → 删除 `data/app.db*` → 重启（自动重新 seed） |

## 9. 目录与可搬迁性

所有路径相对项目根；`data/` 是整个应用的持久层。整目录复制到别的机器，装好 Node ≥22.5 即可运行。
