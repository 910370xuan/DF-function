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

/**
 * 送一次空事件到 Apps Script，看回應判斷哪裡有問題（不會產生任何資料）。
 * Apps Script 會先回 302，跟著轉址才拿得到 doPost 的回應文字。
 */
export async function probeAppsScript(env, fetchImpl = fetch) {
  const url = String(env.GAS_URL || '').trim();
  if (!url) return '❌ GAS_URL 未設定';
  try {
    const res = await fetchImpl(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'follow',
      body: JSON.stringify({ secret: String(env.FORWARD_SECRET || '').trim(), body: JSON.stringify({ events: [] }) })
    });
    const text = (await res.text()).trim();
    if (text === 'ok') return '✅ Apps Script 正常（轉送密鑰正確）';
    if (text === 'forbidden') return '❌ 轉送密鑰不符：FORWARD_SECRET 與試算表「設定金鑰」顯示的不同';
    if (/accounts\.google\.com|ServiceLogin|登入|Sign in/i.test(text)) return '❌ Apps Script 部署的「誰可以存取」不是「所有人」，或網址不是最新部署';
    if (res.status === 404 || /找不到|not found|無法開啟/i.test(text)) return '❌ GAS_URL 網址錯誤或該部署已刪除（HTTP ' + res.status + '）';
    return '⚠ Apps Script 回應非預期（HTTP ' + res.status + '）：' + text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 120);
  } catch (e) {
    return '❌ 連不到 Apps Script：' + (e && e.message);
  }
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
      if (res.status < 400) { console.log('已轉送到 Apps Script（HTTP ' + res.status + '）'); return true; }
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
      lines.push('', '連線測試：' + await probeAppsScript(env));
      return new Response(lines.join('\n'), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    if (request.method === 'GET') return new Response('ok');
    if (request.method !== 'POST' || url.pathname !== '/line') return new Response('not found', { status: 404 });

    const raw = await request.text();
    // 貼上時多出的空白或換行不影響驗證
    const ok = await verifyLineSignature(raw, request.headers.get('x-line-signature'), String(env.LINE_CHANNEL_SECRET || '').trim());
    if (!ok) {
      console.warn('LINE 簽章驗證失敗：LINE_CHANNEL_SECRET 與 LINE Developers 的 Channel secret 不同');
      return new Response('bad signature', { status: 401 });
    }

    // LINE 後台按「驗證」時送的是空事件，直接回 200
    let events = [];
    try { events = JSON.parse(raw).events || []; } catch (e) { return new Response('bad json', { status: 400 }); }
    console.log('收到 LINE 事件 ' + events.length + ' 筆：' + events.map(e => e.type + (e.message ? '/' + e.message.type : '') + (e.source ? '/' + e.source.type : '')).join(', '));
    if (events.length) ctx.waitUntil(forward(env, raw));
    return new Response('ok');
  }
};
