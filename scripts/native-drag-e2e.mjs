/**
 * 原生壳浮窗拖动 E2E：给 WebView2 开 CDP，真实鼠标事件拖 .ov-head，
 * 经 orangeNative.winRect 前后对比断言窗口位移（验证 IPC 移窗链路，浏览器 moveBy 在 WebView2 无效）。
 * 前置：exe 已构建；本地服务在跑（默认 8757）。
 * 运行：node scripts/native-drag-e2e.mjs [port=8757] [cdpPort=9790]
 */
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const PORT = process.argv[2] || process.env.ML_PORT || '8757';
const CDP = Number(process.argv[3] || 9790);
const exe = fileURLToPath(new URL('../.tools/target/debug/interview-orange.exe', import.meta.url));
if (!fs.existsSync(exe)) { console.error('未找到 exe，先跑 native/run.ps1 -Build -BuildOnly'); process.exit(1); }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (c, n, e = '') => results.push([c ? 'PASS' : 'FAIL', n, e]);

const child = spawn(exe, [], {
  detached: true, stdio: 'ignore',
  env: {
    ...process.env,
    ML_PORT: String(PORT),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP}`,
  },
});
child.unref();

const list = async () => (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json());
let targets = [];
for (let i = 0; i < 60 && targets.filter((t) => t.url.includes('#main') || t.url.includes('#overlay')).length < 2; i++) {
  await wait(500);
  try { targets = (await list()).filter((t) => t.type === 'page'); } catch { /* 等端口 */ }
}
check(targets.filter((t) => t.url.includes('8757') || t.url.includes('#')).length >= 2, '原生壳启动（main + overlay 双 webview）', `${targets.length} targets`);

let ovT = null;
for (let i = 0; i < 30 && !ovT; i++) {
  ovT = (await list()).find((t) => t.url.includes('#overlay'));
  if (!ovT) await wait(400);
}
check(Boolean(ovT), 'overlay webview 目标', ovT?.url);
if (!ovT) { console.log(results.map((r) => r.join(' ')).join('\n')); process.exit(1); }

const ws = new WebSocket(ovT.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  }
};
ws.onclose = () => pending.forEach((p) => p.reject(new Error('ws closed')));
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws err')); });
const send = (method, params = {}) => new Promise((res, rej) => {
  const m = ++id; pending.set(m, { resolve: res, reject: rej });
  ws.send(JSON.stringify({ id: m, method, params }));
});
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
};

/* 等 orangeNative shim 注入 + ov-head 渲染 */
let ready = false;
for (let i = 0; i < 30 && !ready; i++) {
  ready = await evalJs("Boolean(window.orangeNative && window.orangeNative.winRect && document.querySelector('.ov-head'))");
  if (!ready) await wait(400);
}
check(ready, 'orangeNative shim 注入 + ov-head 就绪');

const rect = async () => (await evalJs("window.orangeNative.winRect('overlay')")) || null;
const before = await rect();
check(Boolean(before), 'winRect 读取', JSON.stringify(before));

/* 真实鼠标拖动 .ov-head（CDP Input → pointerdown/move/up → startDrag → IPC winPosition） */
const FROM = { x: 160, y: 10 };
const TO = { x: 300, y: 140 };
const mouse = (type, x, y) =>
  send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1 });
await mouse('mousePressed', FROM.x, FROM.y);
for (let s = 1; s <= 12; s++) {
  await mouse('mouseMoved', FROM.x + ((TO.x - FROM.x) * s) / 12, FROM.y + ((TO.y - FROM.y) * s) / 12);
  await wait(40);
}
await mouse('mouseReleased', TO.x, TO.y);
await wait(800);

const after = await rect();
const dx = after ? after.x - before.x : 0;
const dy = after ? after.y - before.y : 0;
check(after && Math.abs(dx) > 60 && Math.abs(dy) > 60, '原生壳浮窗可拖动（IPC 移窗）',
  `(${before?.x},${before?.y}) → (${after?.x},${after?.y}) = Δ(${dx},${dy})`);

ws.close();
try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退出 */ }
console.log('');
for (const [st, n, e] of results) console.log(`[${st}] ${n}${e ? ' — ' + e : ''}`);
const bad = results.filter((r) => r[0] === 'FAIL');
console.log(`\n合计 ${results.length} 项，失败 ${bad.length} 项`);
process.exit(bad.length ? 1 : 0);
