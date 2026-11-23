/**
 * LINE Webhook 入口（Cloudflare Workers，免費方案即可）
 * 1. 驗證 X-Line-Signature，確認真的是 LINE 送來的
 * 2. 立刻回 200 給 LINE（LINE 要求很快回應）
 * 3. 背景把原始內容轉給 Google Apps Script（附共用密鑰）
 *
 * 需要在 Cloudflare 設定的變數（Settings → Variables and Secrets，類型選 Secret）：
 *   LINE_CHANNEL_SECRET  LINE Developers → Messaging API 頻道的 Channel secret
 *   GAS_URL              Apps Script 網頁應用程式網址（…/exec）
 *   FORWARD_SECRET       Apps Script「設定金鑰」產生的轉送密鑰
 */

export async function verifyLineSignature(rawBody, signature, channelSecret) {
  if (!signature || !channelSecret) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(channelSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(rawBody)));
  let bin = '';
  for (const b of mac) bin += String.fromCharCode(b);
  const expected = btoa(bin);
  // 長度相同才逐字比對（固定時間比較）
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export async function forward(env, rawBody, fetchImpl = fetch) {
  const payload = JSON.stringify({ secret: String(env.FORWARD_SECRET || '').trim(), body: rawBody });
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Apps Script 收到 POST 後會先處理再回 302；處理已完成，不需要跟著轉址
      const res = await fetchImpl(String(env.GAS_URL || '').trim(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        redirect: 'manual'
      });
      if (res.status < 400) return true;
      lastErr = new Error('Apps Script 回應 ' + res.status);
    } catch (e) {
      lastErr = e;
    }
    await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
  }
  console.error('轉送失敗', lastErr && lastErr.message);
  return false;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/check') {
      // 只顯示有沒有設定，不顯示內容
      const has = k => (env[k] && String(env[k]).trim() ? '已設定' : '❌ 未設定');
      const lines = [
        'LINE_CHANNEL_SECRET：' + has('LINE_CHANNEL_SECRET') + (env.LINE_CHANNEL_SECRET ? '（長度 ' + String(env.LINE_CHANNEL_SECRET).trim().length + '，正常為 32）' : ''),
        'GAS_URL：' + has('GAS_URL') + (env.GAS_URL && !/\/exec\s*$/.test(env.GAS_URL) ? '（⚠ 結尾應為 /exec）' : ''),
        'FORWARD_SECRET：' + has('FORWARD_SECRET')
      ];
      return new Response(lines.join('\n'), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    if (request.method === 'GET') return new Response('ok');
    if (request.method !== 'POST' || url.pathname !== '/line') return new Response('not found', { status: 404 });

    const raw = await request.text();
    // 貼上時多出的空白或換行不影響驗證
    const ok = await verifyLineSignature(raw, request.headers.get('x-line-signature'), String(env.LINE_CHANNEL_SECRET || '').trim());
    if (!ok) return new Response('bad signature', { status: 401 });

    // LINE 後台按「驗證」時送的是空事件，直接回 200
    let events = [];
    try { events = JSON.parse(raw).events || []; } catch (e) { return new Response('bad json', { status: 400 }); }
    if (events.length) ctx.waitUntil(forward(env, raw));
    return new Response('ok');
  }
};
