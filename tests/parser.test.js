const test = require('node:test');
const assert = require('node:assert');
const Parser = require('../apps-script/Parser.js');

const p = (t, o) => Parser.parse(t, o);

test('格錸：20組4pin直流電力盒', () => {
  const r = p('2026/11/12\nHi\n高雄gogoro社區店-格錸車業\n要訂貨：\n20組4pin直流電力盒\n\n謝謝。', { today: '2026-11-12' });
  assert.deepStrictEqual(r.items, [{ product: 'DCB-6000', qty: 20, pin8: 0 }]);
  assert.strictEqual(r.kind, 'order', r.reasons.join());
});

test('基隆：GPB-2000*3 不需要工具 + DCB-6000*2', () => {
  const r = p('我需要\nGPB-2000 *3\n不需要工具\nDCB-6000 *2');
  assert.deepStrictEqual(r.items, [{ product: 'GPB-2000', qty: 3, pin8: 0 }, { product: 'DCB-6000', qty: 2, pin8: 0 }]);
  assert.deepStrictEqual(r.notes, ['不需工具']);
  assert.strictEqual(r.kind, 'order', r.reasons.join());
});

test('基隆：叫貨 + 感謝（合併的兩則）', () => {
  const r = p('我要叫貨\nGPB-2000 *3\n不需要工具\n感謝🥹');
  assert.deepStrictEqual(r.items, [{ product: 'GPB-2000', qty: 3, pin8: 0 }]);
  assert.strictEqual(r.kind, 'order');
});

test('信耀：GPB2000 10顆', () => {
  const r = p('您好我要叫貨 GPB2000 10顆');
  assert.deepStrictEqual(r.items, [{ product: 'GPB-2000', qty: 10, pin8: 0 }]);
  assert.strictEqual(r.kind, 'order');
});

test('倫勝：我要4個2000，不用工具', () => {
  const r = p('我要4個2000，不用工具');
  assert.deepStrictEqual(r.items, [{ product: 'GPB-2000', qty: 4, pin8: 0 }]);
  assert.strictEqual(r.kind, 'order', r.reasons.join());
});

test('麥斯：GPB-2000 *10 (不需工具) / DCB-6000 *2 (4pin)', () => {
  const r = p('GPB-2000 *10 (不需工具)\n\nDCB-6000 *2 (4pin)\n謝謝');
  assert.deepStrictEqual(r.items, [{ product: 'GPB-2000', qty: 10, pin8: 0 }, { product: 'DCB-6000', qty: 2, pin8: 0 }]);
  assert.strictEqual(r.kind, 'order', r.reasons.join());
});

test('麥斯：DCB-6000 換行 (4pin)*2 (8pin)*1', () => {
  const r = p('DCB-6000\n(4pin) *2\n （8pin) *1\n謝謝');
  assert.deepStrictEqual(r.items, [{ product: 'DCB-6000', qty: 3, pin8: 1 }]);
  assert.strictEqual(r.kind, 'order', r.reasons.join());
});

test('微霖：有統編發票與送貨時間 → 待確認', () => {
  const r = p('好的~謝謝~那訂\n2000 x10\n4PIN 直流 x2\n需要開統編及發票，中午12點營業後送，謝謝');
  assert.deepStrictEqual(r.items, [{ product: 'GPB-2000', qty: 10, pin8: 0 }, { product: 'DCB-6000', qty: 2, pin8: 0 }]);
  assert.strictEqual(r.kind, 'unclear');
  assert.ok(r.reasons.includes('要統編或發票'));
  assert.ok(r.reasons.includes('有指定時間或送貨要求'));
});

test('微霖：詢問句不算訂單', () => {
  const r = p('您好~請問小電池GPB-2000是不是有買10送1?');
  assert.strictEqual(r.kind, 'not_order');
});

test('傑瑞：幫我出10+1 / 要3付工具 → 查上一筆', () => {
  const r = p('幫我出10+1\n然後要3付工具');
  assert.strictEqual(r.kind, 'unclear');
  assert.deepStrictEqual(r.vague, { qty: 10 });
  assert.deepStrictEqual(r.items, [{ product: '小電池工具組', qty: 3, pin8: 0 }]);
});

test('麒鎮：小電10+1 → 查上一筆', () => {
  const r = p('小電10+1');
  assert.strictEqual(r.kind, 'unclear');
  assert.deepStrictEqual(r.vague, { qty: 10 });
});

test('麒鎮：直流10+1 記下個月帳', () => {
  const r = p('直流10+1 記下個月帳');
  assert.deepStrictEqual(r.items, [{ product: 'DCB-6000', qty: 10, pin8: 0 }]);
  assert.strictEqual(r.kind, 'unclear');
  assert.ok(r.reasons.includes('帳務備註'));
});

test('倫勝：圖片 + 我要一組這個', () => {
  const r = p('我要一組這個', { hasImage: true });
  assert.strictEqual(r.kind, 'unclear');
  assert.ok(r.reasons.includes('含圖片，需人工看圖'));
});

test('非訂單：謝謝、催貨、匯款', () => {
  assert.strictEqual(p('謝謝🙏').kind, 'not_order');
  assert.strictEqual(p('還沒收到貨耶').kind, 'not_order');
  assert.strictEqual(p('我用Richart轉新台幣$5652元給你囉(812, 帳號末五碼05595)').kind, 'not_order');
});

test('其他別名', () => {
  assert.deepStrictEqual(p('A款 x5').items, [{ product: 'GPB-2000A', qty: 5, pin8: 0 }]);
  assert.deepStrictEqual(p('S款*2').items, [{ product: 'GPB-2000S', qty: 2, pin8: 0 }]);
  assert.deepStrictEqual(p('方形小電池 3顆').items, [{ product: 'GPB-3600', qty: 3, pin8: 0 }]);
  assert.deepStrictEqual(p('飛絡力 1台').items, [{ product: 'Lite數位', qty: 1, pin8: 0 }]);
  assert.deepStrictEqual(p('AL-1800*1').items, [{ product: 'Lite類比', qty: 1, pin8: 0 }]);
  assert.deepStrictEqual(p('8pin直流 x4').items, [{ product: 'DCB-6000', qty: 4, pin8: 4 }]);
  assert.deepStrictEqual(p('ＧＰＢ－２０００Ａ　＊３').items, [{ product: 'GPB-2000A', qty: 3, pin8: 0 }]);
});

test('訊息裡的日期若不是今天 → 視為指定日期', () => {
  const r = p('2026/11/20 GPB-2000*3', { today: '2026-11-12' });
  assert.ok(r.reasons.includes('有指定日期'));
});

test('DCB pin 註記在數量後面', () => {
  assert.deepStrictEqual(p('DCB-6000 *2 (8pin)').items, [{ product: 'DCB-6000', qty: 2, pin8: 2 }]);
});

test('有型號沒數量 → 待確認', () => {
  const r = p('我要GPB-2000');
  assert.strictEqual(r.kind, 'unclear');
  assert.ok(r.reasons.some(x => x.includes('沒有數量')));
});

test('上一筆訂單建議', () => {
  const hist = [
    { store: '傑瑞電動車', product: 'T27五角批頭', qty: 3, date: '2026-11-10' },
    { store: '傑瑞電動車', product: 'GPB-2000', qty: 10, date: '2026-11-08' },
    { store: '傑瑞電動車', product: 'DCB-6000', qty: 5, date: '2026-10-01' },
    { store: '別家', product: 'GPB-3600', qty: 1, date: '2026-11-15' }
  ];
  assert.deepStrictEqual(Parser.suggestFromHistory('傑瑞電動車', hist), { product: 'GPB-2000', qty: 10, date: '2026-11-08' });
  assert.strictEqual(Parser.suggestFromHistory('沒來過', hist), null);
});

test('工具 = 小電池工具組；不需工具只是備註', () => {
  assert.deepStrictEqual(p('GPB-2000*10 工具x2').items, [{ product: 'GPB-2000', qty: 10, pin8: 0 }, { product: '小電池工具組', qty: 2, pin8: 0 }]);
  const r = p('GPB-2000 *3 不需要小電池工具組');
  assert.deepStrictEqual(r.items, [{ product: 'GPB-2000', qty: 3, pin8: 0 }]);
  assert.deepStrictEqual(r.notes, ['不需工具']);
  assert.strictEqual(r.kind, 'order');
});

test('DCB 沒寫 pin → 預設 4pin', () => {
  const r = p('DCB-6000 *2');
  assert.deepStrictEqual(r.items, [{ product: 'DCB-6000', qty: 2, pin8: 0 }]);
  assert.strictEqual(r.kind, 'order');
});
