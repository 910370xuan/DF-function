import test from 'node:test';
import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import worker, { verifyLineSignature, forward } from '../worker/index.js';

const SECRET = 'test-channel-secret';
const sign = body => createHmac('sha256', SECRET).update(body).digest('base64');
const body = JSON.stringify({ destination: 'U0', events: [{ type: 'message', webhookEventId: 'E1' }] });

test('簽章正確才通過', async () => {
  assert.strictEqual(await verifyLineSignature(body, sign(body), SECRET), true);
  assert.strictEqual(await verifyLineSignature(body + ' ', sign(body), SECRET), false);
  assert.strictEqual(await verifyLineSignature(body, '', SECRET), false);
  assert.strictEqual(await verifyLineSignature(body, sign(body), ''), false);
});

test('Worker：簽章錯誤回 401，正確回 200 並在背景轉送', async () => {
  const waits = [];
  const ctx = { waitUntil: p => waits.push(p) };
  const env = { LINE_CHANNEL_SECRET: SECRET, GAS_URL: 'https://example.invalid/exec', FORWARD_SECRET: 'f' };
  const bad = await worker.fetch(new Request('https://w/line', { method: 'POST', body, headers: { 'x-line-signature': 'x' } }), env, ctx);
  assert.strictEqual(bad.status, 401);

  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => { sent.push([url, JSON.parse(init.body)]); return new Response('', { status: 302 }); };
  try {
    const good = await worker.fetch(new Request('https://w/line', { method: 'POST', body, headers: { 'x-line-signature': sign(body) } }), env, ctx);
    assert.strictEqual(good.status, 200);
    await Promise.all(waits);
    assert.deepStrictEqual(sent, [['https://example.invalid/exec', { secret: 'f', body }]]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('LINE 後台「驗證」的空事件直接回 200、不轉送', async () => {
  const empty = JSON.stringify({ destination: 'U0', events: [] });
  const waits = [];
  const res = await worker.fetch(new Request('https://w/line', { method: 'POST', body: empty, headers: { 'x-line-signature': sign(empty) } }),
    { LINE_CHANNEL_SECRET: SECRET }, { waitUntil: p => waits.push(p) });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(waits.length, 0);
});

test('轉送失敗會重試', async () => {
  let n = 0;
  const ok = await forward({ GAS_URL: 'u', FORWARD_SECRET: 's' }, 'b', async () => { n++; return new Response('', { status: n < 2 ? 500 : 200 }); });
  assert.strictEqual(ok, true);
  assert.strictEqual(n, 2);
});

test('Channel secret 前後有空白也能驗證；/check 只顯示是否設定', async () => {
  const res = await worker.fetch(new Request('https://w/line', { method: 'POST', body: JSON.stringify({ events: [] }), headers: { 'x-line-signature': sign(JSON.stringify({ events: [] })) } }),
    { LINE_CHANNEL_SECRET: '  ' + SECRET + '\n' }, { waitUntil() {} });
  assert.strictEqual(res.status, 200);
  const chk = await (await worker.fetch(new Request('https://w/check'), { LINE_CHANNEL_SECRET: SECRET, GAS_URL: 'https://x/exec' }, {})).text();
  assert.match(chk, /LINE_CHANNEL_SECRET：已設定/);
  assert.match(chk, /FORWARD_SECRET：❌ 未設定/);
  assert.ok(!chk.includes(SECRET));
});
