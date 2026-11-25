/**
 * 表格外觀與操作：狀態顏色、隱藏技術欄位、「確認」勾選、總覽頁。
 * 只改外觀與輔助功能，不影響資料欄位的位置。
 */

var STATUS_COLORS = {
  '待確認': { row: '#fff6e0', cell: '#f6c453' },
  '建議': { row: '#eef4ff', cell: '#a9c4f5' },
  '待出貨': { row: '#eaf6ee', cell: '#8fd0a6' },
  '已產單': { row: '#f3f4f6', cell: '#c9ced6' },
  '已手打': { row: '#f3f4f6', cell: '#c9ced6' },
  '已出貨': { row: '#f3f4f6', cell: '#c9ced6' },
  '暫緩': { row: '#fdeeee', cell: '#eaa3a3' },
  '取消': { row: '#fdeeee', cell: '#eaa3a3' }
};
var HEADER_BG = '#1f4e9c';

var FONT_SIZE = 12;        // 內容
var HEADER_FONT_SIZE = 13; // 標題列

function menuFormatSheets() { showResult_({ message: formatSheets_().join('\n') }); }

/** 每一步各自執行並回報結果 */
function formatSheets_() {
  var ss = SpreadsheetApp.getActive();
  var results = [];
  var step = function (name, fn) {
    try { fn(); results.push('✅ ' + name); }
    catch (e) { results.push('❌ ' + name + '：' + (e && e.message || e)); console.error(name, e && e.stack || e); }
  };
  step('出貨清單', function () { var sh = ss.getSheetByName(SHEET.ORDERS); if (sh) formatOrderSheet_(sh, true); });
  step('LINE試跑', function () { var sh = ss.getSheetByName(LINE_SHEET.TRIAL); if (sh) formatOrderSheet_(sh, false); });
  step('LINE帳號對照（店家下拉選單）', function () {
    var sh = ss.getSheetByName(LINE_SHEET.BIND);
    if (!sh) return;
    formatSimple_(sh, { 1: 60, 2: 200, 3: 240, 4: 150, 5: 170, 6: 220 }, [1]);
    sh.getRange(2, 3, sh.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInRange(ss.getSheetByName(SHEET.VENDORS).getRange('C2:C'), true).setAllowInvalid(false)
      .setHelpText('從廠商清冊選擇店家；找不到請先在主檔廠商清冊建檔').build()).setBackground('#fffbe6');
  });
  step('型號對照（型號下拉選單）', function () {
    var sh = ss.getSheetByName(SHEET.ALIASES);
    if (!sh) return;
    formatSimple_(sh, { 1: 200, 2: 180, 3: 150 }, []);
    sh.getRange(2, 2, sh.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInRange(ss.getSheetByName(SHEET.INVOICE).getRange('P3:P103'), true).setAllowInvalid(false).build());
    sh.getRange(2, 3, sh.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(['4', '8'], true).setAllowInvalid(true).build());
  });
  step('訊息紀錄', function () { formatSimple_(ss.getSheetByName(LINE_SHEET.LOG), { 1: 150, 2: 60, 3: 60, 4: 70, 5: 440, 6: 60, 7: 90, 8: 60, 9: 110 }, [2, 3, 6, 8]); });
  step('批次紀錄', function () { formatSimple_(ss.getSheetByName(SHEET.BATCHES), { 1: 120, 2: 150, 3: 80, 4: 80, 5: 280, 6: 130, 7: 130, 8: 130, 9: 170, 10: 130 }, []); });
  step('設定', function () { formatConfig_(ss.getSheetByName(SHEET.CONFIG)); });
  step('總覽', buildOverview_);
  step('分頁排序與模板保護', arrangeTabs_);
  return results;
}

function headerStyle_(sh, n) {
  sh.getRange(1, 1, sh.getMaxRows(), n).setFontSize(FONT_SIZE);
  sh.getRange(1, 1, 1, n).setFontWeight('bold').setFontColor('#ffffff').setBackground(HEADER_BG).setVerticalAlignment('middle').setFontSize(HEADER_FONT_SIZE);
  sh.setRowHeight(1, 34);
  sh.setFrozenRows(1);
}

function formatOrderSheet_(sh, isOrders) {
  var n = ORDER_HEADERS.length;
  headerStyle_(sh, n);
  var widths = { '訂單ID': 70, '收單時間': 120, '出貨日': 95, '店家': 170, '型號': 130, '數量': 55, '8pin數': 60, '附註': 140,
    '狀態': 80, '批次': 95, '單據編號': 140, '來源': 60, '系統訊息': 360, '折讓金額': 80, '已收金額': 80, '確認': 55, '價格組合': 110 };
  ORDER_HEADERS.forEach(function (h, i) { if (widths[h]) sh.setColumnWidth(i + 1, widths[h]); });
  var rows = sh.getMaxRows() - 1;
  sh.getRange(2, COL['收單時間'] + 1, rows, 1).setNumberFormat('mm/dd hh:mm');
  sh.getRange(2, COL['系統訊息'] + 1, rows, 1).setWrap(true).setFontColor('#5b6676');
  sh.getRange(2, 1, rows, n).setVerticalAlignment('top');
  sh.getRange(2, COL['數量'] + 1, rows, 2).setHorizontalAlignment('center');
  // 內部用欄位收起來（資料還在，右鍵「取消隱藏」可看）
  ['訂單ID', '來源'].forEach(function (h) { sh.hideColumns(COL[h] + 1); });
  if (isOrders) {
    sh.getRange(2, COL['確認'] + 1, rows, 1).insertCheckboxes();
    sh.getRange(1, COL['確認'] + 1).setNote('勾選＝確認無誤，「待確認」或「建議」會變成「待出貨」');
  }
  sh.getRange(1, COL['狀態'] + 1).setNote('待確認：系統不確定，請核對\n待出貨：10:00 會產單\n已產單：已印過\n已手打／暫緩／取消：不產單');
  // 狀態顏色：整列淡色、狀態格深色
  var all = sh.getRange(2, 1, rows, n), statusCol = sh.getRange(2, COL['狀態'] + 1, rows, 1);
  var letter = columnLetter_(COL['狀態'] + 1);
  var rules = [];
  Object.keys(STATUS_COLORS).forEach(function (st) {
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(st).setBackground(STATUS_COLORS[st].cell).setBold(true).setRanges([statusCol]).build());
  });
  Object.keys(STATUS_COLORS).forEach(function (st) {
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$' + letter + '2="' + st + '"').setBackground(STATUS_COLORS[st].row).setRanges([all]).build());
  });
  // 資料有誤（系統訊息以 ⚠ 開頭且仍待出貨）：紅字提醒
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND($' + letter + '2="待出貨",LEFT($' + columnLetter_(COL['系統訊息'] + 1) + '2,1)="⚠")')
    .setFontColor('#c0392b').setRanges([sh.getRange(2, COL['系統訊息'] + 1, rows, 1)]).build());
  sh.setConditionalFormatRules(rules);
  if (!sh.getFilter()) sh.getRange(1, 1, sh.getMaxRows(), n).createFilter();
}

function formatSimple_(sh, widths, hideCols) {
  if (!sh) return;
  var n = Math.max(sh.getLastColumn(), 1);
  headerStyle_(sh, n);
  Object.keys(widths).forEach(function (c) { if (Number(c) <= sh.getMaxColumns()) sh.setColumnWidth(Number(c), widths[c]); });
  (hideCols || []).forEach(function (c) { if (c <= sh.getMaxColumns()) sh.hideColumns(c); });
}

/** 設定：常用的放前面標成淺藍，進階的灰字 */
var CONFIG_COMMON = ['通知Email', '單據編號月份', '單據編號最後流水號', SUPPLEMENT_KEY, '試跑模式', 'AI判讀', '主批次時間', '當日截止時間', '輸出PDF', '開發票價格組合'];
function formatConfig_(sh) {
  if (!sh) return;
  headerStyle_(sh, 3);
  sh.setColumnWidth(1, 190); sh.setColumnWidth(2, 260); sh.setColumnWidth(3, 520);
  var n = sh.getLastRow() - 1;
  if (n < 1) return;
  var keys = sh.getRange(2, 1, n, 1).getValues();
  sh.getRange(2, 3, n, 1).setFontColor('#6b7280').setWrap(true);
  keys.forEach(function (k, i) {
    var common = CONFIG_COMMON.indexOf(k[0]) >= 0;
    sh.getRange(i + 2, 1, 1, 2).setBackground(common ? '#e6eefb' : null).setFontWeight(common ? 'bold' : 'normal');
  });
  sh.getRange(1, 1).setNote('淺藍色是常用設定；其他是列印、合併時間等進階設定，平常不用改');
}

/** 總覽：打開試算表第一眼看到今天要處理的事 */
function buildOverview_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName('總覽') || ss.insertSheet('總覽', 0);
  sh.clear();
  sh.setHiddenGridlines(true);
  var O = "'" + SHEET.ORDERS + "'!", T = "'" + LINE_SHEET.TRIAL + "'!", B = "'" + LINE_SHEET.BIND + "'!", R = "'" + SHEET.BATCHES + "'!";
  var st = columnLetter_(COL['狀態'] + 1), dt = columnLetter_(COL['出貨日'] + 1);
  var cells = [
    ['華暉出貨總覽', ''],
    ['今天', '=TEXT(TODAY(),"yyyy/mm/dd（ddd）")'],
    ['', ''],
    ['⚠ 待確認（請核對後勾「確認」）', '=COUNTIF(' + O + st + ':' + st + ',"待確認")'],
    ['📦 待出貨（下次 10:00 產單）', '=COUNTIFS(' + O + st + ':' + st + ',"待出貨",' + O + dt + ':' + dt + ',"<="&TODAY())'],
    ['🗓 之後出貨的待出貨', '=COUNTIFS(' + O + st + ':' + st + ',"待出貨",' + O + dt + ':' + dt + ',">"&TODAY())'],
    ['🧪 LINE 試跑：建議／待確認', '=COUNTIF(' + T + st + ':' + st + ',"建議")&" ／ "&COUNTIF(' + T + st + ':' + st + ',"待確認")'],
    ['👤 尚未綁定店家的 LINE 帳號', '=COUNTIFS(' + B + 'A2:A,"<>",' + B + 'C2:C,"")'],
    ['', '']
  ];
  sh.getRange(1, 1, cells.length, 2).setValues(cells);
  sh.getRange('A1:G60').setFontSize(FONT_SIZE);
  sh.getRange('A1').setFontSize(20).setFontWeight('bold').setFontColor(HEADER_BG);
  sh.getRange('A2:B2').setFontSize(14);
  sh.getRange('A4:B8').setFontSize(14);
  sh.getRange('B4:B8').setFontWeight('bold').setHorizontalAlignment('center');
  sh.getRange('A4:B4').setBackground('#fff6e0');
  sh.getRange('A5:B5').setBackground('#eaf6ee');
  sh.setColumnWidth(1, 300); sh.setColumnWidth(2, 140);
  [3, 4, 5, 6].forEach(function (c) { sh.setColumnWidth(c, 140); });
  sh.setColumnWidth(7, 380);

  var q = function (row, title, formula) {
    sh.getRange(row, 1).setValue(title).setFontWeight('bold').setFontSize(14).setFontColor(HEADER_BG);
    sh.getRange(row + 1, 1).setFormula(formula);
  };
  var c = function (h) { return 'Col' + (COL[h] + 1); };
  q(10, '待確認清單', '=IFERROR(QUERY({' + O + 'A2:Z},"select ' + [c('店家'), c('型號'), c('數量'), c('出貨日'), c('附註'), c('系統訊息')].join(',') +
    ' where ' + c('狀態') + '=\'待確認\' label ' + c('店家') + ' \'店家\',' + c('型號') + ' \'型號\',' + c('數量') + ' \'數量\',' + c('出貨日') + ' \'出貨日\',' + c('附註') + ' \'附註\',' + c('系統訊息') + ' \'原因／原文\'",0),"（沒有待確認）")');
  q(30, '尚未綁定店家的 LINE 帳號（到「LINE帳號對照」選店家）', '=IFERROR(QUERY({' + B + 'A2:F},"select Col2, Col6, Col4 where Col1 is not null and Col3 is null label Col2 \'LINE名稱\', Col6 \'系統建議店家\', Col4 \'第一次出現\'",0),"（全部已綁定）")');
  q(42, '最近 5 次產單', '=IFERROR(QUERY(SORT({' + R + 'A2:J},2,FALSE),"select Col1, Col3, Col4, Col8, Col10, Col6 where Col1 is not null limit 5 label Col1 \'批次\', Col3 \'類型\', Col4 \'店家數\', Col8 \'出貨單Excel\', Col10 \'貨運單Excel\', Col6 \'出貨單PDF\'",0),"（尚未產單）")');
  sh.getRange('A11:G28').setWrap(true).setVerticalAlignment('top');
  sh.setTabColor('#1f4e9c');
}

/** 分頁順序：常用在前，模板與紀錄在後並標灰 */
function arrangeTabs_() {
  var ss = SpreadsheetApp.getActive();
  var order = ['總覽', SHEET.ORDERS, LINE_SHEET.TRIAL, LINE_SHEET.BIND, SHEET.CONFIG, SHEET.ALIASES, SHEET.HOLIDAYS, SHEET.PARSE_TEST,
    LINE_SHEET.LOG, SHEET.BATCHES, SHEET.INVOICE, SHEET.LABEL, SHEET.VENDORS];
  var colors = {};
  colors[SHEET.ORDERS] = '#2f7d4f'; colors[LINE_SHEET.TRIAL] = '#7fa8ee'; colors[LINE_SHEET.BIND] = '#f6c453';
  [LINE_SHEET.LOG, SHEET.BATCHES, SHEET.INVOICE, SHEET.LABEL, SHEET.VENDORS].forEach(function (n) { colors[n] = '#9aa3af'; });
  var pos = 1;
  order.forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(pos++);
    if (colors[name]) sh.setTabColor(colors[name]);
  });
  // 模板：誤改時跳出警告（仍可修改）
  [SHEET.INVOICE, SHEET.LABEL, SHEET.VENDORS].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (sh && !sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).length) {
      sh.protect().setDescription(name + '：系統模板／同步資料，修改前請確認').setWarningOnly(true);
    }
  });
  ss.setActiveSheet(ss.getSheetByName('總覽'));
}

/** 出貨清單「確認」勾選：待確認／建議 → 待出貨 */
function handleConfirmEdit_(range) {
  var sh = range.getSheet();
  for (var r = range.getRow(); r < range.getRow() + range.getNumRows(); r++) {
    if (r < 2) continue;
    var box = sh.getRange(r, COL['確認'] + 1);
    if (box.getValue() !== true) continue;
    var stCell = sh.getRange(r, COL['狀態'] + 1);
    var st = stCell.getValue();
    if (st === '待確認' || st === '建議') {
      var missing = [];
      if (!sh.getRange(r, COL['店家'] + 1).getValue()) missing.push('店家');
      if (!sh.getRange(r, COL['型號'] + 1).getValue()) missing.push('型號');
      if (!sh.getRange(r, COL['數量'] + 1).getValue()) missing.push('數量');
      if (!sh.getRange(r, COL['出貨日'] + 1).getValue()) missing.push('出貨日');
      if (missing.length) {
        box.setValue(false);
        box.setNote('還缺：' + missing.join('、') + '，補上後再勾選');
        continue;
      }
      stCell.setValue('待出貨');
      box.setNote('已確認 ' + Utilities.formatDate(new Date(), TZ, 'MM/dd HH:mm'));
    }
    box.setValue(false);
  }
}

function columnLetter_(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
