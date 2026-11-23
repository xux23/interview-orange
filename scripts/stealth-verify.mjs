/** 隐蔽模块端到端验证：node scripts/stealth-verify.mjs <wsUrl> */
const [, , wsUrl] = process.argv;
const ws = new WebSocket(wsUrl);
let id = 0;
const p = new Map();
const send = (m, params = {}) => new Promise((res, rej) => { const i = ++id; p.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { const { res, rej } = p.get(m.id); p.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
ws.onopen = async () => {
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
  const title0 = await ev('document.title');
  const dis = await ev("window.orangeNative.disguiseTitle('记事本')");
  const title1 = await ev('document.title');
  console.log('disguise:', dis, '| title:', JSON.stringify(title0), '→', JSON.stringify(title1));
  const hidden = await ev('window.orangeNative.panic()');
  await new Promise((r) => setTimeout(r, 300));
  const stHidden = await ev('window.orangeNative.stealthState()');
  console.log('panic hidden:', hidden, '| state:', JSON.stringify(stHidden));
  const restored = await ev('window.orangeNative.panic()');
  console.log('panic restored (0 = all back):', restored);
  const back = await ev("window.orangeNative.disguiseTitle('面试橙 · 工作台')");
  console.log('title restored:', back);
  ws.close();
  process.exit(0);
};
ws.onerror = (e) => { console.error('WS err', e.message || e); process.exit(1); };
