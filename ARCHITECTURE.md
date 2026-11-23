# 架构说明

## 1. 分层

```
┌──────────────────────────── 桌面壳（native/，Rust · tao + wry）──────────────────────────────┐
│ 主窗(#main)  ·  预建浮窗(#overlay，WDA 启动即开)  ·  房间窗  ·  全局热键  ·  WASAPI/焦点钩子    │
└───────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                            │ 全部页面都来自本地服务（http://127.0.0.1:8756）
┌───────────────────────────────────────────▼──────────────────────────────────────────────────┐
│ web/（React 18 + Vite，hash 分身四窗口）                                                      │
│   api/client.js  tRPC GET/POST + token 镜像       lib/bridge.js  BroadcastChannel 事件总线    │
│   lib/native.js  原生壳探测/浮窗控制              lib/markdown.jsx  轻量 Markdown            │
└───────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                            │ HTTP /trpc/*  +  WebSocket /socket.io
┌───────────────────────────────────────────▼──────────────────────────────────────────────────┐
│ server/（Node，零原生依赖）                                                                   │
│   index.js   服务入口（tRPC / 上传 / 静态 / Socket 挂载）                                      │
│   trpc/*     tRPC v11 兼容层：92 个过程，query=GET mutation=POST，错误码对齐实测                │
│   socket.js  root（面试）/desktop（笔试）双 namespace，逐字流式                                │
│   ai/        官方提示词加载 → systemPrompt 组装 → pipeline → provider(mock|openai)            │
│   ai/asr.js  真实 STT（可选）：VAD 收句 → qwen3.8-omni-flash 整句转写 → 官方 stt 事件序列      │
│   ai/enrich.js 模型增强：押题生成/视觉配色(BMP→PNG)/真转写/热词抽取/岗位推荐/资料问答           │
│   db.js      node:sqlite 表结构（对齐 prisma AiSession 模型）                                  │
└───────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                            │
                                    data/app.db（SQLite 单文件）
                                    data/prompts/*.json（13 语言官方 presets）
                                    data/screenshots/ · data/uploads/
```

## 2. 三/四窗口模型

同一份前端产物，靠 URL hash 判定窗口身份（对齐 02 号文档）：

| hash | 根组件 | 职责 |
|---|---|---|
| `#main` | `MainApp` | 工作台：会话记录、题库、资料、提示词工作室、设置 |
| `#overlay` | `OverlayWindow` | 透明/半透明置顶浮窗：门禁状态机 + 一题一卡/答案流 |
| `#mock` | `MockRoom` | 模拟面试房间：Socket 出题/AI 作答/结束报告 |
| `#mock-exam` | `ExamRoom` | 笔试房间：截屏或粘贴题面 → `/desktop` 解题 |

窗口之间不自带 IPC 协议时用 `BroadcastChannel('interview-orange-bus')` 模拟 Tauri 的
`emit/listen`；Rust 原生壳**预建 overlay 窗口**（无边框/置顶/skipTaskbar/WDA 默认开），
`#overlay` 由 `overlay.show` 激活，其余窗口由主窗 `window.open` 打开。

## 3. 浮窗门禁状态机（对齐 03 号文档 §3）

```
主窗 showOverlay() ──→ seq = localStorage 自增 ──→ 广播 overlay-shown{seq,mode,sessionId}
浮窗 createOverlayGate():
  · overlay-shown(seq)  → seq>latest 才激活，置 token=seq，读 mode
  · active 且 mode∈{exam,interview} → 广播 overlay-session-ready{seq}
  · overlay-hidden      → token=null，代数 +1，active=false
  · 订阅后 250ms 兜底拉 currentShowSeq()，能拿到更大 seq 也激活
  · 心跳 5s（overlay-heartbeat）
```
> `seq` 是唯一因果令牌；重复 seq 去重；preview 类模式不发 sessionReady（与官方一致）。

## 4. 提示词与推理管线

```
presets.<lang>.json（官方原文，13 语言）
   ├─ interview.official / interview.styles[4]  → buildInterviewSystemPrompt() 七节拼装
   │     人设 / 输出格式 / 语言与转写 / 我的资料(简历+职位+知识库) / 回答风格 / 回答内容 / 每轮六件事
   ├─ exam.official / exam.styles[4]            → buildExamSystemPrompt()（格式协议 + 题型策略）
   └─ examPresets[24]                            → 题型/模式分发（coding/choice/fill/ai_coding/psych/sql…）

pipeline.interviewRun / interviewStream / examSolveStream / examRun / reportFor
   └─ provider: mock（ai/mockBrain.js，确定性）
                openai（ai/provider.js，任意 OpenAI 兼容网关，SSE 流式，enable_thinking:false）
                   · 出题/答案/改写/报告评分 → config.ai.model（qwen3.8-flash）
                   · 笔试截图 OCR → config.ai.visionModel（qwen3.8-omni-flash，<16px 降级文本）
                   · 复盘报告 → LLM rubric 严格 JSON，失败回退 mockBrain.buildReport
```

`buildKnowledge()` 口径：总字数 ≤ 30000 → `mode=full` 全文注入；否则 `mode=retrieval` 截断，
格式 `【知识库：名称】\n正文`，与实测契约一致。

## 5. Socket 协议

### 面试（root namespace）
```
auth { token, locale, sessionId }  ← sessionId 必填（缺省返回 prisma 形态错误，对齐实测）
连接即推 audio.permission(false) → 120ms 后 audio.permission(true)
C→S mock.join / mock.start
  ← mock.questionStart → mock.question×N → mock.questionEnd   （面试官出题，逐字）
  ← ai.messageStart    → ai.message×N    → ai.messageEnd      （AI 辅助，逐字）
C→S mock.answer{answer} / mock.toggleAssist{assistMode} / mock.end
STT：C→S stt.start{silenceGateMs} / stt.data{data: PCM16k base64 帧, speakerId} / stt.end / stt.inject{text}
    配置 ML_ASR_API_KEY 后：stt.data 帧按 speakerId 走**各自独立的能量 VAD**（阈值 -34dBFS，
    静音 gate 默认 2s）切句 → ai/asr.js 整句转写 → S→C stt.pending → stt.speaker →
    stt.segment(completed) → stt.changed → stt.turnEnd；两路同时说话互不混音、不串说话人
    （`scripts/asr-separation.mjs` 并发双流实测）。
    speakerId='self' 记为 USER 回答（MOCK 会话自动触发追问），其余记为 INTERVIEWER 并触发 assist。
    未配置 key 时为本地替身（stt.start 定时出题 / 8KB 切句 / stt.inject 注文本）。
```
同一个会话的多个 socket（房间窗 + 浮窗）加入 `room=sessionId`，事件按房间广播，保证两窗同步。

### 笔试（/desktop namespace）
```
C→S exam.session.start{title,goalId,mode,customization,platform} → ack{success,data{sessionId,isPro,remainingMinutes}}
C→S exam.solve{screenshot,screenshots,sessionId,mode,customization,...} → ack{success,data{reqId}}
  ← exam.start{reqId} → exam.progress{stage:'analyzing'} → exam.reasoning×N → exam.delta×N → exam.end
  ← exam.quota{isPro,remainingMinutes,pendingCardHint}     （每次解题扣 2 分钟）
C→S exam.followUp{reqId,intent}: nr / Tn(level) / br / $r / message
C→S exam.session.complete{sessionId}
```

## 6. 数据层

`node:sqlite`（Node ≥22.5 内置）单文件 `data/app.db`。核心表：

- `sessions`：AiSession 全字段（metadata/context/cost/token_usage/report/round/outcome/rating…）
- `messages`：role ∈ SYSTEM|INTERVIEWER|USER|ASSISTANT|…，按 createdAt 升序
- `exam_sessions`：笔试记录（questions JSON 数组存每次解题）
- `resumes / goals / materials / material_entries / official_libraries / official_library_entries`
- `questions / user_question_state / predictions`
- `voiceprints / uploads / orders / announcements / notices / feedbacks / feedback_replies / agent_sessions`

## 7. 鉴权

HMAC 令牌（形态对齐 JWT `{userId,type,iat,exp}`），`authorization: Bearer <token>`。
`user.getTempToken` → `user.loginByTempToken` 两步自动登录；前端 token 存 `localStorage['token']`
（非 china 区域用 `token_<region>`，与官方一致）。

## 8. 原生能力（native/，Tauri 2 框架层 · tao + wry + tauri 命令层，唯一桌面壳）

`window.orangeNative` shim 由 `main.rs` 注入，经 `__TAURI_INTERNALS__.invoke('ipc')` 单命令进入
`win.rs` 的 43 命令分发（远程域 IPC 经 `capabilities/remote.urls` + `permissions/shell-ipc` 放行）：

| 能力 | 实现 |
|---|---|
| 浮窗 | 预建 overlay：无边框/置顶/skipTaskbar，**WDA（EXCLUDEFROMCAPTURE）启动即开** |
| 关闭/显隐浮窗 | 头 `×`/`—` → `overlay.close`/`overlay.toggle`；热键 `Ctrl+Alt+Shift+X` / `Ctrl+Alt+H` |
| panic 紧急隐藏 | `Ctrl+Alt+Esc`：隐藏全部窗口并叠加 WDA，再按恢复；`Ctrl+Alt+Shift+Q` 退出 |
| 窗口/进程伪装 | `win.disguise`（原生标题）+ `win.disguise_process`（PE 复制自身重写 VS_VERSIONINFO + 图标） |
| 系统音频 | WASAPI loopback 采集 + RMS 电平（`audio.start/level/devices`） |
| 焦点钩子 | `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)`（`hook.focus`） |
| 截屏 | GDI BitBlt → base64（`capture.screen`） |
| 崩溃恢复 | `.recovery` 标记 + `crash.recovery/boot_ok` 握手 |
| 特性开关 | 46 项静态表 `features.list/set` |
| legacy cmd_* | `cmd_set_capture_excluded` 等经 `win.rs` 映射到真实现（/legacy 原版前端可调） |

> Electron 路线已移除（其能力为上表子集）；浏览器模式下 shim 缺席，前端自动降级为安全默认值。

> Windows 下 OS 级 `transparent:true` 合成不稳定（内容可能不落屏），故改用
> `frame:false + 不透明底色 + 窗口 setOpacity` 的稳妥方案：视觉上仍是半透明浮窗，且必然可见可关。
