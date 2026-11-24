/**
 * 模型接入层：mock（离线确定性大脑）| openai（任意 OpenAI 兼容 /chat/completions 网关，支持 SSE 流式）。
 * 上层只认 { text, ttftMs, totalMs }，换 provider 不影响业务契约。
 *
 * 超时与打断（「模型不行就报错」，不无限挂起）：
 *  - 非流式：总超时 ML_AI_TOTAL_TIMEOUT_MS（默认 120s）
 *  - 流式：首字超时 ML_AI_FIRST_TOKEN_MS（默认 30s）+ 流间空转超时 ML_AI_IDLE_TIMEOUT_MS（默认 60s）
 *  - 外部 AbortSignal：ai.interrupt / exam.abort 真打断（错误 message 为「已打断」，e.aborted=true）
 */
import { config } from '../config.js';

const TOTAL_TIMEOUT_MS = Number(process.env.ML_AI_TOTAL_TIMEOUT_MS || 120_000);
const FIRST_TOKEN_TIMEOUT_MS = Number(process.env.ML_AI_FIRST_TOKEN_MS || 30_000);
const IDLE_TIMEOUT_MS = Number(process.env.ML_AI_IDLE_TIMEOUT_MS || 60_000);

async function* sseLines(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop() || '';
    for (const line of parts) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        /* 忽略心跳等非 JSON 行 */
      }
    }
  }
}

/** 事件驱动的流式队列：push/end/fail + async iterator（替代轮询搬运，每 chunk 零额外延迟） */
export function createStreamQueue() {
  const chunks = [];
  let done = false;
  let error = null;
  let wake = null;
  const notify = () => { const w = wake; wake = null; w?.(); };
  return {
    push(item) { if (done) return; chunks.push(item); notify(); },
    end() { done = true; notify(); },
    fail(e) { error = e; done = true; notify(); },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (chunks.length) { yield chunks.shift(); continue; }
        if (error) throw error;
        if (done) return;
        await new Promise((r) => { wake = r; });
      }
    },
  };
}

export async function openaiComplete({ system, messages = [], onDelta, maxTokens = 900, model, userContent, signal }) {
  if (!config.ai.apiKey) throw new Error('ML_AI_API_KEY 未配置（provider=openai）');
  const started = Date.now();
  let ttft = null;
  const finalMessages = [
    { role: 'system', content: system },
    ...(userContent !== undefined
      ? [{ role: 'user', content: userContent }]
      : messages.map((m) => ({ role: m.role === 'ASSISTANT' ? 'assistant' : m.role === 'USER' ? 'user' : 'system', content: m.content }))),
  ];

  // 超时/打断统一走一个 AbortController；abortReason 区分超时与打断给可读报错
  const ctrl = new AbortController();
  let abortReason = null; // 'interrupted' | 'timeout'
  let abortMessage = '';
  const abortWith = (reason, message) => {
    if (ctrl.signal.aborted) return;
    abortReason = reason;
    abortMessage = message;
    ctrl.abort();
  };
  const onExternalAbort = () => abortWith('interrupted', '已打断');
  if (signal) {
    if (signal.aborted) { const e = new Error('已打断'); e.aborted = true; throw e; }
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  let timer = null;
  const armTimer = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => abortWith('timeout', `模型响应超时（${ms / 1000}s 内无输出，网关挂起或限流）`), ms);
  };

  try {
    armTimer(onDelta ? FIRST_TOKEN_TIMEOUT_MS : TOTAL_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${config.ai.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.ai.apiKey}`,
        },
        body: JSON.stringify({
          model: model || config.ai.model,
          temperature: config.ai.temperature,
          max_tokens: maxTokens,
          stream: Boolean(onDelta),
          enable_thinking: false, // 千问系：关思考链换首字延迟（官方实测 2s 首字口径）
          messages: finalMessages,
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (abortReason) throw new Error(abortMessage);
      // 网络层失败（DNS/拒连/超时）给可读信息，不再裸抛 "fetch failed"
      throw new Error(`AI 网关连接失败（${config.ai.baseUrl}）：${e?.cause?.message || e?.message || e}`);
    }
    if (!res.ok) throw new Error(`上游 ${res.status}: ${(await res.text()).slice(0, 200)}`);

    if (!onDelta) {
      const json = await res.json();
      const text = json.choices?.[0]?.message?.content || '';
      return { text, ttftMs: Date.now() - started, totalMs: Date.now() - started, model: json.model || config.ai.model };
    }

    let text = '';
    for await (const delta of sseLines(res)) {
      if (ttft === null) ttft = Date.now() - started;
      armTimer(IDLE_TIMEOUT_MS); // 流间空转计时：收到一个 delta 就重置
      text += delta;
      onDelta(delta);
    }
    return { text, ttftMs: ttft ?? Date.now() - started, totalMs: Date.now() - started, model: config.ai.model };
  } catch (e) {
    if (abortReason === 'interrupted') { const err = new Error('已打断'); err.aborted = true; throw err; }
    if (abortReason === 'timeout') throw new Error(abortMessage);
    if (e?.name === 'AbortError') throw new Error(abortMessage || '已打断');
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

/** 把已经算好的文本按「逐字」节奏推给前端（模拟官方 2~4 字/包） */
export async function streamText(text, onDelta, { pace = 18, size = 3, signal } = {}) {
  for (let i = 0; i < text.length; i += size) {
    if (signal?.aborted) break;
    const chunk = text.slice(i, i + size);
    onDelta(chunk);
    await new Promise((r) => setTimeout(r, pace));
  }
  return text;
}

export const providerName = () => config.ai.provider;
