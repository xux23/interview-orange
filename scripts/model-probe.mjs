/**
 * 模型选型探针：对 OpenAI 兼容网关的候选模型实测 TTFT / 吞吐 / 输出质量样张。
 * 用法：node scripts/model-probe.mjs  （key 从环境变量 ML_AI_API_KEY 读）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BASE = process.env.ML_AI_BASE_URL || 'https://maas.qianwenaiapi.com/compatible-mode/v1';
const KEY = process.env.ML_AI_API_KEY;
if (!KEY) { console.error('缺少 ML_AI_API_KEY'); process.exit(1); }

const TEXT_MODELS = [
  'qwen3.8-flash', 'qwen3.7-flash', 'qwen3.7-plus', 'qwen3.8-max',
  'deepseek-v4.1-flash', 'glm-5.3', 'kimi-k3', 'MiniMax-M3.1-Flash',
  'qwen3.6-flash', 'qwen4-max',
];
const VISION_MODELS = ['qwen3.8-omni-flash', 'qwen3.5-omni-flash', 'qwen3.5-omni-plus', 'qwen3-vl-plus', 'qwen3.5-ocr'];

// 追加探针（第二轮）：MiniMax 正确 id / deepseek 截断复核 / 视觉解题能力
const EXTRA_TEXT = ['MiniMax/MiniMax-M3.1-Flash'];
const SOLVE_IMG = 'probe-question.png';
const SOLVE_PROMPT = '解答图中题目：给出思路和 Python 代码，并回答追问。';

async function streamChat({ model, messages, maxTokens, timeoutMs = 90_000 }) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      signal: ctrl.signal,
      body: JSON.stringify({
        model, messages, stream: true, max_tokens: maxTokens,
        temperature: 0, enable_thinking: false,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', text = '', ttft = null, firstAt = null, usage = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (j.usage) usage = j.usage;
        const d = j.choices?.[0]?.delta?.content;
        if (d) {
          if (ttft === null) ttft = Date.now() - started;
          text += d;
        }
      }
    }
    return { ttftMs: ttft, totalMs: Date.now() - started, text, usage, firstAt };
  } finally { clearTimeout(timer); }
}

const results = [];
async function probeText(model) {
  // 1) 纯延迟探针（最小输出）
  try {
    const p = await streamChat({
      model,
      messages: [{ role: 'user', content: '直接回答一个字：好' }],
      maxTokens: 8,
    });
    // 2) 质量/吞吐样张（真实面试题，流式 400 token）
    const q = await streamChat({
      model,
      messages: [
        { role: 'system', content: '你是资深后端面试辅导。分点回答，简洁专业。' },
        { role: 'user', content: 'MySQL 为什么用 B+ 树而不是 B 树做索引？' },
      ],
      maxTokens: 400,
    });
    const cps = q.totalMs > q.ttftMs ? (q.text.length / ((q.totalMs - q.ttftMs) / 1000)).toFixed(0) : '?';
    results.push({
      kind: 'text', model,
      ping: { ttftMs: p.ttftMs, totalMs: p.totalMs },
      answer: { ttftMs: q.ttftMs, totalMs: q.totalMs, chars: q.text.length, charsPerSec: cps },
      sample: q.text.replace(/\s+/g, ' ').slice(0, 120),
      usage: q.usage,
    });
    console.log(`[text] ${model}: ping ttft ${p.ttftMs}ms | answer ttft ${q.ttftMs}ms total ${q.totalMs}ms ${q.text.length}字 ${cps}字/s`);
  } catch (e) {
    results.push({ kind: 'text', model, error: e.message });
    console.log(`[text] ${model}: 失败 ${e.message}`);
  }
}

async function probeVision(model) {
  try {
    const img = fs.readFileSync(path.join(root, 'shots', 'exam.png'));
    const r = await streamChat({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '逐字读出图中题目的完整文字，不要解释。' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${img.toString('base64')}` } },
        ],
      }],
      maxTokens: 300,
    });
    results.push({
      kind: 'vision', model,
      ttftMs: r.ttftMs, totalMs: r.totalMs, chars: r.text.length,
      sample: r.text.replace(/\s+/g, ' ').slice(0, 150),
    });
    console.log(`[vision] ${model}: ttft ${r.ttftMs}ms total ${r.totalMs}ms → ${r.text.replace(/\s+/g, ' ').slice(0, 80)}`);
  } catch (e) {
    results.push({ kind: 'vision', model, error: e.message });
    console.log(`[vision] ${model}: 失败 ${e.message}`);
  }
}

async function probeAsr(model) {
  try {
    const wav = fs.readFileSync(path.join(root, 'scripts', 'fixtures', 'asr-zh.wav')).toString('base64');
    const started = Date.now();
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model, temperature: 0, enable_thinking: false, max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '逐字转写音频中的人声语音，只输出转写文本本身。' },
            { type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${wav}` } },
          ],
        }],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const text = String(j.choices?.[0]?.message?.content ?? '').trim();
    results.push({ kind: 'asr', model, ms: Date.now() - started, text: text.slice(0, 80) });
    console.log(`[asr] ${model}: ${Date.now() - started}ms → ${text.slice(0, 60)}`);
  } catch (e) {
    results.push({ kind: 'asr', model, error: e.message });
    console.log(`[asr] ${model}: 失败 ${e.message}`);
  }
}

async function probeVisionSolve(model) {
  try {
    const img = fs.readFileSync(path.join(root, 'shots', SOLVE_IMG));
    const r = await streamChat({
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: SOLVE_PROMPT },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${img.toString('base64')}` } },
        ],
      }],
      maxTokens: 600,
    });
    results.push({
      kind: 'solve', model,
      ttftMs: r.ttftMs, totalMs: r.totalMs, chars: r.text.length,
      sample: r.text.replace(/\s+/g, ' ').slice(0, 300),
    });
    console.log(`[solve] ${model}: ttft ${r.ttftMs}ms total ${r.totalMs}ms ${r.text.length}字`);
  } catch (e) {
    results.push({ kind: 'solve', model, error: e.message });
    console.log(`[solve] ${model}: 失败 ${e.message}`);
  }
}

for (const m of TEXT_MODELS) await probeText(m);
for (const m of EXTRA_TEXT) await probeText(m);
for (const m of VISION_MODELS) await probeVision(m);
for (const m of VISION_MODELS) await probeVisionSolve(m);
await probeAsr('qwen3.5-omni-flash');
await probeAsr('qwen3.8-omni-flash');

fs.writeFileSync(path.join(root, 'scripts', 'model-probe-results.json'), JSON.stringify(results, null, 2));
console.log('\n结果已写入 scripts/model-probe-results.json');
