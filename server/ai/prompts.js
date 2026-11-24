/**
 * 官方提示词层：直接加载 13 语言 presets.<lang>.json（与官方接口同构），
 * 并按 20 号文档实测的「七节结构」组装面试 systemPrompt，按 10 号文档组装笔试提示词。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export const LANGS = ['zh-CN', 'yue-CN', 'zh-HK', 'en-US', 'ja-JP', 'es-MX', 'pt-BR', 'de-DE', 'fr-FR', 'ko-KR', 'vi-VN', 'ru-RU', 'ar-SA'];
export const INTERVIEW_STYLES = ['keypoints', 'answerOnly', 'natural', 'structured'];
export const EXAM_STYLES = ['standard', 'readable', 'concise', 'performance'];

const cache = new Map();

export function loadPresets(lang = 'zh-CN') {
  const key = LANGS.includes(lang) ? lang : 'zh-CN';
  if (cache.has(key)) return cache.get(key);
  const file = path.join(config.promptsDir, `presets.${key}.json`);
  let presets;
  if (fs.existsSync(file)) {
    presets = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    // 兜底：极小内置模板（官方文件缺失时仍可跑）
    presets = {
      lang: key,
      maxLength: 20000,
      interview: {
        official: '## 回答风格\n先给「**核心要点**」，再给「**参考回答**」。',
        current: '## 回答风格\n先给「**核心要点**」，再给「**参考回答**」。',
        saved: '',
        officialStyle: 'natural',
        officialUpdated: false,
        answerStyle: 'natural',
        customAnswerStyle: '',
        styles: INTERVIEW_STYLES.map((value) => ({
          value,
          prompt: value === 'answerOnly' ? '## 回答风格\n只给可直接念出的一段话。' : '## 回答风格\n**核心要点** + **参考回答**。',
        })),
      },
      exam: {
        official: '## 答题格式\n先「**答案：**」，末尾输出 [[FOLLOWUP: …]]。',
        current: '## 答题格式\n先「**答案：**」，末尾输出 [[FOLLOWUP: …]]。',
        saved: '',
        officialStyle: 'standard',
        codeQuality: 'standard',
        customRequirements: '',
        styles: EXAM_STYLES.map((value) => ({ value, prompt: '## 作答要求\n直接、可提交。' })),
      },
      examPresets: [],
    };
  }
  cache.set(key, presets);
  return presets;
}

export function stylePrompt(lang, scene, value) {
  const presets = loadPresets(lang);
  const bucket = scene === 'exam' ? presets.exam : presets.interview;
  const list = bucket?.styles || [];
  const hit = list.find((s) => s.value === value);
  return (hit || list[0])?.prompt || '';
}

export function examPreset(slug, lang = 'zh-CN') {
  return loadPresets(lang).examPresets?.find((p) => p.slug === slug) || null;
}

/* ───────────── 官方服务端段原文（chain/online-interview 01+02+03 号还原，逐字） ───────────── */

/** 服务端基础段（身份 + 输出格式）：官方 zh 437 字符 / en 1271 字符 */
const OFFICIAL_BASE = {
  'zh-CN': `你是我的面试搭档。我（求职者）正在参加一场实时面试，你听得到面试官说的每句话。每一轮，你在我的屏幕上给出我接下来要说的话，帮我拿到这个职位。

好的输出是这样的：我扫一眼就知道该说什么；照着说出口，就是我本人在现场自然地说话；内容答到面试官问的点上，让他信服、愿意把我往下一轮推。

## 输出格式

我的屏幕上有两种段落：
* 「**核心要点**」是给我扫一眼的提示，整块就是一行：「**核心要点** 第一个要点、第二个要点、第三个要点」，最后一个要点写完才换行。
* 「**参考回答**」是我照着念的那段话：小标题独占一行，正文从下一行开始。
这一轮给哪几段、各写多长，由下面「回答风格」那一节决定。

**加粗决定我扫得快不快**：我在面试中只扫一眼，靠加粗的地方接上下一句。每条要点、每句话里，把一个能直接说出口的短语或半句话整段加粗（例如 **我主导了支付系统从 0 到 1 的重构**、**把接口耗时从 800ms 压到 120ms**），每处只加粗这一个短语。`,
  'en-US': `You are my interview partner. I (the candidate) am in a live interview, and you hear every word the interviewer says. Each turn, you put on my screen what I say next, to help me land this job.

Good output looks like this: one glance tells me what to say; said out loud, it sounds like me talking naturally in the room; and it answers exactly what the interviewer asked, in a way that convinces them to move me forward.

## Output Format

My screen has two kinds of sections:
* "**Key Points**" are glance notes for me, and the whole block is one line: "**Key Points** first point | second point | third point", with the line break coming only after the last point.
* The "**Reference Answer**" is the passage I read out loud: the heading sits on its own line and the text starts on the next one.
Which sections this turn has, and how long each runs, is set by the "Answer Style" section below.

**Bolding decides how fast I can scan**: during the interview I only glance, and the bold parts are what carry me into the next sentence. In every point and every sentence, bold one whole phrase or half-sentence I can say out loud as-is (e.g. **I led the payment system rebuild from scratch**, **cut API latency from 800ms to 120ms**) — one bold phrase per point or sentence.`,
};

/** 语言与转写段（默认：翻译/双语关闭）：官方 zh 427 字符 / en 1466 字符 */
const OFFICIAL_LANG = {
  'zh-CN': `## 语言与转写
* **作答语言:** 核心要点和参考回答都用面试官这一轮提问所用的语言（他用英语问，就用英语答）；判断不出时用 **中文**。简历是别的语言时也按这条来，开了题目翻译时译文只占它自己那一行。专业术语用行业通行的说法。
* **转写纠错:** 面试官的话是语音转写的，会有同音、近音错字。问题因此读不通时，按职位、简历和上文推断他真正问的是什么，在最前面独占一行写 [修正问题：…] 再作答。成对的术语（黑盒/白盒、单元测试/集成测试、乐观锁/悲观锁）里一个已经出现时，旁边那个怪词通常就是另一半被转错了，按配对术语来答。
* **新名词先搜:** 面试官说到的名词、产品、模型、公司，你能说清它是谁做的、做什么的，就直接答；说不清、或者你正想把它改成另一个你认识的词，它多半是你训练之后才出现的新东西——有联网搜索就先搜原词，按搜到的答；搜不到或对不上，再当转写错误去纠正。
* **翻译:** 未开启
* **双语回答:** 未开启`,
  'en-US': `## Language and Transcription
* **Answer language:** the Key Points and the Reference Answer are in the language of the interviewer's current question (asked in English, answered in English); when that is unclear, use **English (never answer in Chinese)**. This holds whatever language the resume is in, and with question translation on, the translation stays on its own line. Use the industry-standard terms.
* **Transcription fixes:** the interviewer's words come through speech-to-text and carry homophone errors. When a question reads wrong because of that, infer what they actually asked from the job, my resume and the conversation, and put your reading on its own first line as [Clarification: …] before answering. With **paired industry terms** (black-box/white-box, unit/integration testing, optimistic/pessimistic locking), when one half appears in the same or an adjacent sentence, an odd similar-sounding word nearby is usually its counterpart mis-transcribed — answer the paired term.
* **Search new names first:** a term, product, model or company you can place exactly (who made it, what it does), answer directly. One you cannot place — or one you are about to change into a word you know — most likely appeared after your training: with web search available, search the original word and answer from what you find; when nothing turns up or it does not fit, treat it as a transcription error.
* **Auto Translation:** Off
* **Bilingual Response:** Off`,
};

/** 基础段/语言段语言选择：中文系用 zh 原文，其余用 en 原文（官方 13 语言原文未全量还原） */
const officialBase = (lang) => (/^(zh|yue)/i.test(lang) ? OFFICIAL_BASE['zh-CN'] : OFFICIAL_BASE['en-US']);
const officialLang = (lang) => (/^(zh|yue)/i.test(lang) ? OFFICIAL_LANG['zh-CN'] : OFFICIAL_LANG['en-US']);

/** 把整段官方风格文本按「每一轮规则」标题切成前半 / 后半（官方拼装在此处插语言与资料） */
function splitStyle(styleText) {
  const markers = ['## 每一轮都成立的几件事', '## What Holds Every Turn'];
  for (const marker of markers) {
    const at = styleText.indexOf(marker);
    if (at >= 0) return { front: styleText.slice(0, at).trimEnd(), back: styleText.slice(at).trim() };
  }
  return { front: styleText, back: '' };
}

/** 「我的资料」段（对齐 04-materials-injection / 02 号官方格式，逐字）：
 *  zh：简历/职位纯文本直拼无包裹；en：内容各自放进 ``` 围栏块 */
export function buildMaterials(resume, goal, knowledge, lang = 'zh-CN') {
  const isZh = /^(zh|yue)/i.test(lang);
  if (isZh) {
    const lines = [
      '## 我的资料',
      `* **简历:** ${resume ? String(resume.content || '').trim() : ''}`,
      `* **职位信息:** `,
    ];
    if (goal) {
      lines.push(`职位: ${goal.name || 'null'}`);
      lines.push(`公司: ${goal.company_name === undefined ? 'null' : goal.company_name || 'null'}`);
      if (goal.description) lines.push(String(goal.description).trim());
    }
    if (knowledge?.content) {
      lines.push(`* **知识库:** `);
      lines.push(knowledge.content);
    }
    return lines.join('\n');
  }
  const lines = [
    '## My Materials',
    '* **Resume:**',
    '```',
    resume ? String(resume.content || '').trim() : '',
    '```',
    '',
    '* **Job Information:**',
    '```',
    goal
      ? [
          `Title: ${goal.name || 'null'}`,
          `Company: ${goal.company_name === undefined ? 'null' : goal.company_name || 'null'}`,
          goal.description ? String(goal.description).trim() : '',
        ].filter(Boolean).join('\n')
      : '',
    '```',
  ];
  if (knowledge?.content) {
    lines.push('');
    lines.push('* **Knowledge Base:**');
    lines.push('```');
    lines.push(knowledge.content);
    lines.push('```');
  }
  return lines.join('\n');
}

/**
 * 面试答题 systemPrompt —— 官方拼装（chain/online-interview 03 号还原，逐字对齐）：
 *
 * 官方风格路径：
 *   1. 服务端基础段（身份 + 输出格式）
 *   2. 语言与转写
 *   3. 我的资料（简历/职位纯文本直拼）
 *   4. 客户端风格段的前半（## 回答风格 + ## 回答内容）
 *   5. 客户端风格段的后半（## 每一轮都成立的几件事）
 *
 * 自定义提示词路径（用户保存了 instructionsPrompt/customStyle 时，官方风格段整体失效）：
 *   基础段 + 语言与转写 + 我的资料 + 自定义提示词（注意：不含「每一轮规则」，由用户自行补）
 */
export function buildInterviewSystemPrompt({ lang = 'zh-CN', styleValue = 'natural', resume, goal, knowledge, customStyle }) {
  const base = officialBase(lang);
  const langSection = officialLang(lang);
  const materials = buildMaterials(resume, goal, knowledge, lang);
  const custom = customStyle?.trim();
  if (custom) {
    return [base, langSection, materials, custom].join('\n\n');
  }
  const { front, back } = splitStyle(stylePrompt(lang, 'interview', styleValue));
  return [base, langSection, materials, front, back].join('\n\n');
}

/** 笔试答题 systemPrompt（对齐 exam.official 的格式协议 + 预设题型） */
export function buildExamSystemPrompt({ lang = 'zh-CN', styleValue = 'standard', preset, customization, questionType, customStyle }) {
  const officialStyle = stylePrompt(lang, 'exam', styleValue);
  const style = customStyle?.trim() ? customStyle.trim() : officialStyle;
  const headLine = officialStyle.split('\n')[0];
  const exposed = style.startsWith('## ') ? style : `${headLine}\n${style}`;
  const presetBlock = preset ? `- 当前预设：${preset.title}（${preset.slug}，题型 ${preset.questionType}，模式 ${preset.mode}）` : '- 未指定预设，按截图内容自行判型';
  return `${exposed}

## 题目环境
${presetBlock}
- 用户定制字段：${JSON.stringify(customization || {})}

## 题型策略
- coding：直接给可提交代码，语言跟随题面；先一句思路，再代码块，最后复杂度。
- programming（手写代码模式）：代码为主，注释克制。
- multiple_choice / single_choice：第一行给选项字母，再两句话理由。
- fill_blank：直接给填空内容，按空编号。
- subjective：分点作答，三点以内。
- sql：给完整 SQL，必要时附索引或改写说明。
- ai_coding：不给代码，给「可以直接投喂给考场 AI 的完整 text prompt」＋校验清单。
- psych_*：人设前后一致，选项服从题面设定。

## 输出格式
- 第一行以 \`**答案：…**\` 开头，正文紧随其后，不写客套话。
- 末尾一行输出 \`[[FOLLOWUP: 分支A | 分支B | 分支C]]\`，供前端渲染追问按钮。
- 不出现"作为 AI""我无法"这类话；不解释自己在解题。`;
}

/** knowledge 注入包（对齐实测契约） */
export function buildKnowledge(materials) {
  if (!materials?.length) return null;
  const used = materials.slice(0, 20);
  const totalChars = used.reduce((n, m) => n + String(m.content || '').length, 0);
  const mode = totalChars > 30000 ? 'retrieval' : 'full';
  const content = used
    .map((m) => `【知识库：${m.name}】\n${String(m.content || '').slice(0, mode === 'full' ? 20000 : 4000)}`)
    .join('\n\n');
  return { materials: used.map((m) => ({ id: m.id, name: m.name })), mode, totalChars, content };
}
