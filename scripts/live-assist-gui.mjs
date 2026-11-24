/**
 * 线上面试实时辅助 · GUI 全链路（真实浏览器 + 真实模型）：
 *   Edge 打开工作台 → 点击「真实面试辅助」→ 点「开启浮窗」（建 INTERVIEW 会话 + 弹浮窗）
 *   → 浮窗注入面试官问题 → ai.message 流式出卡（截图）
 *   → CDP 真实鼠标事件拖动浮窗标题栏 → 断言 window.screenX/Y 移动（截图）
 * 运行：node scripts/live-assist-gui.mjs [base=8757] [cdpPort=9778]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || `http://127.0.0.1:${process.env.ML_PORT || 8757}`;
const CDP = Number(process.argv[3] || 9778);
const SHOTS = path.resolve('shots/live-assist');
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const ok = (n, e = '') => results.push(['PASS', n, e]);
const fail = (n, e = '') => results.push(['FAIL', n, e]);
const check = (c, n, e = '') => (c ? ok : fail)(n, e);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── CDP 小客户端 ── */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const handlers = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      } else handlers.forEach((h) => h(m));
    };
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => {
        const mid = ++id; pending.set(mid, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id: mid, method, params }));
      }),
      on: (h) => handlers.push(h),
      close: () => ws.close(),
    });
    ws.onerror = () => reject(new Error('ws error'));
  });
}

const list = async () => (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json());

const evalJs = async (page, expression) => {
  const res = await page.send('Runtime.evaluate', { expression, returnByValue: true });
  return res?.result?.value;
};

/* ── 1) 起 Edge（独立 profile，测试完即杀） ── */
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.join(process.env.TEMP || '/tmp', `edge-gui-${Date.now()}`);
const child = spawn(edge, [
  `--remote-debugging-port=${CDP}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1100,800',
  `--app=${BASE}/#main`,
], { detached: true, stdio: 'ignore' });
child.unref();

let targets = [];
for (let i = 0; i < 40 && targets.length === 0; i++) {
  await wait(500);
  try { targets = (await list()).filter((t) => t.type === 'page'); } catch { /* 等端口 */ }
}
if (!targets.length) { console.error('FAIL: Edge CDP 端口未就绪'); process.exit(1); }
const mainTarget = targets.find((t) => t.url.startsWith(BASE)) || targets[0];
const main = await connect(mainTarget.webSocketDebuggerUrl);
await main.send('Page.enable');
await main.send('Runtime.enable');
ok('Edge 启动 + CDP 接入', mainTarget.url);

/* 真实鼠标点击（合成 JS click 无用户激活，window.open 弹窗会被拦） */
const realClick = async (page, selector, text, timeout = 15000) => {
  for (let i = 0; i < timeout / 250; i++) {
    const r = await evalJs(page, `(() => {
      const b = [...document.querySelectorAll('${selector}')].find(x => x.textContent.includes('${text}'));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    })()`);
    if (r) {
      const { x, y } = JSON.parse(r);
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
      return true;
    }
    await wait(250);
  }
  return false;
};

/* ── 2) 工作台 → 真实面试辅助 → 开启浮窗 ── */
const clickByText = async (page, selector, text, timeout = 15000) => {
  for (let i = 0; i < timeout / 250; i++) {
    const found = await evalJs(page, `(() => {
      const b = [...document.querySelectorAll('${selector}')].find(x => x.textContent.includes('${text}'));
      if (!b) return false; b.click(); return true;
    })()`);
    if (found) return true;
    await wait(250);
  }
  return false;
};
check(await clickByText(main, '.nav button', '真实面试辅助'), '点击「真实面试辅助」tab');
await wait(800);
const opened = await realClick(main, '.btn', '开启浮窗');
check(opened, '点击「开启浮窗」（建会话 + 弹浮窗）');
if (!opened) {
  console.log('诊断：', await evalJs(main, `JSON.stringify([...document.querySelectorAll('.btn')].map(b => b.textContent.trim()))`));
}
await wait(1500);

/* ── 3) 接入浮窗弹窗 ── */
let overlayTarget = null;
for (let i = 0; i < 30 && !overlayTarget; i++) {
  overlayTarget = (await list()).find((t) => t.type === 'page' && t.url.includes('#overlay'));
  if (!overlayTarget) await wait(400);
}
check(Boolean(overlayTarget), '浮窗弹窗已打开', overlayTarget?.url);
if (!overlayTarget) { console.log(results.map((r) => r.join(' ')).join('\n')); process.exit(1); }
const ov = await connect(overlayTarget.webSocketDebuggerUrl);
await ov.send('Page.enable');
await ov.send('Runtime.enable');

/* 等门禁激活（gate.active → 出现注入框） */
let gateActive = false;
for (let i = 0; i < 30 && !gateActive; i++) {
  gateActive = await evalJs(ov, `Boolean(document.querySelector('input[placeholder*="注入"]'))`);
  if (!gateActive) await wait(400);
}
check(gateActive, '浮窗门禁激活（seq 握手 + socket 连接）');

/* 截图 A：初始浮窗 */
let shot = await ov.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(SHOTS, '1-overlay-init.png'), Buffer.from(shot.data, 'base64'));

/* ── 4) 注入面试官问题 → 流式出卡 ── */
/* 注意：React state 异步 commit，设值后必须等一拍再点「问」，否则 handler 里 inject 仍是空串 */
await evalJs(ov, `(() => {
  const i = document.querySelector('input[placeholder*="注入"]');
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  set.call(i, '请介绍一下你在高并发场景下做过的一个最有挑战的项目');
  i.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await wait(400);
const injectSent = await evalJs(ov, `(() => {
  const btn = [...document.querySelectorAll('.ov-btn')].find((b) => b.textContent.trim() === '问');
  if (!btn) return 'no-btn';
  btn.click();
  return 'sent';
})()`);
check(injectSent === 'sent', '注入面试官问题（点击「问」）', String(injectSent));

/* 先等问题卡（stt.segment → 卡片），再等答案流式收尾 */
let questionOnCard = false;
for (let i = 0; i < 20 && !questionOnCard; i++) {
  questionOnCard = await evalJs(ov, `Boolean([...document.querySelectorAll('.ov-card .q')].some(q => q.textContent.includes('高并发')))`);
  if (!questionOnCard) await wait(500);
}
check(questionOnCard, '问题入卡（stt.segment → 浮窗卡片）');
let answerText = '';
for (let i = 0; i < 90; i++) {
  await wait(1000);
  answerText = await evalJs(ov, `(() => [...document.querySelectorAll('.ov-card .a')].map(x => x.textContent).join(''))()`) || '';
  if (answerText.includes('参考回答') && answerText.length > 120) break;
}
check(answerText.length > 120, '浮窗流式出卡', `${answerText.length} 字`);
check(/核心要点/.test(answerText) && /参考回答/.test(answerText), '卡片为双段协议答案', answerText.slice(0, 60));
if (answerText.length <= 120) {
  console.log('诊断 overlay：', await evalJs(ov, `JSON.stringify({cards: [...document.querySelectorAll('.ov-card')].map(c => c.innerText.slice(0, 80)), toast: document.body.innerText.slice(-200) })`));
}
shot = await ov.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(SHOTS, '2-overlay-answer.png'), Buffer.from(shot.data, 'base64'));

/* ── 5) 拖动浮窗（CDP 真实鼠标事件 → startDrag → moveBy/IPC） ── */
const before = await evalJs(ov, `JSON.stringify({x: window.screenX, y: window.screenY})`);
const p0 = JSON.parse(before || '{}');
const DRAG_FROM = { x: 160, y: 12 };
const DRAG_TO = { x: 320, y: 150 };
const mouse = (type, x, y, btn = 'left', clicks = 1) =>
  ov.send('Input.dispatchMouseEvent', { type, x, y, button: btn, clickCount: clicks, buttons: type === 'mouseUp' ? 0 : 1 });
await mouse('mousePressed', DRAG_FROM.x, DRAG_FROM.y);
for (let s = 1; s <= 12; s++) {
  await mouse('mouseMoved', DRAG_FROM.x + ((DRAG_TO.x - DRAG_FROM.x) * s) / 12, DRAG_FROM.y + ((DRAG_TO.y - DRAG_FROM.y) * s) / 12);
  await wait(30);
}
await mouse('mouseReleased', DRAG_TO.x, DRAG_TO.y);
await wait(600);
const after = await evalJs(ov, `JSON.stringify({x: window.screenX, y: window.screenY})`);
const p1 = JSON.parse(after || '{}');
const dx = (p1.x || 0) - (p0.x || 0);
const dy = (p1.y || 0) - (p0.y || 0);
check(Math.abs(dx) > 60 && Math.abs(dy) > 60, '浮窗可拖动（坐标位移）', `(${p0.x},${p0.y}) → (${p1.x},${p1.y}) = Δ(${dx},${dy})`);
shot = await ov.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(SHOTS, '3-overlay-dragged.png'), Buffer.from(shot.data, 'base64'));

/* ── 收尾 ── */
ov.close(); main.close();
const { execSync } = await import('node:child_process');
try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退出 */ }
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 占用时忽略 */ }

console.log('');
for (const [st, n, e] of results) console.log(`[${st}] ${n}${e ? ' — ' + e : ''}`);
const bad = results.filter((r) => r[0] === 'FAIL');
console.log(`\n合计 ${results.length} 项，失败 ${bad.length} 项；截图：${SHOTS}`);
process.exit(bad.length ? 1 : 0);
