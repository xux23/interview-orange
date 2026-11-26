/**
 * P0/P1 专项验收：验证 6 处原本的替身/缺口已接真实模型。
 *   P0 questionPrediction.generate
 *   P1 overlay.suggestPalette（视觉）/ tools.stt.stt（ASR）/ hotWords.ensureGoalHotWords /
 *      goal.suggestFromResume / material.generateEntries
 * 运行：node scripts/p0p1-verify.mjs   （provider=openai 才有效）
 */
import fs from 'node:fs';
import { trpcHeaders } from './lib/local-auth.mjs';

const BASE = process.env.ML_BASE || 'http://127.0.0.1:8756';
const results = [];
const ok = (n, e = '') => { results.push(['PASS', n]); console.log(`[PASS] ${n}${e ? ' — ' + e : ''}`); };
const fail = (n, e = '') => { results.push(['FAIL', n]); console.log(`[FAIL] ${n}${e ? ' — ' + e : ''}`); };

async function call(name, kind, input, token) {
  const url = kind === 'query'
    ? `${BASE}/trpc/${name}?input=${encodeURIComponent(JSON.stringify({ json: input || {} }))}`
    : `${BASE}/trpc/${name}`;
  const res = await fetch(url, {
    method: kind === 'query' ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...trpcHeaders(), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: kind === 'query' ? undefined : JSON.stringify({ json: input || {} }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${name}: ${json.error.json?.message}`);
  return json.result.data.json;
}

const health = await (await fetch(`${BASE}/healthz`)).json();
console.log(`provider=${health.provider} model=${health.model || '-'} asr=${health.asr}`);
if (health.provider !== 'openai') { console.log('SKIP：需要 provider=openai'); process.exit(0); }

const temp = await call('user.getTempToken', 'mutation', {});
const token = (await call('user.loginByTempToken', 'mutation', { token: temp.token })).token;
const resumes = await call('resume.getResumes', 'query', {}, token);
const goals = await call('goal.getGoals', 'query', {}, token);
const resumeId = resumes[0]?.id, goalId = goals[0]?.id;

/* ── P0 押题生成 ── */
{
  const t0 = Date.now();
  const r = await call('questionPrediction.generate', 'mutation', { goalId, resumeId, count: 6 }, token);
  const ms = Date.now() - t0;
  console.log(`  来源=${r.source} 共${r.items.length}题 ${ms}ms`);
  r.items.slice(0, 3).forEach((it, i) => console.log(`   ${i + 1}. [${(it.probability * 100).toFixed(0)}%] ${it.title}\n      解析：${String(it.reference).slice(0, 70)}…`));
  const good = r.items.length >= 4 && r.items.every((i) => i.title && i.title.length > 6) && r.source === 'model';
  good ? ok('P0 questionPrediction.generate', `${r.items.length}题 全模型生成`) : fail('P0 questionPrediction.generate', `source=${r.source} n=${r.items.length}`);
}

/* ── P1-a 视觉配色 ── */
{
  // 用一张纯色 BMP 模拟桌面截图
  const W = 160, H = 120, bpp = 24;
  const stride = Math.floor((W * bpp / 8 + 3) / 4) * 4;
  const bmp = Buffer.alloc(54 + stride * H);
  bmp.write('BM', 0); bmp.writeUInt32LE(54 + stride * H, 2); bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(W, 18); bmp.writeInt32LE(H, 22);
  bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = 54 + y * stride + x * 3;
    bmp[p] = 40; bmp[p + 1] = 90; bmp[p + 2] = 150; // BGR: 深蓝底
  }
  const t0 = Date.now();
  const r = await call('overlay.suggestPalette', 'mutation', {
    image: `data:image/bmp;base64,${bmp.toString('base64')}`, mode: 'dualCamera', current: {},
  }, token);
  console.log(`  source=${r.source} bg=${r.paletteBg} fg=${r.paletteFg} opacity=${r.bgOpacity} theme=${r.theme} ${Date.now() - t0}ms`);
  r.source === 'vision' && /^#[0-9a-f]{6}$/i.test(r.paletteBg)
    ? ok('P1 overlay.suggestPalette', `视觉模型出配色 ${r.paletteBg}/${r.paletteFg}`)
    : fail('P1 overlay.suggestPalette', `source=${r.source}`);
}

/* ── P1-b tools.stt.stt 真转写 ── */
{
  const wav = fs.readFileSync(new URL('./fixtures/asr-zh.wav', import.meta.url));
  const r = await call('tools.stt.stt', 'mutation', { audioBase64: wav.toString('base64') }, token);
  console.log(`  source=${r.source} text=「${r.text}」`);
  r.source === 'asr' && r.text.length > 5
    ? ok('P1 tools.stt.stt', `真转写：「${r.text.slice(0, 30)}」`)
    : fail('P1 tools.stt.stt', `source=${r.source}`);
}

/* ── P1-c 热词抽取 ── */
{
  // 清空缓存，强制走模型抽取
  await call('hotWords.updateGoalHotWords', 'mutation', { goalId, hotWordIds: [], customHotWords: [] }, token);
  const t0 = Date.now();
  const r = await call('hotWords.ensureGoalHotWords', 'mutation', { goalId }, token);
  console.log(`  source=${r.source} 类别=${JSON.stringify(r.hotWords || [])} 术语=${r.customHotWords.length}个 ${Date.now() - t0}ms`);
  console.log(`  术语：${r.customHotWords.slice(0, 12).join('、')}`);
  r.source === 'model' && r.customHotWords.length >= 8
    ? ok('P1 hotWords.ensureGoalHotWords', `${r.customHotWords.length} 术语由模型抽取`)
    : fail('P1 hotWords.ensureGoalHotWords', `source=${r.source} n=${r.customHotWords.length}`);
}

/* ── P1-d 岗位推荐 ── */
{
  const r = await call('goal.suggestFromResume', 'mutation', { resumeId }, token);
  console.log(`  source=${r.source} ${r.suggestions.length}条`);
  r.suggestions.forEach((s) => console.log(`   · ${s.name} @ ${s.companyName} — ${String(s.description).slice(0, 50)}…`));
  r.source === 'model' && r.suggestions.length === 3
    ? ok('P1 goal.suggestFromResume', '3 条模型推荐')
    : fail('P1 goal.suggestFromResume', `source=${r.source}`);
}

/* ── P1-e 资料问答对生成 ── */
{
  const mats = await call('material.getMaterials', 'query', {}, token);
  let mid = mats[0]?.id;
  if (!mid) {
    const m = await call('material.saveMaterial', 'mutation', { name: 'P0P1验收资料' }, token);
    mid = m.id;
    await call('material.saveEntry', 'mutation', {
      materialId: mid, question: '背景',
      answer: '我在电商平台负责订单链路，用 MySQL + Redis + Kafka 做过秒杀与库存扣减，P99 从 320ms 降到 110ms，QPS 峰值 1.2 万。',
    }, token);
  }
  const r = await call('material.generateEntries', 'mutation', { materialId: mid }, token);
  console.log(`  source=${r.source} ${r.entries.length}组`);
  r.entries.slice(0, 2).forEach((e) => console.log(`   Q: ${e.question}\n   A: ${String(e.answer).slice(0, 70)}…`));
  r.source === 'model' && r.entries.length >= 3
    ? ok('P1 material.generateEntries', `${r.entries.length} 组由模型生成`)
    : fail('P1 material.generateEntries', `source=${r.source} n=${r.entries.length}`);
}

const fails = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n合计 ${results.length} 项，失败 ${fails} 项`);
process.exit(fails ? 1 : 0);
