/** CDP 调试任意页面：node scripts/cdp-nav.mjs <port> <url> <out.png> [waitMs]
 *  输出 console 消息 + DOM 概要 + 截图，用于诊断 /legacy 原版前端是否跑通。 */
import fs from 'node:fs';

const [, , port, url, out, waitMs = '9000'] = process.argv;
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) {
  console.error('no page target');
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
const logs = [];
const reqUrl = {};
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    const args = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    logs.push(`[console.${m.params.type}] ${args}`);
  } else if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    logs.push(`[exception] ${d.text} ${d.exception?.description || ''}`);
  } else if (m.method === 'Network.requestWillBeSent') {
    reqUrl[m.params.requestId] = m.params.request.url;
    logs.push(`[net→] ${m.params.request.method} ${m.params.request.url.slice(0, 160)}`);
  } else if (m.method === 'Network.loadingFailed') {
    logs.push(`[net✗] ${reqUrl[m.params.requestId] || m.params.requestId} — ${m.params.errorText}${m.params.blockedReason ? ' blocked=' + m.params.blockedReason : ''} type=${m.params.type || ''}`);
  } else if (m.method === 'Network.responseReceived') {
    logs.push(`[net←] ${m.params.response.status} ${m.params.response.url.slice(0, 120)}`);
  }
};

ws.onopen = async () => {
  try {
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Network.enable', { maxPostDataSize: 2048 });
    await send('Page.navigate', { url });
    // 轮询 token 变化，定位被清空的时刻
    let lastTok = '<unset>';
    for (let t = 0; t < Math.floor(Number(waitMs) / 400); t++) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const tok = await send('Runtime.evaluate', {
          expression: `localStorage.getItem('token')`,
          returnByValue: true,
        });
        const v = tok.result.value;
        if (v !== lastTok) {
          logs.push(`[tok@${(t * 0.4).toFixed(1)}s] ${v === null ? 'null' : JSON.stringify(String(v).slice(0, 50))}`);
          lastTok = v;
        }
      } catch { /* ignore */ }
    }
    const evalRes = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        readyState: document.readyState,
        rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : -1,
        rootText: (document.getElementById('root')?.innerText || '').slice(0, 300),
        hasInternals: '__TAURI_INTERNALS__' in window,
        apiBase: localStorage.getItem('custom_api_url'),
        token: (localStorage.getItem('token')||'').slice(0,12),
        title: document.title,
      })`,
      returnByValue: true,
    });
    console.log('[dom]', evalRes.result.value);
    for (const l of logs.slice(-150)) console.log(l);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('saved', out);
  } catch (e) {
    console.error('CDP 失败:', e.message);
    for (const l of logs.slice(-25)) console.log(l);
  }
  ws.close();
  process.exit(0);
};
ws.onerror = (e) => {
  console.error('WS 错误', e.message || e);
  process.exit(1);
};
