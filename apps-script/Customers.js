/**
 * 新客戶自動建檔（需人工確認）
 * 1. 未綁定、廠商清冊找不到相符店名或地址的 LINE 對話 → 自動建立草稿（店名、地址、電話、統編、預設價格組合）
 * 2. 客服補齊、選好收款條件與價格組合後勾「確認建檔」
 * 3. 系統把這家店「接在主檔廠商清冊最後一列之後」新增（不修改任何既有資料），同步並綁定 LINE
 * 綁定前收到的訂單一律是「待確認」，要客服確認後才會產單。
 */

var NEW_SHEET = '新客戶待建檔';
var NEW_HEADERS = ['LINE對話ID', 'LINE名稱', '店名', '聯絡人', '送貨地址', '電話', '統編', '店家區域', '價格組合', '收款條件',
  '發票樣式', '第一則訊息', '建立時間', '確認建檔', '狀態'];
var NC = {}; NEW_HEADERS.forEach(function (h, i) { NC[h] = i; });

/** 建立或補齊草稿（同一個 LINE 對話只有一份） */
function draftNewCustomer_(chatId, text, res, items) {
  var sh = ensureSheet_(NEW_SHEET, NEW_HEADERS);
  var info = Parser.extractContact(text);
  var cfg = readConfig_();
  var combo = Parser.newCustomerCombo(text, items, {
    base: cfg['新客戶價格組合'], tool: cfg['新客戶要工具價格組合'], invoice: cfg['新客戶要發票價格組合']
  });
  var n = sh.getLastRow() - 1;
  var rows = n > 0 ? sh.getRange(2, 1, n, NEW_HEADERS.length).getValues() : [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i][NC['LINE對話ID']] !== chatId || String(rows[i][NC['狀態']]).indexOf('已建檔') === 0) continue;
    // 已有草稿：只補空白欄位，不覆蓋客服填的內容
    var r = rows[i];
    var fill = { '店名': info.storeName, '送貨地址': info.address, '電話': info.phone, '統編': info.taxId, '店家區域': info.district };
    Object.keys(fill).forEach(function (k) {
      if (!String(r[NC[k]]).trim() && fill[k]) sh.getRange(i + 2, NC[k] + 1).setValue(fill[k]);
    });
    return;
  }
  var lineName = bindingName_(chatId);
  var row = NEW_HEADERS.map(function () { return ''; });
  row[NC['LINE對話ID']] = chatId;
  row[NC['LINE名稱']] = lineName;
  row[NC['店名']] = info.storeName;
  row[NC['聯絡人']] = String(lineName).split(/[\/／]/).pop().trim();
  row[NC['送貨地址']] = info.address;
  row[NC['電話']] = info.phone;
  row[NC['統編']] = info.taxId;
  row[NC['店家區域']] = info.district;
  row[NC['價格組合']] = combo;
  row[NC['第一則訊息']] = String(text).slice(0, 300);
  row[NC['建立時間']] = new Date();
  row[NC['確認建檔']] = false;
  row[NC['狀態']] = '待補資料';
  sh.appendRow(row);
  formatNewCustomerSheet_(sh);
  notify_('【出貨】新客戶待建檔：' + (info.storeName || lineName || '未知店名'),
    '<p>有一個 LINE 對話找不到對應的店家，系統已在「' + NEW_SHEET + '」建立草稿：</p><ul>' +
    '<li>店名：' + esc_(info.storeName || '（未抓到，請補）') + '</li><li>地址：' + esc_(info.address || '（未抓到，請補）') + '</li>' +
    '<li>電話：' + esc_(info.phone || '（未抓到，請補）') + '</li><li>預設價格組合：' + esc_(combo) + '</li></ul>' +
    '<p>請補齊資料、選擇收款條件，確認無誤後勾「確認建檔」，系統會新增到主檔廠商清冊（只新增一列，不會改到其他資料）並綁定這個 LINE。</p>' +
    '<p><a href="' + SpreadsheetApp.getActive().getUrl() + '">開啟華暉出貨自動化</a></p>', []);
}

function bindingName_(chatId) {
  var sh = SpreadsheetApp.getActive().getSheetByName(LINE_SHEET.BIND);
  if (!sh || sh.getLastRow() < 2) return '';
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  for (var i = 0; i < rows.length; i++) if (rows[i][0] === chatId) return String(rows[i][1]);
  return '';
}

/** 勾選「確認建檔」 */
function handleNewCustomerEdit_(range) {
  var sh = range.getSheet();
  for (var r = range.getRow(); r < range.getRow() + range.getNumRows(); r++) {
    if (r < 2) continue;
    var box = sh.getRange(r, NC['確認建檔'] + 1);
    if (box.getValue() !== true) continue;
    var msg;
    try { msg = confirmNewCustomer_(sh, r); }
    catch (e) { msg = '❌ ' + (e && e.message || e); }
    box.setValue(false);
    sh.getRange(r, NC['狀態'] + 1).setValue(msg);
  }
}

function confirmNewCustomer_(sh, r) {
  var row = sh.getRange(r, 1, 1, NEW_HEADERS.length).getValues()[0];
  if (String(row[NC['狀態']]).indexOf('已建檔') === 0) return row[NC['狀態']];
  var need = ['店名', '送貨地址', '電話', '價格組合', '收款條件'].filter(function (k) { return !String(row[NC[k]]).trim(); });
  if (need.length) throw new Error('還缺：' + need.join('、'));
  var name = String(row[NC['店名']]).trim();
  var exists = readVendorNames_().filter(function (v) { return Core.storeKey(v) === Core.storeKey(name); });
  if (exists.length) throw new Error('廠商清冊已有「' + exists[0] + '」，請改用「LINE帳號對照」直接選店家');
  var mainId = mainIds_()[0];
  if (!mainId) throw new Error('請先在「設定」填入主檔試算表ID');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var vsh = SpreadsheetApp.openById(mainId).getSheetByName(SHEET.VENDORS);
    if (!vsh) throw new Error('主檔找不到「廠商清冊」');
    // 找最後一個有店名的列，新店家接在它下一列（只寫入空白列，不覆蓋任何資料）
    var last = vsh.getLastRow();
    var cols = vsh.getRange(1, 1, last, 3).getValues();
    var lastIdx = 0, maxNo = 0;
    cols.forEach(function (c, i) {
      if (String(c[2]).trim()) lastIdx = i + 1;
      if (i > 0 && !isNaN(Number(c[0])) && String(c[0]).trim() !== '') maxNo = Math.max(maxNo, Number(c[0]));
    });
    var target = lastIdx + 1;
    if (target <= last && vsh.getRange(target, 1, 1, 18).getValues()[0].some(function (v) { return String(v).trim() !== ''; })) {
      throw new Error('主檔廠商清冊第 ' + target + ' 列不是空白，為避免覆蓋資料已停止，請檢查主檔');
    }
    var today = new Date();
    vsh.getRange(target, 1, 1, 6).setValues([[maxNo + 1, today, name, row[NC['聯絡人']], row[NC['送貨地址']], row[NC['電話']]]]);
    vsh.getRange(target, 7, 1, 3).setValues([[0, 0, 0]]);
    // 累計叫貨量等公式：沿用上一列的寫法
    if (lastIdx >= 2) {
      var f = vsh.getRange(lastIdx, 10, 1, 2).getFormulasR1C1()[0];
      if (f[0] || f[1]) vsh.getRange(target, 10, 1, 2).setFormulasR1C1([f]);
    }
    vsh.getRange(target, 14, 1, 5).setValues([[row[NC['統編']], row[NC['店家區域']], row[NC['收款條件']], row[NC['價格組合']], row[NC['發票樣式']]]]);
  } finally {
    lock.releaseLock();
  }

  syncVendors();
  bindChat_(row[NC['LINE對話ID']], row[NC['LINE名稱']], name);
  return '已建檔 ' + Utilities.formatDate(new Date(), TZ, 'MM/dd HH:mm') + '（主檔第 ' + target + ' 列），已綁定 LINE；這個客戶的訂單請到出貨清單核對後勾「確認」';
}

/** 綁定：已有空白列就填入，否則新增一列；並補上之前訂單的店家 */
function bindChat_(chatId, lineName, store) {
  var sh = ensureSheet_(LINE_SHEET.BIND, BIND_HEADERS);
  var n = sh.getLastRow() - 1;
  var rows = n > 0 ? sh.getRange(2, 1, n, 3).getValues() : [];
  var done = false;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i][0] === chatId && !String(rows[i][2]).trim()) { sh.getRange(i + 2, 3).setValue(store); done = true; break; }
  }
  if (!done) sh.appendRow([chatId, lineName, store, new Date(), '新客戶建檔', '']);
  applyBinding_(chatId, store);
}

function formatNewCustomerSheet_(sh) {
  sh = sh || ensureSheet_(NEW_SHEET, NEW_HEADERS);
  headerStyle_(sh, NEW_HEADERS.length);
  var rows = sh.getMaxRows() - 1;
  var widths = [60, 160, 170, 90, 260, 120, 90, 120, 110, 100, 100, 320, 120, 80, 260];
  widths.forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  sh.hideColumns(1);
  sh.getRange(2, NC['確認建檔'] + 1, rows, 1).insertCheckboxes();
  sh.getRange(2, NC['第一則訊息'] + 1, rows, 1).setWrap(true);
  sh.getRange(2, NC['建立時間'] + 1, rows, 1).setNumberFormat('mm/dd hh:mm');
  var ss = SpreadsheetApp.getActive();
  sh.getRange(2, NC['價格組合'] + 1, rows, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(ss.getSheetByName(SHEET.INVOICE).getRange('O3:O103'), true).setAllowInvalid(false).build());
  var pays = unique_(ss.getSheetByName(SHEET.VENDORS).getRange('P2:P').getValues().map(function (x) { return String(x[0]).trim(); })).filter(String);
  if (pays.length) sh.getRange(2, NC['收款條件'] + 1, rows, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(pays, true).setAllowInvalid(true).build());
  ['店名', '送貨地址', '電話', '價格組合', '收款條件'].forEach(function (k) { sh.getRange(1, NC[k] + 1).setBackground('#a3620a'); });
  sh.getRange(1, NC['確認建檔'] + 1).setNote('深色標題是必填。勾選後新增到主檔廠商清冊並綁定 LINE（只新增一列，不改其他資料）');
}
