/** CDP 截图：node scripts/cdp-shot.mjs <wsUrl> <out.png> [width] [height] */
import fs from 'node:fs';

const [, , wsUrl, out, w = '420', h = '640'] = process.argv;
if (!wsUrl) {
  console.error('用法: node scripts/cdp-shot.mjs ws://... out.png [w] [h]');
  process.exit(1);
}
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
};

ws.onopen = async () => {
  try {
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: Number(w), height: Number(h), deviceScaleFactor: 1, mobile: false,
    });
    await new Promise((r) => setTimeout(r, 600));
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    const info = await send('Runtime.evaluate', {
      expression: `JSON.stringify({w:innerWidth,h:innerHeight,bg:getComputedStyle(document.querySelector('.overlay-shell')||document.body).backgroundColor,shell:!!document.querySelector('.overlay-shell'),buttons:[...document.querySelectorAll('.ov-head .ov-btn')].map(b=>b.textContent.trim())})`,
      returnByValue: true,
    });
    console.log(info.result.value);
    console.log('saved', out);
    ws.close();
    process.exit(0);
  } catch (e) {
    console.error('CDP 失败:', e.message);
    process.exit(1);
  }
};
ws.onerror = (e) => { console.error('WS 错误', e.message || e); process.exit(1); };
