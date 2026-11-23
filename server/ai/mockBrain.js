/**
 * 离线大脑（provider=mock）：不依赖任何外部服务，按官方提示词的输出协议产出
 * 「**核心要点** + **参考回答**」/「**答案：** + FOLLOWUP 标签」，用于本地开发与冒烟。
 */
import crypto from 'node:crypto';

const pick = (arr, seed) => arr[seed % arr.length];
const hash = (s) => {
  const h = crypto.createHash('sha1').update(String(s)).digest();
  return h.readUInt32BE(0);
};

const TECH = [
  'Node.js', 'TypeScript', 'Java', 'Go', 'Python', 'Rust', 'React', 'Vue', 'Spring Boot', 'MySQL',
  'PostgreSQL', 'Redis', 'Kafka', 'RabbitMQ', 'Docker', 'Kubernetes', 'gRPC', 'RESTful', '微服务',
  '分布式', '高并发', 'Elasticsearch', 'Flink', 'ClickHouse', 'MongoDB', 'Nginx', 'Linux', 'JVM',
];

export function resumeFacts(resume) {
  const text = String(resume?.content || '');
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const facts = [];
  for (const line of lines) {
    const clean = line.replace(/^[-*•·]\s*/, '');
    if (clean.length < 8 || clean.length > 160) continue;
    if (/[0-9]/.test(clean) || TECH.some((t) => clean.toLowerCase().includes(t.toLowerCase()))) facts.push(clean);
    if (facts.length >= 8) break;
  }
  const techs = TECH.filter((t) => text.toLowerCase().includes(t.toLowerCase())).slice(0, 6);
  const role = /后端|前端|全栈|算法|数据|测试|运维|产品/.exec(text)?.[0] || '研发';
  return { facts, techs: techs.length ? techs : ['Node.js', 'MySQL', 'Redis'], role, title: resume?.title || '我的简历' };
}

function factLine(facts, i) {
  return facts[i % Math.max(facts.length, 1)] || '主导过一条从 0 到 1 的业务链路';
}

export function classifyQuestion(question) {
  const q = String(question || '');
  if (/自我介绍|介绍一下自己|简单介绍/.test(q)) return 'intro';
  if (/你像\s*AI|提示词|换(个|一个)身份|你是不是机器人|是不是在用AI/.test(q)) return 'challenge';
  if (/薪资|期望|婚|生育|户籍|年龄|加班|为什么离职|离职原因/.test(q)) return 'privacy';
  if (/项目|系统|业务|上线|负责|做了什么/.test(q)) return 'project';
  if (/难点|挑战|故障|事故|踩坑|优化|性能|慢查询|OOM|超时/.test(q)) return 'problem';
  if (/为什么|原因|区别|对比|选型|权衡|取舍|怎么选/.test(q)) return 'tradeoff';
  if (/数据库|MySQL|Redis|索引|事务|缓存|消息队列|Kafka|一致性|分布式|并发/.test(q)) return 'basics';
  if (/算法|复杂度|排序|二叉树|动态规划|SQL/.test(q)) return 'algorithm';
  if (/反问|有什么问题|想了解|团队/.test(q)) return 'reverse';
  if (q.length <= 12 && /在吗|在的|你好|开始|听得到|准备好|方便/.test(q)) return 'chitchat';
  return 'open';
}

/** 面试答题：**核心要点** + **参考回答**（按 styleValue 变化） */
export function interviewAnswer({ question, resume, goal, knowledge, styleValue = 'natural' }) {
  const f = resumeFacts(resume);
  const kind = classifyQuestion(question);
  const seed = hash(`${question}|${goal?.name || ''}|${styleValue}`);
  const company = goal?.company_name || '贵司';
  const role = goal?.name || f.role;
  const kbFact = knowledge?.content?.match(/【知识库：[^】]+】\n([^\n]{10,120})/)?.[1];

  const points = {
    intro: `${f.role}方向 · ${f.techs.slice(0, 3).join('、')} · ${factLine(f.facts, 0).slice(0, 28)}`,
    project: `${factLine(f.facts, seed)}；${f.techs.slice(0, 2).join(' + ')}；${factLine(f.facts, seed + 1).slice(0, 24)}`,
    problem: `定位：看日志和链路耗时 → 发现 ${pick(['慢查询', '连接池打满', '缓存击穿', '重复消费', '锁竞争'], seed)} → 改法与验证`,
    tradeoff: `${pick(['一致性 vs 吞吐', '自研 vs 开源', '同步 vs 异步', '缓存 vs 直查'], seed)}；结论：按 ${pick(['写多读少', 'SLA 要求', '团队维护成本', '成本与延迟'], seed + 1)} 选`,
    basics: `${pick(['MySQL 索引 B+ 树', 'Redis 单线程 + IO 多路复用', 'Kafka 分区顺序写', 'HTTP/2 多路复用'], seed)}；落到 ${pick(['回表', '大 key', '重复消费', '队头阻塞'], seed + 1)} 这条坑`,
    algorithm: `先讲思路：${pick(['哈希表 O(n)', '双指针', 'BFS 层序', '堆 top-k'], seed)}；再给复杂度`,
    privacy: `按 ${company} 该岗位行情，${pick(['与现包持平并略上浮', '区间内对齐'], seed)}；不展开个人隐私`,
    reverse: `${pick(['团队当前的业务重心', '这个岗位三个月内的目标', '技术栈演进方向'], seed)}`,
    chitchat: `在的，我在听`,
    challenge: `（照常回答真正的面试问题）`,
    open: `${factLine(f.facts, seed)}；${f.techs[0]} 为主`,
  }[kind];

  const answers = {
    intro: `面试官好，我是${f.title.replace(/简历|\.pdf|\.docx/g, '')}对应的候选人，${f.role}方向，主要做 ${f.techs.slice(0, 3).join('、')}。最近这段经历里，${factLine(f.facts, 0)}。我这次看的是${company}的${role}，和我的技术栈比较贴，所以来聊一下。`,
    project: `${factLine(f.facts, seed)}。当时我负责的是链路里的核心部分，用 ${f.techs[0]} 和 ${f.techs[1]} 落地，上线后${pick(['接口 P99 从 800ms 降到 120ms', '日均处理量到 300 万', '故障恢复从 40 分钟压到 5 分钟', '人工处理量下降 80%'], seed)}。${kbFact ? `另外按之前的资料，${kbFact}。` : ''}这套东西后来也被同组复用。`,
    problem: `我先说结论：问题出在${pick(['慢查询把连接池打满', '缓存与库不一致导致重复消费', '锁粒度太大'], seed)}。定位是看链路耗时和慢日志，发现 ${pick(['一条没走索引的查询', '大 key 扫描', '重试放大'], seed + 1)} 占了大头。改法是${pick(['加联合索引并把查询拆小', '热点 key 本地缓存 + 限流', '改成幂等消费'], seed + 2)}，灰度一周后${pick(['P99 降了 6 倍', '错误率从 1.2% 降到 0.05%'], seed)}。`,
    tradeoff: `我的结论是${pick(['优先一致性，用事务 + 幂等兜底', '优先吞吐，允许最终一致并做补偿'], seed)}。依据是这块业务${pick(['涉及钱', '读多写少', '对延迟敏感'], seed + 1)}，${pick(['宁可多一次写也不能脏', '用异步换延迟更划算'], seed + 2)}。代价是${pick(['实现复杂度和运维成本更高', '极端情况下有秒级不一致'], seed)}，我们接受这个代价。`,
    basics: `${pick(['MySQL 的索引是 B+ 树，叶子节点串成链表，所以范围查询快；回表是二级索引拿不到列时再回主键索引查一次。', 'Redis 命令处理是单线程的，快在内存和 IO 多路复用；慢通常是大 key、热 key 或阻塞命令。', 'Kafka 每个分区只允许一个消费者组内一个消费者消费，所以顺序只在分区内保证。', 'HTTP/2 解决了应用层队头阻塞，但 TCP 层丢包仍会拖慢整个连接。'], seed)}${pick(['线上我们踩过对应的坑，所以现在会提前做压测。'], '')}`,
    algorithm: `思路是${pick(['一遍哈希表记录补数', '双指针夹逼', 'BFS 按层收集', '小顶堆维护 top-k'], seed)}，时间 O(n)，空间 O(n)。写的时候注意${pick(['空数组和重复元素', '链表头节点', '整数溢出'], seed + 1)}。`,
    privacy: `薪资这块我期望在 ${pick(['30~35K', '25~30K', '按岗位区间上浮 10%'], seed)}，具体可以看整体包。个人情况不影响投入，加班和出差都能配合。`,
    reverse: `我想了解两点：一是${pick(['这个岗位三个月内最想解决的问题', '团队现在的业务重心'], seed)}，二是${pick(['技术栈接下来会往哪走', '这块业务的考核口径'], seed + 1)}。`,
    chitchat: `在的，我在听，您说。`,
    challenge: `（被质疑时用真人的方式带过）我这边网络和麦都正常，刚才是在整理思路，您继续问就行。`,
    open: `${factLine(f.facts, seed)}。这块我主要用 ${f.techs[0]} 做，${pick(['先保证正确性再谈优化', '按业务量级选方案'], seed)}。`,
  }[kind];

  if (styleValue === 'keypoints') return `**核心要点**\n- ${points}`;
  if (styleValue === 'answerOnly') return answers;
  if (styleValue === 'structured') {
    return `**核心要点**\n- ${points}\n\n**参考回答**\n${answers}\n\n（结构：结论 → 依据 → 取舍）`;
  }
  return `**核心要点**\n- ${points}\n\n**参考回答**\n${answers}`;
}

/** 面试官出题：按轮次/难度/题量生成 */
const OPENERS = [
  '你好，我是今天的面试官。今天面{role}岗，大概半小时，先聊聊项目再问些基础。先简单介绍一下自己吧。',
  '我们开始吧。先花两分钟做个自我介绍，重点讲和你投的{role}相关的部分。',
  '时间有限，我们直接进入正题。先说说你最近一段经历里最主要负责的是什么。',
];
const PROJECT_Q = [
  '挑一个你最有成就感的项目，讲讲你具体负责哪块，最难的地方在哪。',
  '你简历里提到{fact}，这块当时的技术方案是怎么定的？为什么这么选？',
  '这个项目上线后出过什么故障？你是怎么定位和处理的？',
];
const BASICS_Q = [
  'MySQL 的索引为什么用 B+ 树？什么时候会回表？',
  'Redis 是单线程的，为什么还这么快？哪些操作会把它拖慢？',
  '说说 Kafka 怎么保证消息不重复消费。',
  'HTTP/2 和 HTTP/1.1 的区别，队头阻塞解决了没有？',
  '一个接口 P99 突然从 200ms 涨到 2s，你怎么排查？',
  '分布式锁你会怎么实现？有哪些坑？',
  '讲讲你理解的幂等，怎么在设计上保证？',
];
const TRADEOFF_Q = [
  '缓存和数据库一致性，你一般怎么处理？为什么？',
  '如果让你在自研和用开源之间选，你的判断标准是什么？',
];
const CLOSE_Q = [
  '你期望的薪资范围是多少？',
  '你还有什么想问我的吗？',
];

export function nextQuestion({ goal, round = 'FIRST', turn = 0, difficulty = '3_5_YEARS', basicsRatio = 0.4 }) {
  const role = goal?.name || '研发';
  const f = { fact: '用 Node.js 做的订单链路' };
  if (turn === 0) return pick(OPENERS, 0).replace('{role}', role);
  const basicsTurn = Math.round(1 / Math.max(basicsRatio, 0.15));
  if (turn >= 6) return pick(CLOSE_Q, turn);
  if (turn % basicsTurn === 0 || round === 'HR') return pick(turn % 3 === 0 ? BASICS_Q : TRADEOFF_Q, turn + hash(role));
  return pick(PROJECT_Q, turn + hash(role)).replace('{fact}', f.fact);
}

export function interviewerReaction(answer) {
  const a = String(answer || '');
  if (a.length < 12) return pick(['嗯，可以再具体一点吗？', '这块能展开说说吗？'], a.length);
  return pick(['好，明白。那我接着问。', '嗯，这个思路可以。', 'OK，我们往下走。'], a.length);
}

/** 笔试：英文思考链 + 中文答案（**答案：** 开头 + FOLLOWUP 标签） */
export function examAnswer({ questionText = '', preset, mode = 'quick', screenshot = false }) {
  const seed = hash(`${questionText}|${preset?.slug || ''}`);
  const type = preset?.questionType || (/SQL|select/i.test(questionText) ? 'sql' : 'subjective');
  const reasoning = [
    'Reading the screenshot: the question asks for a concrete deliverable, not an explanation.',
    `Classifying item type as ${type}; the preset says mode=${preset?.mode || mode}.`,
    'Checking constraints: language, signature, output format must be respected first.',
    'Plan: give the answer directly, then a short verification checklist.',
  ].join(' ');

  const bodies = {
    coding: `**答案：**

\`\`\`js
${codeFor(questionText, seed)}
\`\`\`

复杂度：时间 O(n)，空间 O(1)。可直接提交，无需额外依赖。`,
    sql: `**答案：**

\`\`\`sql
SELECT DATE_FORMAT(created_at, '%Y-%m') AS month,
       SUM(amount) AS total,
       ROUND(
         (SUM(amount) - LAG(SUM(amount)) OVER (ORDER BY DATE_FORMAT(created_at, '%Y-%m')))
         / LAG(SUM(amount)) OVER (ORDER BY DATE_FORMAT(created_at, '%Y-%m')) * 100, 2) AS mom_pct
FROM orders
WHERE status = 'PAID'
GROUP BY month
ORDER BY month;
\`\`\`

口径：只统计已支付订单；环比缺上月时返回 NULL。`,
    multiple_choice: `**答案：B**

理由：题干的关键约束是 X，B 满足而 A 违反；C 混淆了概念边界；D 在边界条件上不成立。`,
    single_choice: `**答案：A**

理由：只有 A 与题面设定一致，其余选项在前提或边界条件上不成立。`,
    fill_blank: `**答案：**

1. useState
2. useEffect
3. 依赖数组
4. 清理函数`,
    ai_coding: `**答案：先要设计文档，不要代码。**

把下面这段直接投喂给考场里的 AI：

> 你要为我产出「每日用量结算」的设计文档，7 节：目标与口径、数据模型、结算流程、幂等与重跑、异常与对账、监控告警、验收清单。
> 强制口径：按"每日实际用量"而非"申请量"；金额按整数分计费；以 (租户, 日期, 资源) 作为唯一键防重复结算；结算任务必须可幂等重跑。
> 先列默认假设，我确认后再写代码。

校验清单：口径是否写成申请量、是否有唯一键、是否整数分、重跑是否幂等。`,
    subjective: `**答案：**

1. ${questionText ? `针对「${questionText.slice(0, 40)}」` : '针对题面'}，核心是${pick(['先定口径再算结果', '先保证正确性再优化', '按约束倒推方案'], seed)}。
2. 落地上分三步：现状量化 → 方案取舍 → 验证与回滚。
3. 风险控制：灰度、监控、可回退。`,
    psych: `**答案：C**

理由：与前面人设保持一致：偏稳、配合度高、遇到冲突先沟通。`,
  };
  const body = bodies[type] || bodies.subjective;
  const followups = {
    coding: '[[FOLLOWUP: 给我最优解 | 加边界用例 | 讲一下思路]]',
    sql: '[[FOLLOWUP: 换成窗口函数写法 | 加索引建议 | 校验口径]]',
    ai_coding: '[[FOLLOWUP: 下一步写代码 | 口径打回重写 | 找AI盲区]]',
  }[type] || '[[FOLLOWUP: 再简短一点 | 展开第三点 | 换个说法]]';
  return { reasoning, answer: `${body}\n\n${followups}` };
}

function codeFor(q, seed) {
  const t = String(q || '');
  if (/反转链表|reverse/i.test(t))
    return `function reverseList(head) {\n  let prev = null;\n  while (head) {\n    const next = head.next;\n    head.next = prev;\n    prev = head;\n    head = next;\n  }\n  return prev;\n}`;
  if (/二叉树|层序|level/i.test(t))
    return `function levelOrder(root) {\n  if (!root) return [];\n  const out = [], q = [root];\n  while (q.length) {\n    const level = [], n = q.length;\n    for (let i = 0; i < n; i++) {\n      const node = q.shift();\n      level.push(node.val);\n      if (node.left) q.push(node.left);\n      if (node.right) q.push(node.right);\n    }\n    out.push(level);\n  }\n  return out;\n}`;
  if (/debounce|防抖/i.test(t))
    return `function debounce(fn, wait = 300) {\n  let timer = null;\n  return function (...args) {\n    clearTimeout(timer);\n    timer = setTimeout(() => fn.apply(this, args), wait);\n  };\n}`;
  return `function solve(input) {\n  // 按题面签名实现；此处给通用可运行的骨架\n  const map = new Map();\n  for (const [i, v] of input.entries()) {\n    if (map.has(v)) return [map.get(v), i];\n    map.set(v, i);\n  }\n  return [];\n}`;
}

/** 复盘报告（严格对齐 23 号文档 §9.2 schema：status + interviewSummary + relatedKnowledge + conversationAnalysis） */
export function buildReport({ session, messages, goal, resume }) {
  const userMsgs = messages.filter((m) => m.role === 'USER');
  const interviewer = messages.filter((m) => m.role === 'INTERVIEWER');
  const words = userMsgs.reduce((n, m) => n + m.content.length, 0);
  const rounds = Math.max(1, userMsgs.length);

  // 五维：文档样例名 + 本地打分规则（0-100）
  const base = 45 + Math.min(30, Math.round(words / 40)) + Math.min(10, rounds * 3);
  const dims = [
    ['项目经验与系统设计', base + 4],
    ['高并发与缓存存储', base - 2],
    ['分布式一致性', base - 4],
    ['基础原理深度', base - 8],
    ['沟通表达与问题响应', base + 2],
  ].map(([dimension, score]) => ({ dimension, score: Math.max(20, Math.min(100, Math.round(score))) }));

  // 逐段问答（按 interviewer 提问顺序配对 user 回答）
  const conversationAnalysis = interviewer.slice(0, 7).map((q, i) => {
    const a = userMsgs[i];
    const answer = a?.content || '（未作答）';
    const segScore = a ? Math.max(20, Math.min(95, 50 + Math.min(35, Math.round(answer.length / 12)))) : 20;
    return {
      topic: q.content.slice(0, 18),
      score: segScore,
      turns: [{ question: q.content, answer }],
      question: q.content,
      answer,
      evaluation: a
        ? `回答覆盖了问题要点（${answer.slice(0, 30)}…），${answer.length > 60 ? '信息量足够' : '篇幅偏短，细节与数据可以再补'}；面试官会认为你${segScore >= 70 ? '思路清楚' : '回答偏概括、需要追问才能落地'}。`
        : '这一轮没有作答，面试官会认为你在回避或没听懂问题。',
      suggestion: `示范答法：先给结论（一句话），再补 1-2 个具体事实（数字/技术选型），最后说取舍。例如「${q.content.slice(0, 12)}…这块我的结论是……，依据是……」。`,
    };
  });

  const strengths = [
    { strength: '开场信息密度高', reason: '自我介绍直接给方向、技术栈与量化结果，省去了面试官的引导成本。' },
    { strength: '技术选型有依据', reason: '回答里给出了方案对比与取舍，而不是只报工具名。' },
    { strength: '能回到结论', reason: '被追问时仍能收敛到一句话结论，说明对自己的方案有把握。' },
  ];
  const shortcomings = [
    { shortcoming: '量化数据不足', reason: '多数回答缺少延迟/QPS/错误率这类可验证指标。' },
    { shortcoming: '铺垫偏长', reason: '部分回答先铺背景再给结论，面试官容易走神。' },
    { shortcoming: '反问准备不足', reason: '末尾反问环节没有体现对团队目标的关注。' },
  ];
  const interviewSuggestions = [
    '每个回答第一句就是结论，第二句给依据，第三句给取舍。',
    '把项目结果换算成可验证指标：P99、QPS、错误率、成本。',
    '准备 2 个与团队目标相关的反问，避免问「公司文化」这类泛问题。',
    '被问到不会的技术时，先讲思路与验证方式，再承认边界。',
    '面试前用一句话写下岗位最想解决的问题，回答都往这上面靠。',
  ];

  const knowledge = [
    ['B+ 树索引与回表', '二级索引不覆盖列时会回主键索引再查一次；用覆盖索引消除。'],
    ['MVCC 与幻读', 'RR 下快照读靠 undo 版本链，当前读靠间隙锁防幻读。'],
    ['缓存一致性', '先更库再删缓存 + 延迟双删；强一致场景直接读库。'],
    ['分布式锁', 'Redis SETNX+续期有脑裂风险，ZK 临时节点更稳，DB 唯一索引最简。'],
    ['消息幂等', '唯一键去重表 + 状态机单向流转 + 消费端幂等。'],
    ['分库分表代价', '跨库事务、分页聚合、扩容与运维复杂度都会上升。'],
    ['限流算法', '计数器/滑动窗口/令牌桶/漏桶；分布式用 Redis+Lua 保证原子。'],
    ['Kafka 顺序性', '只在分区内保证；按业务键分区才能拿到局部顺序。'],
    ['连接池与慢查询', 'P99 抖动常来自连接池打满或未走索引，先看链路耗时再改代码。'],
    ['灰度与回滚', '按流量切流 + 指标看板 + 数据兼容，回滚脚本要预先演练。'],
    ['接口幂等设计', '幂等键 + 去重表 + 状态机，配合超时重试上限。'],
    ['TCP 与 HTTP/2', 'HTTP/2 解决应用层队头阻塞，TCP 丢包仍会拖慢连接。'],
    ['系统设计取舍', '先定 SLA 与口径，再选一致性/吞吐方案，最后谈成本。'],
  ].map(([knowledge, concept]) => ({ knowledge, concept }));

  const avg = Math.round(dims.reduce((n, d) => n + d.score, 0) / dims.length);

  return {
    status: 'success',
    sessionId: session.id,
    title: `${goal?.name || '面试'} · 复盘报告`,
    score: Math.max(0, Math.min(100, avg)), // 客户端自算总分（文档：总分不下发，这里附带便于列表展示）
    generatedAt: new Date().toISOString(),
    interviewSummary: {
      fiveDimensions: dims,
      interviewSummary: `本场共 ${rounds} 轮作答、累计 ${words} 字。整体${avg >= 75 ? '结构清楚、技术细节到位' : avg >= 60 ? '方向正确，但深度与量化不足' : '回答偏概括，需要补足事实与数据'}；建议按「结论 → 依据 → 取舍」重写每一轮回答。`,
      strengths,
      shortcomings,
      interviewSuggestions,
    },
    relatedKnowledge: knowledge,
    conversationAnalysis,
    resumeTitle: resume?.title || null,
  };
}
