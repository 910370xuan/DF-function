const test = require('node:test');
const assert = require('node:assert');
const Xlsx = require('../apps-script/Xlsx.js');

// 取自 Google 匯出的真實 xlsx 結構（簡化）
const STYLES = '<styleSheet><numFmts count="0"/><fonts count="3">' +
  '<font><sz val="10.0"/><color rgb="FF000000"/><name val="Arial"/><scheme val="minor"/></font>' +
  '<font><b/><sz val="14.0"/><color theme="1"/><name val="Arial"/><scheme val="minor"/></font>' +
  '<font/></fonts><fills count="1"><fill/></fills><cellXfs><xf fontId="0"/></cellXfs></styleSheet>';

const SHEET = '<worksheet xmlns="x" xmlns:r="r"><sheetPr><pageSetUpPr/></sheetPr><sheetData><row r="1"/></sheetData>' +
  '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells><dataValidations/>' +
  '<printOptions horizontalCentered="1"/><pageMargins bottom="0.75" footer="0.0" header="0.0" left="0.7" right="0.7" top="0.75"/>' +
  '<pageSetup paperSize="9" orientation="portrait" pageOrder="overThenDown"/>' +
  '<rowBreaks count="1" manualBreakCount="1"><brk id="57" man="1" max="16383"/></rowBreaks><drawing r:id="rId1"/></worksheet>';

test('字型全部改成微軟正黑體、移除佈景主題字型', () => {
  const out = Xlsx.patchStyles(STYLES, '微軟正黑體', false);
  assert.strictEqual((out.match(/<name val="微軟正黑體"\/>/g) || []).length, 3);
  assert.ok(!out.includes('Arial'));
  assert.ok(!out.includes('<scheme'));
  assert.ok(out.includes('<b/><sz val="14.0"/>'));
  assert.ok(out.includes('<fills count="1">')); // 其他區塊不動
});

test('全部加粗（貨運單）', () => {
  const out = Xlsx.patchStyles(STYLES, '微軟正黑體', true);
  const fonts = out.match(/<font\b[\s\S]*?<\/font>/g);
  assert.strictEqual(fonts.length, 3);
  fonts.forEach(f => assert.strictEqual((f.match(/<b\/>/g) || []).length, 1, f));
});

test('工作表：縮放 68%、移除分頁符號，元素順序正確', () => {
  const out = Xlsx.patchSheet(SHEET, { scale: 68 });
  assert.ok(out.includes('<pageSetup paperSize="9" scale="68" orientation="portrait"'));
  assert.ok(out.includes('<pageSetUpPr fitToPage="0"/>'));
  assert.ok(!out.includes('rowBreaks'));
  assert.strictEqual((out.match(/<pageSetup /g) || []).length, 1);
  const order = ['</dataValidations>', '<dataValidations/>', '<printOptions', '<pageMargins', '<pageSetup', '<drawing']
    .map(t => out.indexOf(t)).filter(i => i >= 0);
  assert.deepStrictEqual(order, order.slice().sort((a, b) => a - b));
});

test('沒有任何列印設定的工作表也能插入', () => {
  const out = Xlsx.patchSheet('<worksheet><sheetData/></worksheet>', { scale: 68 });
  assert.ok(/<sheetData\/><printOptions horizontalCentered="1"\/><pageMargins [^>]+\/><pageSetup [^>]+\/><\/worksheet>$/.test(out));
});

test('rich text 字型與加粗', () => {
  const ss = '<sst><si><r><rPr><rFont val="Arial"/><sz val="10"/></rPr><t>a</t></r></si></sst>';
  const out = Xlsx.patchSharedStrings(ss, '微軟正黑體', true);
  assert.ok(out.includes('<rPr><b/><rFont val="微軟正黑體"/>'));
});
