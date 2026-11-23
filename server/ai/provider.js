/**
 * 模型接入层：mock（离线确定性大脑）| openai（任意 OpenAI 兼容 /chat/completions 网关，支持 SSE 流式）。
 * 上层只认 { text, ttftMs, totalMs }，换 provider 不影响业务契约。
 */
import { config } from '../config.js';

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

export async function openaiComplete({ system, messages = [], onDelta, maxTokens = 900, model, userContent }) {
  if (!config.ai.apiKey) throw new Error('ML_AI_API_KEY 未配置（provider=openai）');
  const started = Date.now();
  let ttft = null;
  const finalMessages = [
    { role: 'system', content: system },
    ...(userContent !== undefined
      ? [{ role: 'user', content: userContent }]
      : messages.map((m) => ({ role: m.role === 'ASSISTANT' ? 'assistant' : m.role === 'USER' ? 'user' : 'system', content: m.content }))),
  ];
  const res = await fetch(`${config.ai.baseUrl.replace(/\/$/, '')}/chat/completions`, {
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
  });
  if (!res.ok) throw new Error(`上游 ${res.status}: ${(await res.text()).slice(0, 200)}`);

  if (!onDelta) {
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content || '';
    return { text, ttftMs: Date.now() - started, totalMs: Date.now() - started, model: json.model || config.ai.model };
  }

  let text = '';
  for await (const delta of sseLines(res)) {
    if (ttft === null) ttft = Date.now() - started;
    text += delta;
    onDelta(delta);
  }
  return { text, ttftMs: ttft ?? Date.now() - started, totalMs: Date.now() - started, model: config.ai.model };
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
