/* 華暉出貨自動化：請整份貼進 Apps Script 的 Code.gs（取代原本內容）。由 scripts/bundle.js 產生，請勿手改。 */

/**
 * 純邏輯（不呼叫任何 Google 服務），Apps Script 與 Node 測試共用。
 * 日期一律使用 'YYYY-MM-DD' 字串（台灣時間）。
 */
var Core = (function () {
  var INVOICE_MAX_LINES = 7; // 出貨單 C9:C15
  var LABELS_PER_SHEET = 6; // 貨運單 L3:L8
  var LABELS_PER_PAGE = 3;

  /** 年份字母：2021=A … 2026=F、2027=G */
  function yearLetter(year) {
    var idx = year - 2021;
    if (idx < 0 || idx > 25) throw new Error('單據編號年份超出範圍：' + year);
    return String.fromCharCode(65 + idx);
  }

  /** 20B + 年份字母 + 月 2 碼 + 流水號 9 碼，例：20BF11000000047 */
  function formatOrderNo(dateStr, serial) {
    var p = parseDate(dateStr);
    return '20B' + yearLetter(p.y) + pad(p.m, 2) + pad(serial, 9);
  }

  /**
   * 依目前狀態取下一個編號；跨月（含跨年）流水號重新從 1 開始。
   * state: { month: 'YYYY-MM', last: Number }
   */
  function nextOrderNo(state, dateStr) {
    var month = dateStr.slice(0, 7);
    var last = state && state.month === month ? Number(state.last) || 0 : 0;
    var serial = last + 1;
    return { orderNo: formatOrderNo(dateStr, serial), state: { month: month, last: serial } };
  }

  /** 買十送一：同品項每 10 個送 1 個，不跨品項；同一天出貨的同型號先合併再計算 */
  function giftQty(qty, product, eligible) {
    if (eligible && eligible.length && eligible.indexOf(product) < 0) return 0;
    return Math.floor(Number(qty) / 10);
  }

  /** 附註欄，沿用現有寫法，例：10+1/8P*2 */
  function buildNote(line, eligible) {
    var parts = [];
    var gift = giftQty(line.qty, line.product, eligible);
    if (gift > 0) parts.push(line.qty + '+' + gift);
    var pin8 = Number(line.pin8) || 0;
    if (pin8 > 0) parts.push('8P*' + pin8);
    if (line.note) parts.push(String(line.note).trim());
    return parts.join('/');
  }

  /**
   * 把出貨清單的列整理成「每家店一張出貨單」。
   * rows: [{id, shipDate, store, product, qty, pin8, note, status}]
   * opts: { today, vendors: [店名], products: [型號], eligible: [10+1 適用型號] }
   * 回傳 { groups: [{store, rowIds, lines:[{product, qty, note}]}], errors: [{rowId, message}] }
   */
  function buildGroups(rows, opts) {
    var vendorSet = toSet(opts.vendors), productSet = toSet(opts.products);
    var dupVendors = toSet(findDuplicates(opts.vendors || []));
    var byStore = {}, order = [], errors = [];

    rows.forEach(function (r) {
      if (r.status !== '待出貨') return;
      if (!r.shipDate || r.shipDate > opts.today) return;
      var msg = validateRow(r, vendorSet, productSet);
      if (msg) { errors.push({ rowId: r.id, message: msg }); return; }
      if (!byStore[r.store]) { byStore[r.store] = []; order.push(r.store); }
      byStore[r.store].push(r);
    });

    var groups = [];
    order.forEach(function (store) {
      var list = byStore[store];
      var merged = mergeSameProduct(list);
      if (merged.length > INVOICE_MAX_LINES) {
        list.forEach(function (r) {
          errors.push({ rowId: r.id, message: '同一家店超過 ' + INVOICE_MAX_LINES + ' 行品項，出貨單放不下，請拆單或人工處理' });
        });
        return;
      }
      groups.push({
        store: store,
        duplicateVendor: !!dupVendors[store],
        rowIds: list.map(function (r) { return r.id; }),
        lines: merged.map(function (m) {
          return { product: m.product, qty: m.qty, note: buildNote(m, opts.eligible) };
        })
      });
    });
    return { groups: groups, errors: errors };
  }

  /** 同一天出貨、同一家店的同型號合併成一行，10+1 以合併後數量計算 */
  function mergeSameProduct(list) {
    var byProduct = {}, out = [];
    list.forEach(function (r) {
      var m = byProduct[r.product];
      if (!m) {
        m = byProduct[r.product] = { product: r.product, qty: 0, pin8: 0, notes: [] };
        out.push(m);
      }
      m.qty += Number(r.qty);
      m.pin8 += Number(r.pin8) || 0;
      var n = String(r.note || '').trim();
      if (n && m.notes.indexOf(n) < 0) m.notes.push(n);
    });
    return out.map(function (m) { return { product: m.product, qty: m.qty, pin8: m.pin8, note: m.notes.join('/') }; });
  }

  function validateRow(r, vendorSet, productSet) {
    if (!r.store) return '缺少店家';
    if (!vendorSet[r.store]) return '店家不在廠商清冊：' + r.store;
    if (!r.product) return '缺少型號';
    if (!productSet[r.product]) return '型號不在出貨單價格表：' + r.product;
    var q = Number(r.qty);
    if (!(q > 0) || Math.floor(q) !== q) return '數量必須是正整數';
    var p8 = Number(r.pin8) || 0;
    if (p8 < 0 || p8 > q || Math.floor(p8) !== p8) return '8pin 數量不正確';
    return '';
  }

  /** 貨運單：每張工作表 6 格（2 頁 × 3 格），8 家 → [[6 家], [2 家]] → 3+3+2 頁 */
  function chunkLabels(stores) {
    var out = [];
    for (var i = 0; i < stores.length; i += LABELS_PER_SHEET) out.push(stores.slice(i, i + LABELS_PER_SHEET));
    return out;
  }

  function labelPagesFor(count) {
    return Math.ceil(count / LABELS_PER_PAGE);
  }

  function isShippingDay(dateStr, holidays, shipSaturday) {
    if (toSet(holidays)[dateStr]) return false;
    var p = parseDate(dateStr);
    var dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
    if (dow === 0) return false;
    if (dow === 6 && !shipSaturday) return false;
    return true;
  }

  /** 批次編號：YYYYMMDD-01、-02 … */
  function nextBatchId(dateStr, existingIds) {
    var prefix = dateStr.replace(/-/g, '') + '-';
    var max = 0;
    (existingIds || []).forEach(function (id) {
      if (String(id).indexOf(prefix) === 0) max = Math.max(max, Number(String(id).slice(prefix.length)) || 0);
    });
    return prefix + pad(max + 1, 2);
  }

  /** 補單詢問：同一組未產單訂單只問一次 */
  function pendingSignature(rowIds) {
    return rowIds.slice().sort().join(',');
  }

  function findDuplicates(names) {
    var seen = {}, dup = {};
    names.forEach(function (n) { if (!n) return; if (seen[n]) dup[n] = true; seen[n] = true; });
    return Object.keys(dup);
  }

  /** '1-35' → {start:1, end:35} */
  function parseRowRange(s) {
    var m = String(s).match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
    if (!m || Number(m[1]) > Number(m[2])) throw new Error('列範圍格式錯誤：' + s);
    return { start: Number(m[1]), end: Number(m[2]) };
  }

  function parseDate(s) {
    var m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) throw new Error('日期格式錯誤：' + s);
    return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  }

  function pad(n, w) {
    var s = String(n);
    if (s.length > w) throw new Error('數字超過 ' + w + ' 位：' + n);
    while (s.length < w) s = '0' + s;
    return s;
  }

  function toSet(arr) {
    var o = {};
    (arr || []).forEach(function (x) { if (x !== '' && x != null) o[x] = true; });
    return o;
  }

  return {
    INVOICE_MAX_LINES: INVOICE_MAX_LINES,
    LABELS_PER_SHEET: LABELS_PER_SHEET,
    yearLetter: yearLetter,
    formatOrderNo: formatOrderNo,
    nextOrderNo: nextOrderNo,
    giftQty: giftQty,
    buildNote: buildNote,
    buildGroups: buildGroups,
    mergeSameProduct: mergeSameProduct,
    chunkLabels: chunkLabels,
    labelPagesFor: labelPagesFor,
    isShippingDay: isShippingDay,
    nextBatchId: nextBatchId,
    pendingSignature: pendingSignature,
    findDuplicates: findDuplicates,
    parseRowRange: parseRowRange
  };
})();

if (typeof module !== 'undefined') module.exports = Core;


/**
 * 華暉出貨自動化（第一階段）：出貨清單 → 出貨單 PDF / Excel、貨運單 PDF → Email
 * 綁定在獨立的「華暉出貨自動化」試算表，不改動日常作業的主檔。
 */

var SHEET = {
  CONFIG: '設定',
  ORDERS: '出貨清單',
  BATCHES: '批次紀錄',
  HOLIDAYS: '假日',
  INVOICE: '出貨單',
  LABEL: '貨運單',
  VENDORS: '廠商清冊'
};

var ORDER_HEADERS = ['訂單ID', '收單時間', '出貨日', '店家', '型號', '數量', '8pin數', '附註', '狀態', '批次', '單據編號', '來源', '系統訊息'];
var COL = {}; ORDER_HEADERS.forEach(function (h, i) { COL[h] = i; });
var STATUSES = ['待出貨', '已產單', '已手打', '暫緩', '取消', '已出貨'];
var BATCH_HEADERS = ['批次ID', '產生時間', '類型', '店家數', '單據編號', '出貨單PDF', '貨運單PDF', '出貨單Excel', '執行者'];
var TZ = 'Asia/Taipei';
var SUPPLEMENT_KEY = '產生補單（勾選執行）';

/** 設定預設值：[鍵, 值, 說明] */
var CONFIG_DEFAULTS = [
  ['通知Email', '', '多個以逗號分隔'],
  ['輸出資料夾ID', '', 'Google 雲端硬碟資料夾網址最後那串 ID；空白則放在我的雲端硬碟根目錄'],
  ['主檔試算表ID', '', '日常的「庫存管理及出貨單」試算表 ID；填了會在每次產單前同步廠商清冊'],
  ['單據編號月份', '', '例：2026-11（系統自動維護）'],
  ['單據編號最後流水號', 0, '本月已用到的最後號碼；手打出貨單時也請改這裡，避免撞號'],
  ['主批次時間', '10:00', ''],
  ['當日截止時間', '16:00', '截止後不再詢問補單'],
  ['週六出貨', false, ''],
  ['10+1適用型號', 'GPB-2000,GPB-2000A,GPB-2000S,DCB-6000', '逗號分隔；空白代表所有型號'],
  ['出貨單第一聯列', '1-35', ''],
  ['出貨單第二聯列', '36-70', ''],
  ['貨運單第一頁列', '1-41', ''],
  ['貨運單第二頁列', '42-84', ''],
  ['列印欄數', 9, 'A～I 欄'],
  ['出貨單PDF參數', 'size=A4&portrait=true&scale=4&top_margin=0.3&bottom_margin=0.3&left_margin=0.3&right_margin=0.3&horizontal_alignment=CENTER', 'scale：1=100%、2=符合寬度、3=符合高度、4=符合頁面'],
  ['貨運單PDF參數', 'size=A4&portrait=true&scale=4&top_margin=0.3&bottom_margin=0.3&left_margin=0.3&right_margin=0.3&horizontal_alignment=CENTER', '依實體貼紙校準'],
  [SUPPLEMENT_KEY, false, '勾選後立即產生補單（手機也可以）']
];

/* ───────────── 選單與觸發 ───────────── */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('華暉出貨')
    .addItem('產生今日主批次', 'menuMainBatch')
    .addItem('產生補單', 'menuSupplement')
    .addSeparator()
    .addItem('同步廠商清冊', 'syncVendors')
    .addItem('初始化／修復工作表與排程', 'setup')
    .addToUi();
}

function menuMainBatch() { showResult_(runBatch_('主批次', { manual: true })); }
function menuSupplement() { showResult_(runBatch_('補單', { manual: true })); }

/** 每 5 分鐘：10:00 主批次；之後到截止前有新的待出貨訂單時，用 Email 詢問是否補單 */
function tick() {
  var cfg = readConfig_();
  var now = new Date();
  var today = fmtDate_(now);
  var hm = Utilities.formatDate(now, TZ, 'HH:mm');
  if (!Core.isShippingDay(today, readHolidays_(), truthy_(cfg['週六出貨']))) return;

  var props = PropertiesService.getScriptProperties();
  if (hm >= cfg['主批次時間'] && props.getProperty('mainDone') !== today) {
    // 先標記，失敗時只寄一次失敗通知，不會每 5 分鐘重試；可用選單手動重跑
    props.setProperty('mainDone', today);
    runBatch_('主批次', {});
    return;
  }
  if (props.getProperty('mainDone') === today && hm < cfg['當日截止時間']) askSupplement_(today, props);
}

/** 可安裝的 onEdit：勾選「產生補單」 */
function onEditInstalled(e) {
  var r = e.range;
  if (r.getSheet().getName() !== SHEET.CONFIG || r.getColumn() !== 2) return;
  if (r.getSheet().getRange(r.getRow(), 1).getValue() !== SUPPLEMENT_KEY || r.getValue() !== true) return;
  r.setValue(false);
  var res = runBatch_('補單', { manual: true });
  r.setNote(Utilities.formatDate(new Date(), TZ, 'MM/dd HH:mm') + ' ' + res.message);
}

/* ───────────── 批次 ───────────── */

function runBatch_(type, opts) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, message: '另一個批次正在執行，請稍後再試' };
  var ss = SpreadsheetApp.getActive();
  var tmpSheets = [];
  try {
    var cfg = readConfig_();
    if (cfg['主檔試算表ID']) syncVendors();
    var today = fmtDate_(new Date());
    var orders = readOrders_();
    var built = Core.buildGroups(orders.rows, {
      today: today,
      vendors: readVendorNames_(),
      products: readProducts_(),
      eligible: splitList_(cfg['10+1適用型號'])
    });
    writeRowMessages_(orders, built.errors);

    if (!built.groups.length) {
      var msg = type + '：今日無待出貨訂單' + (built.errors.length ? '（另有 ' + built.errors.length + ' 筆資料有誤，請看「系統訊息」欄）' : '');
      if (!opts.manual || built.errors.length) notify_('【出貨】' + today + ' ' + msg, '<p>' + msg + '</p>', []);
      return { ok: true, message: msg };
    }

    var batchId = Core.nextBatchId(today, readBatchIds_());
    var state = { month: String(cfg['單據編號月份'] || ''), last: Number(cfg['單據編號最後流水號']) || 0 };
    built.groups.forEach(function (g) {
      var r = Core.nextOrderNo(state, today);
      g.orderNo = r.orderNo; state = r.state;
    });

    var folder = cfg['輸出資料夾ID'] ? DriveApp.getFolderById(cfg['輸出資料夾ID']) : DriveApp.getRootFolder();
    var invSS = buildInvoices_(ss, built.groups, today, cfg, tmpSheets);
    var lblSS = buildLabels_(ss, built.groups.map(function (g) { return g.store; }), cfg, tmpSheets);

    var name = batchId + '_' + type;
    var invPdf = folder.createFile(exportBlob_(invSS.getId(), 'pdf', cfg['出貨單PDF參數']).setName('出貨單_' + name + '.pdf'));
    var lblPdf = folder.createFile(exportBlob_(lblSS.getId(), 'pdf', cfg['貨運單PDF參數']).setName('貨運單_' + name + '.pdf'));
    var invXlsx = folder.createFile(exportBlob_(invSS.getId(), 'xlsx', '').setName('出貨單_' + name + '.xlsx'));
    DriveApp.getFileById(invSS.getId()).moveTo(folder);
    DriveApp.getFileById(lblSS.getId()).moveTo(folder);

    // 全部成功才寫回：編號、訂單狀態、批次紀錄
    setConfig_('單據編號月份', state.month);
    setConfig_('單據編號最後流水號', state.last);
    markGenerated_(orders, built.groups, batchId);
    ss.getSheetByName(SHEET.BATCHES).appendRow([
      batchId, new Date(), type, built.groups.length,
      built.groups.map(function (g) { return g.orderNo; }).join(', '),
      invPdf.getUrl(), lblPdf.getUrl(), invXlsx.getUrl(),
      Session.getEffectiveUser().getEmail()
    ]);

    notify_('【出貨】' + today + ' ' + type + ' ' + batchId + '：' + built.groups.length + ' 家店',
      summaryHtml_(built, batchId, ss.getUrl()), [invPdf.getBlob(), lblPdf.getBlob()]);
    return { ok: true, message: type + ' ' + batchId + ' 完成：' + built.groups.length + ' 家店' };
  } catch (err) {
    notify_('【出貨】產單失敗', '<p>' + type + ' 產單失敗，訂單狀態與單據編號都沒有變更。</p><pre>' + esc_(err && err.stack || err) + '</pre>', []);
    throw err;
  } finally {
    tmpSheets.forEach(function (s) { try { ss.deleteSheet(s); } catch (e) { /* 已刪除 */ } });
    lock.releaseLock();
  }
}

/** 每家店：複製模板 → 填值 → 跨表公式轉成值 → 第一聯、第二聯各一張工作表 */
function buildInvoices_(ss, groups, today, cfg, tmpSheets) {
  var tpl = mustSheet_(SHEET.INVOICE);
  var out = SpreadsheetApp.create('出貨單_' + today + '_' + Date.now());
  var pages = [Core.parseRowRange(cfg['出貨單第一聯列']), Core.parseRowRange(cfg['出貨單第二聯列'])];
  var lastRow = Math.max(pages[0].end, pages[1].end);
  var dateText = today.replace(/-/g, '/'); // 以文字寫入，由試算表依自身時區解析成日期，不受腳本時區影響

  groups.forEach(function (g, i) {
    var tmp = tpl.copyTo(ss).setName('_tmp_inv_' + i + '_' + Date.now());
    tmpSheets.push(tmp);
    tmp.getRange('L3').setValue(dateText);
    tmp.getRange('M3').setValue(g.store);
    tmp.getRange('H5').setValue(g.orderNo);
    var cd = [], h = [];
    for (var k = 0; k < Core.INVOICE_MAX_LINES; k++) {
      var line = g.lines[k];
      cd.push(line ? [line.product, line.qty] : ['', '']);
      h.push([line ? line.note : '']);
    }
    tmp.getRange('C9:D15').setValues(cd);
    tmp.getRange('H9:H15').setValues(h);
    SpreadsheetApp.flush();
    freezeCrossSheet_(tmp, lastRow, tmp.getLastColumn()); // 含 N3 價格組合

    pages.forEach(function (p, pi) {
      var s = tmp.copyTo(out).setName((i + 1) + '_' + g.store + (pi ? '_第二聯' : '_第一聯'));
      showOnly_(s, p, Number(cfg['列印欄數']));
    });
  });
  dropDefaultSheet_(out);
  return out;
}

/** 貨運單：每 6 家一張模板（L3:L8），每 3 家一頁 */
function buildLabels_(ss, stores, cfg, tmpSheets) {
  var tpl = mustSheet_(SHEET.LABEL);
  var out = SpreadsheetApp.create('貨運單_' + Date.now());
  var pages = [Core.parseRowRange(cfg['貨運單第一頁列']), Core.parseRowRange(cfg['貨運單第二頁列'])];
  var lastRow = Math.max(pages[0].end, pages[1].end);

  Core.chunkLabels(stores).forEach(function (chunk, ci) {
    var tmp = tpl.copyTo(ss).setName('_tmp_lbl_' + ci + '_' + Date.now());
    tmpSheets.push(tmp);
    var names = [];
    for (var k = 0; k < Core.LABELS_PER_SHEET; k++) names.push([chunk[k] || '']);
    tmp.getRange('L3:L8').setValues(names);
    SpreadsheetApp.flush();
    freezeCrossSheet_(tmp, lastRow, tmp.getLastColumn());
    for (var p = 0; p < Core.labelPagesFor(chunk.length); p++) {
      var s = tmp.copyTo(out).setName('標籤_' + (ci * 2 + p + 1));
      showOnly_(s, pages[p], Number(cfg['列印欄數']));
    }
  });
  dropDefaultSheet_(out);
  return out;
}

/** 只把引用其他工作表（廠商清冊）的公式轉成值；同表公式（價格、聯單、圖片）保留 */
function freezeCrossSheet_(sheet, lastRow, lastCol) {
  var rng = sheet.getRange(1, 1, lastRow, lastCol);
  var formulas = rng.getFormulas(), values = rng.getValues();
  for (var r = 0; r < formulas.length; r++) {
    for (var c = 0; c < formulas[r].length; c++) {
      if (formulas[r][c] && formulas[r][c].indexOf('!') >= 0) {
        sheet.getRange(r + 1, c + 1).setValue(values[r][c]);
      }
    }
  }
  SpreadsheetApp.flush();
}

/** 列印時只顯示指定列與 A～I 欄（隱藏的列欄不會出現在 PDF） */
function showOnly_(sheet, page, lastCol) {
  var maxR = sheet.getMaxRows(), maxC = sheet.getMaxColumns();
  if (maxC > lastCol) sheet.hideColumns(lastCol + 1, maxC - lastCol);
  if (page.start > 1) sheet.hideRows(1, page.start - 1);
  if (maxR > page.end) sheet.hideRows(page.end + 1, maxR - page.end);
}

function exportBlob_(ssId, format, params) {
  var url = 'https://docs.google.com/spreadsheets/d/' + ssId + '/export?format=' + format +
    (format === 'pdf' ? '&gridlines=false&printtitle=false&sheetnames=false&pagenum=UNDEFINED&fzr=false&' + (params || '') : '');
  var res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('匯出 ' + format + ' 失敗：HTTP ' + res.getResponseCode());
  return res.getBlob();
}

/** 已過主批次、還沒到截止：有新的待出貨訂單就寄一次 Email 詢問是否補單 */
function askSupplement_(today, props) {
  var cfg = readConfig_();
  var built = Core.buildGroups(readOrders_().rows, {
    today: today, vendors: readVendorNames_(), products: readProducts_(), eligible: splitList_(cfg['10+1適用型號'])
  });
  var ids = [];
  built.groups.forEach(function (g) { ids = ids.concat(g.rowIds); });
  built.errors.forEach(function (e) { ids.push('err:' + e.rowId); });
  if (!ids.length) return;
  var sig = today + '|' + Core.pendingSignature(ids);
  if (props.getProperty('askedSig') === sig) return;
  props.setProperty('askedSig', sig);

  var url = SpreadsheetApp.getActive().getUrl();
  var html = '<p>主批次之後，有以下今天出貨的訂單還沒產單：</p>' + groupsTable_(built.groups) + errorsHtml_(built.errors) +
    '<p><b>是否需要補單？</b></p><ul>' +
    '<li>需要：打開 <a href="' + url + '">華暉出貨自動化</a> →「設定」工作表 → 勾選「' + SUPPLEMENT_KEY + '」（手機也可以），或用選單「華暉出貨 → 產生補單」。</li>' +
    '<li>只有一單、要直接手打：把該列「狀態」改成「已手打」，並更新「單據編號最後流水號」。</li></ul>';
  notify_('【出貨】' + today + ' 有 ' + built.groups.length + ' 家店待補單，是否需要補單？', html, []);
}

/* ───────────── 讀寫工作表 ───────────── */

function readConfig_() {
  var sh = mustSheet_(SHEET.CONFIG);
  var vals = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 2).getValues();
  var cfg = {};
  CONFIG_DEFAULTS.forEach(function (d) { cfg[d[0]] = d[1]; });
  vals.forEach(function (r) {
    if (!r[0]) return;
    var v = r[1];
    if (v instanceof Date) v = Utilities.formatDate(v, TZ, r[0].indexOf('時間') >= 0 ? 'HH:mm' : 'yyyy-MM');
    cfg[r[0]] = v;
  });
  return cfg;
}

function setConfig_(key, value) {
  var sh = mustSheet_(SHEET.CONFIG);
  var keys = sh.getRange(1, 1, sh.getLastRow(), 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (keys[i][0] === key) {
      var cell = sh.getRange(i + 1, 2);
      if (key === '單據編號月份') cell.setNumberFormat('@');
      cell.setValue(value);
      return;
    }
  }
  sh.appendRow([key, value, '']);
}

function readOrders_() {
  var sh = mustSheet_(SHEET.ORDERS);
  var n = sh.getLastRow() - 1;
  var data = n > 0 ? sh.getRange(2, 1, n, ORDER_HEADERS.length).getValues() : [];
  var changedIds = false;
  var rows = data.map(function (r, i) {
    if (!r[COL['訂單ID']] && r[COL['店家']]) { r[COL['訂單ID']] = Utilities.getUuid().slice(0, 8); changedIds = true; }
    if (!r[COL['狀態']] && r[COL['店家']]) { r[COL['狀態']] = '待出貨'; changedIds = true; }
    var d = r[COL['出貨日']];
    return {
      id: String(r[COL['訂單ID']]),
      rowIndex: i + 2,
      shipDate: d instanceof Date ? fmtDate_(d) : String(d || '').trim(),
      store: String(r[COL['店家']] || '').trim(),
      product: String(r[COL['型號']] || '').trim(),
      qty: r[COL['數量']],
      pin8: r[COL['8pin數']],
      note: String(r[COL['附註']] || '').trim(),
      status: String(r[COL['狀態']] || '').trim()
    };
  });
  if (changedIds) {
    sh.getRange(2, COL['訂單ID'] + 1, n, 1).setValues(data.map(function (r) { return [r[COL['訂單ID']]]; }));
    sh.getRange(2, COL['狀態'] + 1, n, 1).setValues(data.map(function (r) { return [r[COL['狀態']]]; }));
  }
  return { sheet: sh, rows: rows };
}

function writeRowMessages_(orders, errors) {
  var msgById = {};
  errors.forEach(function (e) { msgById[e.rowId] = e.message; });
  if (!orders.rows.length) return;
  var col = orders.sheet.getRange(2, COL['系統訊息'] + 1, orders.rows.length, 1);
  var current = col.getValues();
  col.setValues(orders.rows.map(function (r, i) {
    if (msgById[r.id]) return ['⚠ ' + msgById[r.id]];
    return [r.status === '待出貨' ? '' : current[i][0]];
  }));
}

function markGenerated_(orders, groups, batchId) {
  var byId = {};
  orders.rows.forEach(function (r) { byId[r.id] = r; });
  groups.forEach(function (g) {
    g.rowIds.forEach(function (id) {
      var row = byId[id].rowIndex;
      orders.sheet.getRange(row, COL['狀態'] + 1).setValue('已產單');
      orders.sheet.getRange(row, COL['批次'] + 1, 1, 2).setValues([[batchId, g.orderNo]]);
      orders.sheet.getRange(row, COL['系統訊息'] + 1).setValue(g.duplicateVendor ? '⚠ 廠商清冊有同名店家，已套用第一筆資料，請核對' : '');
    });
  });
}

function readVendorNames_() {
  var sh = mustSheet_(SHEET.VENDORS);
  return sh.getRange(2, 3, Math.max(sh.getLastRow() - 1, 1), 1).getValues()
    .map(function (r) { return String(r[0]).trim(); }).filter(String);
}

function readProducts_() {
  return mustSheet_(SHEET.INVOICE).getRange('P3:P103').getValues()
    .map(function (r) { return String(r[0]).trim(); }).filter(String);
}

function readHolidays_() {
  var sh = mustSheet_(SHEET.HOLIDAYS);
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues()
    .map(function (r) { return r[0] instanceof Date ? fmtDate_(r[0]) : String(r[0]).trim(); }).filter(String);
}

function readBatchIds_() {
  var sh = mustSheet_(SHEET.BATCHES);
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]); });
}

/** 從主檔同步廠商清冊（只同步值） */
function syncVendors() {
  var id = readConfig_()['主檔試算表ID'];
  if (!id) throw new Error('請先在「設定」填入主檔試算表ID');
  var src = SpreadsheetApp.openById(id).getSheetByName(SHEET.VENDORS);
  if (!src) throw new Error('主檔找不到「廠商清冊」工作表');
  var values = src.getRange(1, 1, src.getLastRow(), src.getLastColumn()).getValues();
  var dst = mustSheet_(SHEET.VENDORS);
  dst.clearContents();
  if (dst.getMaxColumns() < values[0].length) dst.insertColumnsAfter(dst.getMaxColumns(), values[0].length - dst.getMaxColumns());
  if (dst.getMaxRows() < values.length) dst.insertRowsAfter(dst.getMaxRows(), values.length - dst.getMaxRows());
  dst.getRange(1, 1, values.length, values[0].length).setValues(values);
}

/* ───────────── 初始化 ───────────── */

function setup() {
  var ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(TZ);
  [SHEET.INVOICE, SHEET.LABEL, SHEET.VENDORS].forEach(function (n) {
    if (!ss.getSheetByName(n)) throw new Error('缺少「' + n + '」工作表：請從主檔用「複製到 → 現有試算表」複製過來，並把名稱改回「' + n + '」');
  });

  var cfg = ensureSheet_(SHEET.CONFIG, ['項目', '值', '說明']);
  var existing = cfg.getLastRow() > 1 ? cfg.getRange(2, 1, cfg.getLastRow() - 1, 1).getValues().map(function (r) { return r[0]; }) : [];
  CONFIG_DEFAULTS.forEach(function (d) { if (existing.indexOf(d[0]) < 0) cfg.appendRow(d); });
  var keys = cfg.getRange(1, 1, cfg.getLastRow(), 1).getValues();
  keys.forEach(function (k, i) {
    if (k[0] === SUPPLEMENT_KEY || k[0] === '週六出貨') cfg.getRange(i + 1, 2).insertCheckboxes();
    if (k[0] === '單據編號月份' || String(k[0]).indexOf('時間') >= 0) cfg.getRange(i + 1, 2).setNumberFormat('@');
  });

  var orders = ensureSheet_(SHEET.ORDERS, ORDER_HEADERS);
  var maxR = orders.getMaxRows() - 1;
  orders.getRange(2, COL['出貨日'] + 1, maxR, 1).setNumberFormat('yyyy-mm-dd')
    .setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build());
  orders.getRange(2, COL['店家'] + 1, maxR, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(ss.getSheetByName(SHEET.VENDORS).getRange('C2:C'), true).setAllowInvalid(false).build());
  orders.getRange(2, COL['型號'] + 1, maxR, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(ss.getSheetByName(SHEET.INVOICE).getRange('P3:P103'), true).setAllowInvalid(false).build());
  orders.getRange(2, COL['狀態'] + 1, maxR, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUSES, true).setAllowInvalid(false).build());
  orders.setFrozenRows(1);

  ensureSheet_(SHEET.BATCHES, BATCH_HEADERS);
  ensureSheet_(SHEET.HOLIDAYS, ['日期', '說明']);

  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('onEditInstalled').forSpreadsheet(ss).onEdit().create();
  return '完成';
}

/* ───────────── 通知 ───────────── */

function notify_(subject, html, attachments) {
  var to = String(readConfig_()['通知Email'] || '').trim() || Session.getEffectiveUser().getEmail();
  MailApp.sendEmail({ to: to, subject: subject, htmlBody: html, attachments: attachments, name: '華暉出貨自動化' });
}

function summaryHtml_(built, batchId, url) {
  var warn = built.groups.filter(function (g) { return g.duplicateVendor; })
    .map(function (g) { return '<li>' + esc_(g.store) + '：廠商清冊有同名店家，已套用第一筆資料，請核對</li>'; }).join('');
  return '<p>批次 ' + batchId + '，附件為出貨單與貨運單 PDF（Excel 檔已存在雲端硬碟）。</p>' +
    groupsTable_(built.groups) + (warn ? '<p>⚠ 請注意：</p><ul>' + warn + '</ul>' : '') +
    errorsHtml_(built.errors) + '<p><a href="' + url + '">開啟華暉出貨自動化</a></p>';
}

function groupsTable_(groups) {
  return '<table border="1" cellpadding="4" style="border-collapse:collapse"><tr><th>單據編號</th><th>店家</th><th>品項</th></tr>' +
    groups.map(function (g) {
      return '<tr><td>' + (g.orderNo || '（未編號）') + '</td><td>' + esc_(g.store) + '</td><td>' +
        g.lines.map(function (l) { return esc_(l.product + ' × ' + l.qty + (l.note ? '（' + l.note + '）' : '')); }).join('<br>') +
        '</td></tr>';
    }).join('') + '</table>';
}

function errorsHtml_(errors) {
  if (!errors.length) return '';
  return '<p>⚠ 以下 ' + errors.length + ' 筆資料有誤，沒有產單（請到「出貨清單」的系統訊息欄修正）：</p><ul>' +
    errors.map(function (e) { return '<li>' + esc_(e.rowId + '：' + e.message) + '</li>'; }).join('') + '</ul>';
}

/* ───────────── 工具 ───────────── */

function mustSheet_(name) {
  var s = SpreadsheetApp.getActive().getSheetByName(name);
  if (!s) throw new Error('找不到工作表「' + name + '」，請先執行「初始化」');
  return s;
}

function ensureSheet_(name, headers) {
  var ss = SpreadsheetApp.getActive();
  var s = ss.getSheetByName(name) || ss.insertSheet(name);
  if (s.getLastRow() === 0) s.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  return s;
}

function dropDefaultSheet_(ss) {
  var first = ss.getSheets()[0];
  if (ss.getSheets().length > 1 && /^(Sheet1|工作表1)$/.test(first.getName())) ss.deleteSheet(first);
}

function fmtDate_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }

function splitList_(s) { return String(s || '').split(/[,，]/).map(function (x) { return x.trim(); }).filter(String); }
function truthy_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function esc_(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

function showResult_(res) {
  SpreadsheetApp.getUi().alert(res && res.message ? res.message : '完成');
}
