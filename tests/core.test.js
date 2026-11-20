const test = require('node:test');
const assert = require('node:assert');
const Core = require('../apps-script/Core.js');

test('單據編號：與現行編號一致', () => {
  assert.strictEqual(Core.formatOrderNo('2026-11-17', 47), '20BF11000000047');
  assert.strictEqual(Core.formatOrderNo('2026-10-22', 85), '20BF10000000085');
  assert.strictEqual(Core.formatOrderNo('2027-01-04', 1), '20BG01000000001');
});

test('單據編號：同月遞增、跨月與跨年歸零', () => {
  let r = Core.nextOrderNo({ month: '2026-11', last: 47 }, '2026-11-17');
  assert.strictEqual(r.orderNo, '20BF11000000048');
  r = Core.nextOrderNo(r.state, '2026-12-01');
  assert.strictEqual(r.orderNo, '20BF12000000001');
  r = Core.nextOrderNo({ month: '2026-12', last: 99 }, '2027-01-04');
  assert.strictEqual(r.orderNo, '20BG01000000001');
  assert.deepStrictEqual(r.state, { month: '2027-01', last: 1 });
});

test('10+1：每 10 送 1，不跨品項', () => {
  const el = ['GPB-2000', 'DCB-6000'];
  assert.strictEqual(Core.buildNote({ product: 'GPB-2000', qty: 10 }, el), '10+1');
  assert.strictEqual(Core.buildNote({ product: 'GPB-2000', qty: 25 }, el), '25+2');
  assert.strictEqual(Core.buildNote({ product: 'GPB-2000', qty: 9 }, el), '');
  assert.strictEqual(Core.buildNote({ product: 'DCB-6000', qty: 10, pin8: 2 }, el), '10+1/8P*2');
  assert.strictEqual(Core.buildNote({ product: 'DCB-6000', qty: 3, pin8: 1, note: '午後收貨' }, el), '8P*1/午後收貨');
  assert.strictEqual(Core.buildNote({ product: 'T27五角批頭', qty: 10 }, el), '');
});

const opts = {
  today: '2026-11-17',
  vendors: ['格錸車業', '麥斯二輪', '微霖科技有限公司', '微霖科技有限公司'],
  products: ['GPB-2000', 'DCB-6000'],
  eligible: ['GPB-2000', 'DCB-6000']
};

test('分組：每店一張、只取待出貨且出貨日 <= 今天', () => {
  const rows = [
    { id: 'a', shipDate: '2026-11-17', store: '格錸車業', product: 'DCB-6000', qty: 20, status: '待出貨' },
    { id: 'b', shipDate: '2026-11-16', store: '麥斯二輪', product: 'DCB-6000', qty: 3, pin8: 1, status: '待出貨' },
    { id: 'c', shipDate: '2026-11-17', store: '格錸車業', product: 'GPB-2000', qty: 4, status: '待出貨' },
    { id: 'd', shipDate: '2026-11-18', store: '麥斯二輪', product: 'GPB-2000', qty: 4, status: '待出貨' },
    { id: 'e', shipDate: '2026-11-17', store: '麥斯二輪', product: 'GPB-2000', qty: 4, status: '已手打' },
    { id: 'f', shipDate: '2026-11-17', store: '微霖科技有限公司', product: 'GPB-2000', qty: 10, status: '待出貨' }
  ];
  const { groups, errors } = Core.buildGroups(rows, opts);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(groups.map(g => g.store), ['格錸車業', '麥斯二輪', '微霖科技有限公司']);
  assert.deepStrictEqual(groups[0].lines, [
    { product: 'DCB-6000', qty: 20, note: '20+2' },
    { product: 'GPB-2000', qty: 4, note: '' }
  ]);
  assert.deepStrictEqual(groups[1].lines[0].note, '8P*1');
  assert.strictEqual(groups[2].duplicateVendor, true);
});

test('分組：資料有誤不得默默填入', () => {
  const rows = [
    { id: 'a', shipDate: '2026-11-17', store: '不存在', product: 'GPB-2000', qty: 1, status: '待出貨' },
    { id: 'b', shipDate: '2026-11-17', store: '格錸車業', product: '小電池', qty: 1, status: '待出貨' },
    { id: 'c', shipDate: '2026-11-17', store: '格錸車業', product: 'GPB-2000', qty: 1.5, status: '待出貨' },
    { id: 'd', shipDate: '2026-11-17', store: '格錸車業', product: 'DCB-6000', qty: 2, pin8: 3, status: '待出貨' }
  ];
  const { groups, errors } = Core.buildGroups(rows, opts);
  assert.strictEqual(groups.length, 0);
  assert.deepStrictEqual(errors.map(e => e.rowId), ['a', 'b', 'c', 'd']);
});

test('同一天出貨：同店同型號合併後計算 10+1', () => {
  const rows = [
    { id: 'a', shipDate: '2026-11-16', store: '格錸車業', product: 'GPB-2000', qty: 6, status: '待出貨' },
    { id: 'b', shipDate: '2026-11-17', store: '格錸車業', product: 'DCB-6000', qty: 7, pin8: 1, status: '待出貨' },
    { id: 'c', shipDate: '2026-11-17', store: '格錸車業', product: 'GPB-2000', qty: 4, note: '不需工具', status: '待出貨' },
    { id: 'd', shipDate: '2026-11-17', store: '格錸車業', product: 'DCB-6000', qty: 3, pin8: 1, status: '待出貨' },
    { id: 'e', shipDate: '2026-11-17', store: '麥斯二輪', product: 'GPB-2000', qty: 4, status: '待出貨' }
  ];
  const { groups, errors } = Core.buildGroups(rows, opts);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(groups[0].rowIds, ['a', 'b', 'c', 'd']);
  assert.deepStrictEqual(groups[0].lines, [
    { product: 'GPB-2000', qty: 10, note: '10+1/不需工具' },
    { product: 'DCB-6000', qty: 10, note: '10+1/8P*2' }
  ]);
  assert.deepStrictEqual(groups[1].lines, [{ product: 'GPB-2000', qty: 4, note: '' }]);
});

test('分組：合併後仍超過 7 行才退回', () => {
  const same = Array.from({ length: 8 }, (_, i) => ({
    id: 's' + i, shipDate: '2026-11-17', store: '麥斯二輪', product: 'GPB-2000', qty: 1, status: '待出貨'
  }));
  const r = Core.buildGroups(same, opts);
  assert.strictEqual(r.errors.length, 0);
  assert.deepStrictEqual(r.groups[0].lines, [{ product: 'GPB-2000', qty: 8, note: '' }]);
});

test('分組：超過 7 行整張退回', () => {
  const products = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'];
  const rows = products.map((p, i) => ({
    id: 'r' + i, shipDate: '2026-11-17', store: '格錸車業', product: p, qty: 1, status: '待出貨'
  }));
  const { groups, errors } = Core.buildGroups(rows, { ...opts, products });
  assert.strictEqual(groups.length, 0);
  assert.strictEqual(errors.length, 8);
});

test('貨運單：8 家 → 6 + 2，頁數 3+3+2', () => {
  const stores = ['1', '2', '3', '4', '5', '6', '7', '8'];
  const chunks = Core.chunkLabels(stores);
  assert.deepStrictEqual(chunks.map(c => c.length), [6, 2]);
  assert.deepStrictEqual(chunks.map(c => Core.labelPagesFor(c.length)), [2, 1]);
});

test('出貨日：週末、假日不出貨', () => {
  assert.strictEqual(Core.isShippingDay('2026-11-17', []), true); // 週二
  assert.strictEqual(Core.isShippingDay('2026-11-15', []), false); // 週日
  assert.strictEqual(Core.isShippingDay('2026-11-14', []), false); // 週六
  assert.strictEqual(Core.isShippingDay('2026-11-14', [], true), true);
  assert.strictEqual(Core.isShippingDay('2026-11-17', ['2026-11-17']), false);
});

test('批次編號與補單簽章', () => {
  assert.strictEqual(Core.nextBatchId('2026-11-17', []), '20261117-01');
  assert.strictEqual(Core.nextBatchId('2026-11-17', ['20261116-03', '20261117-01']), '20261117-02');
  assert.strictEqual(Core.pendingSignature(['b', 'a']), Core.pendingSignature(['a', 'b']));
  assert.deepStrictEqual(Core.parseRowRange('36-70'), { start: 36, end: 70 });
  assert.throws(() => Core.parseRowRange('70-36'));
});

test('文字日期正規化', () => {
  assert.strictEqual(Core.normalizeDate('2026/11/17'), '2026-11-17');
  assert.strictEqual(Core.normalizeDate('2026-1-5'), '2026-01-05');
  assert.strictEqual(Core.normalizeDate(' 115/11/17 '), '2026-11-17');
  assert.strictEqual(Core.normalizeDate('11/17'), '');
  assert.strictEqual(Core.normalizeDate(''), '');
});

test('診斷：說明為何沒有產單', () => {
  const rows = [
    { store: 'A', product: 'GPB-2000', qty: 1, status: '待出貨', shipDate: '2026-11-18' },
    { store: 'A', product: 'GPB-2000', qty: 1, status: '待出貨', shipDate: '' },
    { store: 'A', product: 'GPB-2000', qty: 1, status: '已產單', shipDate: '2026-11-17' },
    { store: '', product: '', qty: '', status: '', shipDate: '' }
  ];
  const d = Core.diagnose(rows, '2026-11-17');
  assert.strictEqual(d.total, 3);
  assert.strictEqual(d.noDate, 1);
  assert.deepStrictEqual(d.future, ['2026-11-18']);
  const text = Core.describeDiagnosis(d, '2026-11-17');
  assert.match(text, /讀到 3 筆/);
  assert.match(text, /已產單 1 筆/);
  assert.match(Core.describeDiagnosis(Core.diagnose([], 'x'), 'x'), /沒有讀到任何訂單列/);
});

test('折讓／已收金額：同店加總、格式錯誤退回', () => {
  const rows = [
    { id: 'a', shipDate: '2026-11-17', store: '格錸車業', product: 'GPB-2000', qty: 10, discount: '1,000', status: '待出貨' },
    { id: 'b', shipDate: '2026-11-17', store: '格錸車業', product: 'DCB-6000', qty: 2, discount: 200, paid: 7200, status: '待出貨' },
    { id: 'c', shipDate: '2026-11-17', store: '麥斯二輪', product: 'GPB-2000', qty: 1, status: '待出貨' },
    { id: 'd', shipDate: '2026-11-17', store: '微霖科技有限公司', product: 'GPB-2000', qty: 1, paid: '五百', status: '待出貨' },
    { id: 'e', shipDate: '2026-11-17', store: '微霖科技有限公司', product: 'GPB-2000', qty: 1, discount: -5, status: '待出貨' }
  ];
  const { groups, errors } = Core.buildGroups(rows, opts);
  assert.deepStrictEqual(groups.map(g => [g.store, g.discount, g.paid]), [['格錸車業', 1200, 7200], ['麥斯二輪', 0, 0]]);
  assert.deepStrictEqual(errors.map(e => e.rowId), ['d', 'e']);
});

test('推定出貨日：16:00 前當天、之後下一個出貨日、週末與假日順延', () => {
  const o = { cutoff: '16:00', nearMinutes: 30, holidays: ['2026-11-23'] };
  assert.deepStrictEqual(Core.inferShipDate('2026-11-17', '13:10', o), { date: '2026-11-17', nearCutoff: false });
  assert.deepStrictEqual(Core.inferShipDate('2026-11-17', '15:40', o), { date: '2026-11-17', nearCutoff: true });
  assert.deepStrictEqual(Core.inferShipDate('2026-11-17', '16:00', o), { date: '2026-11-18', nearCutoff: false });
  assert.deepStrictEqual(Core.inferShipDate('2026-11-20', '17:43', o), { date: '2026-11-24', nearCutoff: false }); // 週五晚上 → 週一是假日 → 週二
  assert.deepStrictEqual(Core.inferShipDate('2026-11-15', '16:14', o), { date: '2026-11-16', nearCutoff: false }); // 週日
  assert.deepStrictEqual(Core.inferShipDate('2026-11-14', '10:00', { ...o, shipSaturday: true }), { date: '2026-11-14', nearCutoff: false });
  assert.strictEqual(Core.addDays('2026-12-31', 1), '2027-01-01');
});

test('合併對話：安靜 10 分鐘才送出，強制時全部送出', () => {
  const m = [
    { userId: 'A', ts: 0, text: '我要叫貨' },
    { userId: 'B', ts: 5 * 60e3, text: 'GPB-2000*3' },
    { userId: 'A', ts: 2 * 60e3, text: 'GPB-2000*3' }
  ];
  const now = 13 * 60e3;
  const ready = Core.readySegments(m, now, 10 * 60e3, false);
  assert.deepStrictEqual(ready.map(r => [r.userId, r.msgs.map(x => x.text)]), [['A', ['我要叫貨', 'GPB-2000*3']]]);
  assert.strictEqual(Core.readySegments(m, now, 10 * 60e3, true).length, 2);
});
