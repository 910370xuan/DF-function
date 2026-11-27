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

test('微霖：統編發票 → 價格組合 D(稅外加)；中午後送不標記', () => {
  const r = p('好的~謝謝~那訂\n2000 x10\n4PIN 直流 x2\n需要開統編及發票，中午12點營業後送，謝謝', { today: '2026-11-05' });
  assert.deepStrictEqual(r.items, [{ product: 'GPB-2000', qty: 10, pin8: 0 }, { product: 'DCB-6000', qty: 2, pin8: 0 }]);
  assert.strictEqual(r.kind, 'order', r.reasons.join());
  assert.strictEqual(r.priceCombo, 'D(稅外加)');
  assert.ok(r.notes.includes('開發票'));
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

test('麒鎮：直流10+1 記下個月帳 → 附註，不用確認', () => {
  const r = p('直流10+1 記下個月帳');
  assert.deepStrictEqual(r.items, [{ product: 'DCB-6000', qty: 10, pin8: 0 }]);
  assert.strictEqual(r.kind, 'order', r.reasons.join());
  assert.deepStrictEqual(r.notes, ['記下個月帳']);
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

test('指定日期直接當出貨日', () => {
  const T = '2026-11-25'; // 週三
  const d = s => Parser.extractDate(Parser.normalize(s), T);
  assert.deepStrictEqual(d('下週一再送'), { date: '2026-11-30' });
  assert.deepStrictEqual(d('禮拜五出'), { date: '2026-11-27' });
  assert.deepStrictEqual(d('禮拜一出'), { date: '2026-11-30' }); // 已過 → 下週一
  assert.deepStrictEqual(d('明天幫我寄'), { date: '2026-11-26' });
  assert.deepStrictEqual(d('12/3 再出'), { date: '2026-12-03' });
  assert.deepStrictEqual(d('12月3號'), { date: '2026-12-03' });
  assert.deepStrictEqual(d('GPB-2000*3'), {});
  assert.deepStrictEqual(d('4/8pin 各一'), {});
  assert.strictEqual(d('月底再寄').ambiguous, true);
  assert.strictEqual(d('下週再寄').ambiguous, true);
  assert.deepStrictEqual(Parser.extractDate('1/5', '2026-12-20'), { date: '2027-01-05' });
  const r = p('GPB-2000*5 下週一再送', { today: T });
  assert.strictEqual(r.shipDate, '2026-11-30');
  assert.strictEqual(r.kind, 'order', r.reasons.join());
  const r2 = p('2026/11/20 GPB-2000*3', { today: '2026-11-12' });
  assert.strictEqual(r2.shipDate, '2026-11-20');
});

test('改單類型', () => {
  assert.strictEqual(p('剛剛那筆改成 GPB-2000*5').modification, 'replace');
  assert.strictEqual(p('再加 DCB-6000*2').modification, 'add');
  const c = p('剛剛那筆先取消');
  assert.strictEqual(c.modification, 'cancel');
  assert.strictEqual(c.kind, 'unclear');
  assert.strictEqual(p('GPB-2000*3').modification, '');
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

test('新帳號建議店家', () => {
  const v = ['格錸車業', '麒鎮車業行', '信耀車業(午後收貨)', '微霖科技有限公司', '倫勝電能車業', '基隆基金Gogoro社區店', '傑瑞電動車', '麥斯二輪'];
  assert.strictEqual(Parser.suggestVendor(['Jason 徐', '2026/11/12 Hi 高雄gogoro社區店-格錸車業 要訂貨'], v), '格錸車業');
  assert.strictEqual(Parser.suggestVendor(['麒鎮車業/吾小吳'], v), '麒鎮車業行');
  assert.strictEqual(Parser.suggestVendor(['信耀車業（午後）'], v), '信耀車業(午後收貨)');
  assert.strictEqual(Parser.suggestVendor(['Jerry Wang', '幫我出10+1'], v), '');
  assert.strictEqual(Parser.suggestVendor(['我是微霖'], v), '微霖科技有限公司');
});

test('最近 3 筆訂單', () => {
  const h = [1, 2, 3, 4].map(i => ({ store: 'A', product: 'GPB-2000', qty: i, date: '2026-11-0' + i }));
  assert.deepStrictEqual(Parser.recentFor('A', h, 3).map(x => x.qty), [4, 3, 2]);
});

test('歷史：店名括號不影響、優先電池型號；最常買型號', () => {
  const h = [
    { store: '信耀車業', product: '小電池工具組', qty: 3, date: '2026-11-10' },
    { store: '信耀車業', product: 'GBC-4000', qty: 1, date: '2026-11-09' },
    { store: '信耀車業', product: 'GPB-2000A', qty: 10, date: '2026-11-01' }
  ];
  const prefer = ['GPB-2000', 'GPB-2000A', 'GPB-2000S', 'DCB-6000'];
  assert.deepStrictEqual(Parser.suggestFromHistory('信耀車業(午後收貨)', h, null, prefer), { product: 'GPB-2000A', qty: 10, date: '2026-11-01' });
  assert.strictEqual(Parser.suggestFromHistory('信耀車業', h).product, 'GBC-4000');
  const table = { headers: ['DCB-6000', 'GBC-4000', 'GPB-2000', 'GPB-2000A'], rows: [['麒鎮車業行', 5, 40, 30, 2]] };
  assert.strictEqual(Parser.topProduct('麒鎮車業行', table, prefer), 'GPB-2000');
  assert.strictEqual(Parser.topProduct('麒鎮車業行', table), 'GBC-4000');
  assert.strictEqual(Parser.topProduct('別家', table, prefer), '');
});

test('新樣本：威利（打錯型號、中文數量、8pin 另訂、地址）', () => {
  const r = p('您好我要訂\nGPB-6000直流電力盒十顆、另外要多訂兩顆8pin的直流電力盒，送新北市中和區景平路319號1樓，謝謝', { today: '2026-11-25' });
  assert.deepStrictEqual(r.items, [{ product: 'DCB-6000', qty: 12, pin8: 2 }]);
  assert.strictEqual(r.kind, 'order', r.reasons.join());
  assert.strictEqual(r.shipDate, '');
});

test('新樣本：威利車業 DCB-6000x10、可樂 2000A*10+1 不須工具', () => {
  const a = p('您好，我要訂DCB-6000x10顆，寄至新北市新店區寶橋路199號1樓，謝謝', { today: '2026-10-01' });
  assert.deepStrictEqual(a.items, [{ product: 'DCB-6000', qty: 10, pin8: 0 }]);
  assert.strictEqual(a.kind, 'order', a.reasons.join());
  const b = p('你好,我們一店需要\n2000A*10+1\n不須工具\n\n可樂中興一店\n臺中市大里區中興路一段338號', { today: '2026-09-21' });
  assert.deepStrictEqual(b.items, [{ product: 'GPB-2000A', qty: 10, pin8: 0 }]);
  assert.deepStrictEqual(b.notes, ['不需工具']);
  assert.strictEqual(b.kind, 'order', b.reasons.join());
});

test('中文數字', () => {
  assert.deepStrictEqual(p('GPB-2000 二十顆').items, [{ product: 'GPB-2000', qty: 20, pin8: 0 }]);
  assert.deepStrictEqual(p('A款 十二個').items, [{ product: 'GPB-2000A', qty: 12, pin8: 0 }]);
  assert.deepStrictEqual(p('我要一組這個', { hasImage: true }).items, []);
});

test('金額不當成型號', () => {
  assert.strictEqual(p('已經匯了6000元給你').kind, 'not_order');
  assert.strictEqual(p('轉帳 $2000 謝謝').kind, 'not_order');
});

test('從地址或分店名判斷是哪家店', () => {
  const v = [
    { name: '威利電動機車-中和', address: '235新北市中和區景平路319號1樓' },
    { name: '威利電動機車-新店', address: '231 新北市新店區寶橋路199號1樓' },
    { name: '可樂中興一店', address: '412臺中市大里區中興路一段338號' },
    { name: '可樂中興二店', address: '412台中市大里區中興路二段599號' },
    { name: '格錸車業', address: '高雄市三民區民族一路100號' }
  ];
  assert.strictEqual(Parser.matchStore('GPB-6000直流電力盒十顆，送新北市中和區景平路319號1樓，謝謝', v), '威利電動機車-中和');
  assert.strictEqual(Parser.matchStore('DCB-6000x10顆，寄至新北市新店區寶橋路199號1樓', v), '威利電動機車-新店');
  assert.strictEqual(Parser.matchStore('我們二店需要 2000A*10+1 可樂中興二店 臺中市大里區中興路二段599號', v), '可樂中興二店');
  assert.strictEqual(Parser.matchStore('我們一店需要 可樂中興一店', v, ['可樂中興一店', '可樂中興二店']), '可樂中興一店');
  assert.strictEqual(Parser.matchStore('GPB-2000*3', v, ['可樂中興一店', '可樂中興二店']), '');
  assert.strictEqual(Parser.matchStore('高雄gogoro社區店-格錸車業', v), '格錸車業');
});

test('新客戶資料擷取與預設價格組合', () => {
  const a = Parser.extractContact('你好,我們一店需要\n2000A*10+1\n不須工具\n\n可樂中興一店\n臺中市大里區中興路一段338號');
  assert.strictEqual(a.storeName, '可樂中興一店');
  assert.strictEqual(a.address, '台中市大里區中興路一段338號');
  assert.strictEqual(a.district, '台中市大里區');
  const b = Parser.extractContact('新店家 速克達車業 統編 12345678 電話 0912-345-678 地址 235新北市中和區景平路319號1樓');
  assert.strictEqual(b.storeName, '速克達車業');
  assert.strictEqual(b.taxId, '12345678');
  assert.strictEqual(b.phone, '0912-345-678');
  assert.strictEqual(b.address, '235新北市中和區景平路319號1樓');
  assert.strictEqual(Parser.newCustomerCombo('2000A*10 不須工具', []), 'A');
  assert.strictEqual(Parser.newCustomerCombo('GPB-2000*10 工具*1', [{ product: '小電池工具組', qty: 1 }]), 'B');
  assert.strictEqual(Parser.newCustomerCombo('GPB-2000*10 不用工具 要開發票', []), 'D(稅外加)');
});
