/**
 * 业务管线：把「规则/检索/提示词组装」与「模型调用」解耦。
 * 对齐 20 号文档实测响应契约：{scene, systemPrompt, answer, ttftMs, totalMs, error, knowledge}。
 */
import { all, one } from '../db.js';
import { fromJson } from '../util.js';
import fs from 'node:fs';
import {
  buildExamSystemPrompt,
  buildInterviewSystemPrompt,
  buildKnowledge,
  examPreset,
  loadPresets,
} from './prompts.js';
import { interviewAnswer, examAnswer, nextQuestion, interviewerReaction, buildReport } from './mockBrain.js';
import { openaiComplete, providerName, createStreamQueue } from './provider.js';
import { imageForVision } from './enrich.js';
import { config } from '../config.js';

export function loadResume(userId, resumeId) {
  if (!resumeId) return null;
  return one('SELECT * FROM resumes WHERE user_id=? AND id=?', userId, resumeId);
}
export function loadGoal(userId, goalId) {
  if (!goalId) return null;
  return one('SELECT * FROM goals WHERE user_id=? AND id=?', userId, goalId);
}
export function loadMaterials(userId, ids) {
  if (!ids?.length) return [];
  return all(
    `SELECT * FROM materials WHERE user_id=? AND id IN (${ids.map(() => '?').join(',')})`,
    userId,
    ...ids,
  );
}

export function buildContext(userId, { resumeId, goalId, materialIds }) {
  return {
    resume: loadResume(userId, resumeId),
    goal: loadGoal(userId, goalId),
    materials: loadMaterials(userId, materialIds),
  };
}

/** 非流式面试答题（promptStudio.run 等价物） */
export async function interviewRun({ userId, question, lang = 'zh-CN', styleValue = 'natural', resumeId, goalId, materialIds, customStyle }) {
  const ctx = buildContext(userId, { resumeId, goalId, materialIds });
  const knowledge = buildKnowledge(ctx.materials);
  const systemPrompt = buildInterviewSystemPrompt({
    lang, styleValue, resume: ctx.resume, goal: ctx.goal, knowledge, customStyle,
  });
  const started = Date.now();

  let text;
  if (providerName() === 'openai') {
    const r = await openaiComplete({
      system: systemPrompt,
      messages: [{ role: 'USER', content: question }],
    });
    text = r.text;
  } else {
    text = interviewAnswer({ question, resume: ctx.resume, goal: ctx.goal, knowledge, styleValue });
  }
  return {
    scene: 'interview',
    systemPrompt,
    answer: text,
    ttftMs: Date.now() - started - 20,
    totalMs: Date.now() - started,
    error: null,
    answerLang: null,
    caseTitle: ctx.resume?.title || null,
    knowledge,
  };
}

/** 流式面试答题（socket 用）：yield 文本增量；signal 供 ai.interrupt 真打断 */
export async function* interviewStream({ userId, question, lang = 'zh-CN', styleValue = 'natural', resumeId, goalId, materialIds, customStyle, history = [], signal }) {
  const ctx = buildContext(userId, { resumeId, goalId, materialIds });
  const knowledge = buildKnowledge(ctx.materials);
  const systemPrompt = buildInterviewSystemPrompt({
    lang, styleValue, resume: ctx.resume, goal: ctx.goal, knowledge, customStyle,
  });

  if (providerName() === 'openai') {
    // 事件驱动队列：上游 onDelta 直推，迭代器零轮询转发。
    // user 消息模板对齐官方（05 号还原）：本轮面试官转写包 <USER_MESSAGE>，
    // 历史里我说出口的话由调用方包 <my_spoken_answer> 后经 history 传入。
    const q = createStreamQueue();
    const task = openaiComplete({
      system: systemPrompt,
      messages: [...history, { role: 'USER', content: `<USER_MESSAGE>\n${question}\n</USER_MESSAGE>` }],
      onDelta: (d) => q.push(d),
      signal,
    }).catch((e) => q.fail(e))
      .finally(() => q.end());
    for await (const d of q) yield d;
    await task;
    return;
  }
  const text = interviewAnswer({ question, resume: ctx.resume, goal: ctx.goal, knowledge, styleValue });
  yield* streamChunks(text);
}

async function* streamChunks(text, size = 3) {
  for (let i = 0; i < text.length; i += size) {
    yield text.slice(i, i + size);
    await new Promise((r) => setTimeout(r, 16));
  }
}

/** 笔试解题（流式）：openai 模式单次尝试（有有效截图走视觉模型，否则纯文本），
 *  失败直接抛错由调用方报给前端（不再降级文本/mock）；signal 供 exam.abort 真打断 */
export async function* examSolveStream({ userId, questionText, screenshotPath, presetSlug, mode = 'quick', customization, lang = 'zh-CN', signal }) {
  const preset = presetSlug ? examPreset(presetSlug, lang) : null;
  const systemPrompt = buildExamSystemPrompt({ lang, preset, customization, styleValue: customization?.codeQuality || 'standard' });
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  if (providerName() === 'openai') {
    let attempt = null;
    if (screenshotPath && fs.existsSync(screenshotPath)) {
      const buf = fs.readFileSync(screenshotPath); // 读取失败自然抛错
      const img = imageForVision(buf);
      if (img) {
        attempt = {
          tag: 'vision',
          model: config.ai.visionModel,
          userContent: [
            { type: 'text', text: `题目：${questionText || '（请从截图中识别题目并完整作答）'}` },
            { type: 'image_url', image_url: { url: img.url } },
          ],
        };
      }
    }
    if (!attempt) {
      if (!questionText) throw new Error('没有可用的题目输入：截图缺失或无效（需 PNG/JPEG/WebP/BMP ≥16×16），且未填写题面文本');
      attempt = { tag: 'text', userContent: `题目：${questionText}\n模式：${mode}` };
    }

    let emitted = 0;
    const q = createStreamQueue();
    let err = null;
    const task = openaiComplete({
      system: systemPrompt,
      userContent: attempt.userContent,
      maxTokens: 1400,
      ...(attempt.model ? { model: attempt.model } : {}),
      onDelta: (d) => q.push(d),
      signal,
    }).catch((e) => { err = e; })
      .finally(() => q.end());
    for await (const d of q) {
      emitted += 1;
      yield { type: 'delta', text: d };
    }
    await task;
    if (err && emitted === 0) throw err;
    if (emitted === 0) throw new Error('上游模型无输出');
    if (err) console.warn(`[exam] 流式尾部出错（已输出 ${emitted} 段，保留部分答案）:`, err.message);
    return;
  }

  const r = examAnswer({ questionText, preset, mode, screenshot: Boolean(screenshotPath) });
  for (let i = 0; i < r.reasoning.length; i += 12) {
    yield { type: 'reasoning', text: r.reasoning.slice(i, i + 12) };
    await pause(12);
  }
  for (let i = 0; i < r.answer.length; i += 4) {
    yield { type: 'delta', text: r.answer.slice(i, i + 4) };
    await pause(14);
  }
}

/** 非流式笔试答题（promptStudio.run 的 exam 场景等价物） */
export async function examRun({ questionText, presetSlug, mode = 'quick', customization, lang = 'zh-CN' }) {
  const preset = presetSlug ? examPreset(presetSlug, lang) : null;
  const systemPrompt = buildExamSystemPrompt({ lang, preset, customization, styleValue: customization?.codeQuality || 'standard' });
  if (providerName() === 'openai') {
    const r = await openaiComplete({
      system: systemPrompt,
      messages: [{ role: 'USER', content: `题目：${questionText || '（未提供题目）'}\n模式：${mode}` }],
      maxTokens: 1200,
    });
    return { answer: r.text, systemPrompt, provider: providerName() };
  }
  const r = examAnswer({ questionText, preset, mode });
  return { answer: r.answer, systemPrompt, provider: providerName() };
}

/** mock 面试官下一题 */
export function mockNextQuestion({ goal, round = 'FIRST', turn = 0, difficulty = '3_5_YEARS', basicsRatio = 0.4 }) {
  return nextQuestion({ goal, round, turn, difficulty, basicsRatio });
}
export const mockReaction = interviewerReaction;

/** promptStudio.assist：openai 模式真改写（失败直接抛错）；mock 模式为本地压缩主路径 */
export async function promptAssist({ scene, mode = 'refine', draft, lang = 'zh-CN', instruction }) {
  if (!instruction) throw Object.assign(new Error('请先说明希望如何修改'), { code: 'BAD_REQUEST' });
  if (providerName() === 'openai') {
    const r = await openaiComplete({
        system: `你是提示词工程师。用户会给一段「${scene === 'exam' ? '笔试答题' : '面试回答'}」提示词草稿和一条修改要求。按修改要求改写草稿，保持输出协议（${scene === 'exam' ? '**答案：** + [[FOLLOWUP: …]]' : '**核心要点** + **参考回答**'}）与分档字数约束。只输出改写后的提示词全文，不要任何解释。`,
        messages: [{ role: 'USER', content: `修改要求：${instruction}\n\n提示词草稿：\n${draft}` }],
        maxTokens: 1200,
      });
      return {
        prompt: r.text,
        summary: `已按「${instruction}」用 ${config.ai.model} 完成改写。`,
        nextBaseline: null,
        mode,
        lang,
        provider: providerName(),
      };
  }
  const lines = String(draft || '').split('\n');
  const heads = lines.filter((l) => l.startsWith('##') || /^-\s/.test(l)).slice(0, 6);
  const compressed =
    `## ${scene === 'exam' ? '答题' : '回答'}规则（精简版）\n` +
    heads.map((h) => h.replace(/^##\s*/, '- ')).join('\n') +
    `\n- 每轮输出：${scene === 'exam' ? '**答案：** + [[FOLLOWUP: …]]' : '**核心要点** + **参考回答**'}\n- 篇幅：封闭题 20 字内 / 短追问 40 字内 / 开放题 120 字内`;
  return {
    prompt: compressed.slice(0, 600),
    summary: `按「${instruction}」把原提示词压成 ${heads.length} 条规则，保留双段输出协议与分档字数。`,
    nextBaseline: null,
    mode,
    lang,
    provider: providerName(),
  };
}

const clampScore = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

/** LLM rubric 复盘报告（openai 模式）：输出严格 JSON，映射为官方报告 schema；两次解析重试后仍失败则抛错 */
async function llmReport({ session, messages, goal, resume }) {
  const convo = messages
    .filter((m) => ['INTERVIEWER', 'USER', 'ASSISTANT', 'SYSTEM'].includes(m.role))
    .map((m) => `${m.role === 'INTERVIEWER' ? '面试官' : m.role === 'USER' ? '候选人' : m.role === 'ASSISTANT' ? 'AI参考' : '系统'}：${m.content}`)
    .join('\n')
    .slice(-9000);
  // 两次尝试：首轮常规；解析失败（多为输出被 maxTokens 截断）则放大预算并要求紧凑 JSON
  const systemBase =
    '你是资深技术面试复盘官。根据面试对话生成复盘报告，严格输出 JSON（不要 markdown 代码块、不要解释），结构：\n' +
    '{"score":0到100的总分,"fiveDimensions":[{"dimension":"维度名","score":0到100,"comment":"一句点评"}共5个],' +
    '"interviewSummary":"整体点评2到3句","strengths":[{"strength":"优点","reason":"对话中的依据"}共3个],' +
    '"shortcomings":[{"shortcoming":"不足","reason":"对话中的依据"}共3个],"interviewSuggestions":["可执行建议"共5条],' +
    '"relatedKnowledge":[{"knowledge":"相关知识点","concept":"一句话解释"}共13个],' +
    '"conversationAnalysis":[{"question":"面试官问题","answer":"候选人回答前200字","score":0到100,"evaluation":"点评","suggestion":"示范答法"}最多7轮]}\n' +
    '五个维度从技术深度、系统设计、基础原理、工程实践、沟通表达中按对话实际内容评定。';
  const userMsg = `岗位：${goal?.name || '技术岗'}\n简历：${resume?.title || '未知'}\n\n${convo}`;

  let j = null;
  let lastErr = null;
  for (const [maxTokens, extra] of [[4000, ''], [8000, '\n注意：输出必须紧凑（不要换行缩进），控制在 3000 token 内，务必闭合 JSON。']]) {
    try {
      const r = await openaiComplete({ system: systemBase + extra, messages: [{ role: 'USER', content: userMsg }], maxTokens });
      const raw = r.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
      try {
        j = JSON.parse(raw);
      } catch {
        const s = raw.indexOf('{');
        const e = raw.lastIndexOf('}');
        const repaired = s >= 0 && e > s ? raw.slice(s, e + 1).replace(/,\s*([}\]])/g, '$1') : raw;
        j = JSON.parse(repaired);
      }
      break;
    } catch (e) {
      lastErr = e;
      console.warn(`[report] 第 ${maxTokens} token 档解析失败，重试: ${e.message.slice(0, 80)}`);
    }
  }
  if (!j) throw lastErr || new Error('报告 JSON 生成失败');
  const dims = (j.fiveDimensions || []).slice(0, 5).map((d) => ({
    dimension: String(d.dimension ?? ''), score: clampScore(d.score), comment: String(d.comment || ''),
  }));
  const avg = dims.length ? Math.round(dims.reduce((n, d) => n + d.score, 0) / dims.length) : clampScore(j.score);
  return {
    status: 'success',
    sessionId: session.id,
    title: `${goal?.name || '面试'} · 复盘报告`,
    score: clampScore(j.score ?? avg),
    generatedAt: new Date().toISOString(),
    interviewSummary: {
      fiveDimensions: dims,
      interviewSummary: String(j.interviewSummary || ''),
      strengths: (j.strengths || []).slice(0, 3).map((s) => (typeof s === 'string' ? { strength: s, reason: '' } : { strength: String(s.strength ?? ''), reason: String(s.reason || '') })),
      shortcomings: (j.shortcomings || []).slice(0, 3).map((s) => (typeof s === 'string' ? { shortcoming: s, reason: '' } : { shortcoming: String(s.shortcoming ?? ''), reason: String(s.reason || '') })),
      interviewSuggestions: (j.interviewSuggestions || j.suggestions || []).slice(0, 5).map(String),
    },
    relatedKnowledge: (j.relatedKnowledge || []).slice(0, 13).map((k) => (typeof k === 'string' ? { knowledge: k, concept: '' } : { knowledge: String(k.knowledge ?? ''), concept: String(k.concept || '') })),
    conversationAnalysis: (j.conversationAnalysis || []).slice(0, 7).map((c) => ({
      topic: String(c.question || c.topic || '').slice(0, 18),
      score: clampScore(c.score ?? 70),
      turns: [{ question: String(c.question || ''), answer: String(c.answer || '') }],
      question: String(c.question || ''),
      answer: String(c.answer || ''),
      evaluation: String(c.evaluation || ''),
      suggestion: String(c.suggestion || ''),
    })),
    resumeTitle: resume?.title || null,
    provider: `${config.ai.model} (llm-rubric)`,
  };
}

/** 复盘报告：openai 模式 LLM rubric（对齐文档 25 §3 的 ~80% 置信推断），失败直接抛错由调用方提示；
 *  mock 模式为本地 rubric 主路径 */
export async function reportFor(session, messages, ctx) {
  const goal = ctx?.goal;
  const resume = ctx?.resume;
  if (providerName() === 'openai') {
    return llmReport({ session, messages, goal, resume });
  }
  return buildReport({ session, messages, goal, resume });
}

export const presetsOf = (lang) => loadPresets(lang);
export const inferenceLimits = config.limits;
