/** 原版前端成品截图：node scripts/legacy-shot.mjs <port> <out.png> [path] */
import fs from 'node:fs';

const [, , port, out, path = '/legacy/', wait1 = '9000', wait2 = '3000'] = process.argv;
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
};
ws.onopen = async () => {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:8756' + path });
  await new Promise((r) => setTimeout(r, Number(wait1)));
  // 关掉使用须知弹窗（等倒计时结束点确认）
  await send('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('button')].filter(b => /我已|确认|同意|知道/.test(b.textContent)).forEach(b => { if (!b.disabled) b.click(); }); 'clicked'`,
    returnByValue: true,
  });
  await new Promise((r) => setTimeout(r, Number(wait2)));
  const info = await send('Runtime.evaluate', {
    expression: `JSON.stringify({text: (document.body.innerText||'').slice(0,120), title: document.title})`,
    returnByValue: true,
  });
  console.log(info.result.value);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('saved', out);
  ws.close();
  process.exit(0);
};
ws.onerror = (e) => { console.error('WS 错误', e.message || e); process.exit(1); };
