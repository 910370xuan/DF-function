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
  VENDORS: '廠商清冊',
  ALIASES: '型號對照',
  PARSE_TEST: '解析測試'
};
var ALIAS_HEADERS = ['客戶說法', '型號', 'pin（4 或 8，可空白）'];
var PARSE_HEADERS = ['訊息（貼上客戶訊息）', '店家（可空白）', '有圖片', '判斷', '品項', '備註', '需確認原因', '上一筆訂單建議'];

var ORDER_HEADERS = ['訂單ID', '收單時間', '出貨日', '店家', '型號', '數量', '8pin數', '附註', '狀態', '批次', '單據編號', '來源', '系統訊息', '折讓金額', '已收金額', '確認'];
var COL = {}; ORDER_HEADERS.forEach(function (h, i) { COL[h] = i; });
var STATUSES = ['待出貨', '待確認', '建議', '已產單', '已手打', '暫緩', '取消', '已出貨'];
var BATCH_HEADERS = ['批次ID', '產生時間', '類型', '店家數', '單據編號', '出貨單PDF', '貨運單PDF', '出貨單Excel', '執行者', '貨運單Excel'];
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
  ['輸出Excel', true, '列印用 Excel 檔（出貨單、貨運單），已設定字型、A4、縮放比例、置中'],
  ['Excel字型', '微軟正黑體', 'Excel 列印檔使用的字型（在 Windows 的 Excel 開啟列印）'],
  ['輸出PDF', true, '另存 PDF（手機查看或備份用；PDF 字型與模板相同，無法使用微軟正黑體）'],
  ['出貨單列印列', '1-57', '第一聯＋第二聯印在同一頁（對應原本第 57 列的分頁符號）'],
  ['出貨單列印欄數', 9, 'A～I 欄'],
  ['出貨單清空欄位', 'B17,E17', '模板上手動輸入的欄位（折讓金額、已收金額），產單前清空；是公式則不動'],
  ['貨運單第一頁列', '1-41', '對應原本第 41 列的分頁符號'],
  ['貨運單第二頁列', '42-84', ''],
  ['貨運單列印欄數', 9, 'A～I 欄'],
  ['出貨單縮放比例', 68, '%；與 Google 試算表列印的「依分頁符號自動調整（68%）」相同'],
  ['貨運單縮放比例', 68, '%；貼紙對不準時微調，例如 67 或 69'],
  ['貨運單粗體', true, '貨運單文字全部加粗'],
  ['列印上下邊界', 0.75, '英吋；Google「標準」邊界＝上下 0.75'],
  ['水平對齊', '置中', '置中 或 靠左（與 Google 列印「格式設定 → 對齊 → 橫向」相同）'],
  ['列印左邊界', 0.7, '英吋；只有「靠左」時使用'],
  ['水平微調', 0, '英吋；置中時整體往右移（正數）或往左移（負數），貼紙對位微調用'],
  [SUPPLEMENT_KEY, false, '勾選後立即產生補單（手機也可以）'],
  ['試跑模式', true, 'LINE 訂單寫到「LINE試跑」，不會產單；確認準確後取消勾選，改寫入出貨清單'],
  ['合併等待分鐘', 10, '客戶停止傳訊幾分鐘後，把連續訊息合併成一段處理'],
  ['強制合併時間', '15:50', '這個時間到當日截止之間，不等待、直接處理所有訊息'],
  ['接近截止提醒分鐘', 30, '截止前幾分鐘內下的單標成待確認'],
  ['待確認提醒時間', '15:30', '寄出待確認清單與「不是訂單」訊息清單'],
  ['AI判讀', false, '勾選後，規則判斷不了的訊息交給 Claude 判讀（需先設定金鑰）'],
  ['AI模型', 'claude-opus-5-5', '可改 claude-haiku-5-5（較便宜）'],
  ['AI思考強度', 'low', 'low / medium / high']
];

/* ───────────── 選單與觸發 ───────────── */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('華暉出貨')
    .addItem('產生今日主批次', 'menuMainBatch')
    .addItem('產生補單', 'menuSupplement')
    .addSeparator()
    .addItem('解析測試（貼訊息試辨識）', 'runParseTest')
    .addItem('立即處理 LINE 訊息', 'menuProcessLine')
    .addItem('設定金鑰（LINE／Claude）', 'menuSetKeys')
    .addItem('同步廠商清冊', 'syncVendors')
    .addItem('清理產單暫存試算表', 'cleanupTempSheets')
    .addItem('整理表格外觀', 'menuFormatSheets')
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
  var props = PropertiesService.getScriptProperties();
  try { processLine_(false); } catch (err) { console.error('LINE 訊息處理失敗', err); }
  if (!Core.isShippingDay(today, readHolidays_(), truthy_(cfg['週六出貨']))) return;

  if (hm >= cfg['待確認提醒時間'] && props.getProperty('remindDone') !== today) {
    props.setProperty('remindDone', today);
    try { remindPending_(today); } catch (err) { console.error('提醒失敗', err); }
  }
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
  if (r.getSheet().getName() === SHEET.ORDERS && r.getColumn() <= COL['確認'] + 1 && r.getLastColumn() >= COL['確認'] + 1) {
    handleConfirmEdit_(r);
    return;
  }
  if (r.getSheet().getName() === LINE_SHEET.BIND && r.getColumn() === 3 && r.getRow() > 1 && String(r.getValue()).trim()) {
    applyBinding_(r.getSheet().getRange(r.getRow(), 1).getValue(), String(r.getValue()).trim());
    return;
  }
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
  OUTPUT_TMP_ = [];
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
      var msg = type + '：今日無待出貨訂單' + (built.errors.length ? '（另有 ' + built.errors.length + ' 筆資料有誤，請看「系統訊息」欄）' : '') +
        '\n\n診斷：' + Core.describeDiagnosis(Core.diagnose(orders.rows, today), today);
      if (!opts.manual || built.errors.length) notify_('【出貨】' + today + ' ' + type + '：今日無待出貨訂單', '<p>' + esc_(msg).replace(/\n/g, '<br>') + '</p>', []);
      return { ok: true, message: msg };
    }

    var batchId = Core.nextBatchId(today, readBatchIds_());
    var state = { month: String(cfg['單據編號月份'] || ''), last: Number(cfg['單據編號最後流水號']) || 0 };
    built.groups.forEach(function (g) {
      var r = Core.nextOrderNo(state, today);
      g.orderNo = r.orderNo; state = r.state;
    });

    var base = cfg['輸出資料夾ID'] ? DriveApp.getFolderById(cfg['輸出資料夾ID']) : DriveApp.getRootFolder();
    var folder = subfolder_(base, today.slice(0, 7)); // 每月一個資料夾，例如 2026-11
    var invSS = buildInvoices_(ss, built.groups, today, cfg, tmpSheets);
    var lblSS = buildLabels_(ss, built.groups.map(function (g) { return g.store; }), cfg, tmpSheets);

    var name = batchId + '_' + type;
    var invParams = printParams_(mustSheet_(SHEET.INVOICE), Number(cfg['出貨單列印欄數']) || 9, cfg['出貨單縮放比例'], cfg);
    var lblParams = printParams_(mustSheet_(SHEET.LABEL), Number(cfg['貨運單列印欄數']) || 9, cfg['貨運單縮放比例'], cfg);
    var wantPdf = truthy_(cfg['輸出PDF']), wantXlsx = truthy_(cfg['輸出Excel']);
    if (!wantPdf && !wantXlsx) wantXlsx = true;
    var xlsxOpt = function (pct) {
      return { font: String(cfg['Excel字型'] || '').trim(), scale: Number(pct) || 68, center: String(cfg['水平對齊']).trim() !== '靠左',
        margins: { top: Number(cfg['列印上下邊界']) || 0.75, bottom: Number(cfg['列印上下邊界']) || 0.75 } };
    };
    var invPdf = wantPdf ? folder.createFile(exportBlob_(invSS.getId(), 'pdf', invParams).setName('出貨單_' + name + '.pdf')) : null;
    var lblPdf = wantPdf ? folder.createFile(exportBlob_(lblSS.getId(), 'pdf', lblParams).setName('貨運單_' + name + '.pdf')) : null;
    var invXlsx = wantXlsx ? folder.createFile(printXlsx_(invSS.getId(), '出貨單_' + name + '.xlsx', xlsxOpt(cfg['出貨單縮放比例']))) : null;
    var lblXlsx = wantXlsx ? folder.createFile(printXlsx_(lblSS.getId(), '貨運單_' + name + '.xlsx',
      Object.assign(xlsxOpt(cfg['貨運單縮放比例']), { bold: truthy_(cfg['貨運單粗體']) }))) : null;
    var url = function (f) { return f ? f.getUrl() : ''; };
    var attachments = [invXlsx, lblXlsx, invPdf, lblPdf].filter(Boolean).map(function (f) { return f.getBlob(); });

    // 全部成功才寫回：編號、訂單狀態、批次紀錄
    setConfig_('單據編號月份', state.month);
    setConfig_('單據編號最後流水號', state.last);
    markGenerated_(orders, built.groups, batchId);
    ss.getSheetByName(SHEET.BATCHES).appendRow([
      batchId, new Date(), type, built.groups.length,
      built.groups.map(function (g) { return g.orderNo; }).join(', '),
      url(invPdf), url(lblPdf), url(invXlsx),
      Session.getEffectiveUser().getEmail(), url(lblXlsx)
    ]);

    notify_('【出貨】' + today + ' ' + type + ' ' + batchId + '：' + built.groups.length + ' 家店',
      summaryHtml_(built, batchId, ss.getUrl()), attachments);
    return { ok: true, message: type + ' ' + batchId + ' 完成：' + built.groups.length + ' 家店' };
  } catch (err) {
    notify_('【出貨】產單失敗', '<p>' + type + ' 產單失敗，訂單狀態與單據編號都沒有變更。</p><pre>' + esc_(err && err.stack || err) + '</pre>', []);
    throw err;
  } finally {
    tmpSheets.forEach(function (s) { try { ss.deleteSheet(s); } catch (e) { /* 已刪除 */ } });
    // 產 PDF 用的暫存試算表用完就丟進垃圾桶（30 天內可從垃圾桶還原）
    OUTPUT_TMP_.forEach(function (id) { try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { /* 已刪除 */ } });
    OUTPUT_TMP_ = [];
    lock.releaseLock();
  }
}

/** 每家店：複製模板 → 填值 → 跨表公式轉成值 → 一張工作表（第一聯＋第二聯同一頁） */
function buildInvoices_(ss, groups, today, cfg, tmpSheets) {
  var tpl = mustSheet_(SHEET.INVOICE);
  var out = newOutput_(ss, '出貨單_' + today + '_' + Date.now());
  var page = Core.parseRowRange(cfg['出貨單列印列']);
  var lastCol = Number(cfg['出貨單列印欄數']) || 9;
  var lastRow = Math.max(page.end, 70);
  var clearCells = splitList_(cfg['出貨單清空欄位']);
  var dateText = today.replace(/-/g, '/'); // 以文字寫入，由試算表依自身時區解析成日期，不受腳本時區影響

  groups.forEach(function (g, i) {
    var tmp = tpl.copyTo(ss).setName('_tmp_inv_' + i + '_' + Date.now());
    tmpSheets.push(tmp);
    tmp.getRange('L3').setValue(dateText);
    tmp.getRange('M3').setValue(g.store);
    tmp.getRange('H5').setValue(g.orderNo);
    clearCells.forEach(function (a) {
      var c = tmp.getRange(a);
      if (!c.getFormula()) c.clearContent(); // 清掉上一張單留下的手動輸入（例如折讓金額）
    });
    if (g.discount > 0) tmp.getRange('B17').setValue(g.discount);
    if (g.paid > 0) tmp.getRange('E17').setValue(g.paid);
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

    var s = tmp.copyTo(out).setName((i + 1) + '_' + g.store);
    freezeAll_(s, page, lastCol);
    showOnly_(s, page, lastCol);
  });
  dropDefaultSheet_(out);
  return out;
}

/** 貨運單：每 6 家一張模板（L3:L8），每 3 家一頁 */
function buildLabels_(ss, stores, cfg, tmpSheets) {
  var tpl = mustSheet_(SHEET.LABEL);
  var out = newOutput_(ss, '貨運單_' + Date.now());
  var pages = [Core.parseRowRange(cfg['貨運單第一頁列']), Core.parseRowRange(cfg['貨運單第二頁列'])];
  var lastRow = Math.max(pages[0].end, pages[1].end);
  var lastCol = Number(cfg['貨運單列印欄數']) || 9;

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
      applyFont_(s, pages[p], lastCol, '', truthy_(cfg['貨運單粗體']));
      showOnly_(s, pages[p], lastCol);
    }
  });
  dropDefaultSheet_(out);
  return out;
}

/**
 * 產單用的新試算表：地區設定、時區、主題字型都跟原本的試算表一樣。
 * 新建的試算表預設地區可能不是台灣，中文字會被換成別的字型，所以要先對齊。
 */
var OUTPUT_TMP_ = [];

function newOutput_(ss, name) {
  var out = SpreadsheetApp.create(name);
  OUTPUT_TMP_.push(out.getId());
  out.setSpreadsheetLocale(ss.getSpreadsheetLocale());
  out.setSpreadsheetTimeZone(ss.getSpreadsheetTimeZone());
  try {
    var theme = ss.getSpreadsheetTheme();
    if (theme) {
      var t = out.resetSpreadsheetTheme();
      t.setFontFamily(theme.getFontFamily());
    }
  } catch (e) { /* 主題不支援時沿用預設 */ }
  return out;
}

/** 匯出 Excel 並套用列印設定（字型、縮放、置中） */
function printXlsx_(ssId, fileName, opt) {
  var blobs = Utilities.unzip(exportBlob_(ssId, 'xlsx', '').setContentType('application/zip'));
  var out = blobs.map(function (b) {
    var n = b.getName();
    if (n === 'xl/styles.xml' || n === 'xl/sharedStrings.xml' || Xlsx.isSheetPath(n)) {
      var patched = Xlsx.patchFiles([{ name: n, text: b.getDataAsString('UTF-8') }], opt)[0].text;
      return Utilities.newBlob(patched, 'application/xml', n);
    }
    return b;
  });
  out.sort(function (a, b) { return a.getName() === '[Content_Types].xml' ? -1 : b.getName() === '[Content_Types].xml' ? 1 : 0; });
  return Utilities.zip(out, fileName).setContentType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

/** 出貨單列印範圍內的公式全部轉成值（Excel 開啟時不會重算出不同結果，例如 DATEVALUE） */
function freezeAll_(sheet, page, lastCol) {
  var rng = sheet.getRange(page.start, 1, page.end - page.start + 1, lastCol);
  var f = rng.getFormulas();
  if (!f.some(function (r) { return r.some(String); })) return;
  rng.setValues(rng.getValues());
}

function subfolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** 清掉之前版本留下的產單暫存試算表（只比對系統產生的檔名格式） */
function cleanupTempSheets() {
  var re = /^(出貨單_\d{4}-\d{2}-\d{2}_\d{10,}|貨運單_\d{10,})$/;
  var it = DriveApp.searchFiles("mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false and 'me' in owners and (title contains '出貨單_' or title contains '貨運單_')");
  var n = 0;
  while (it.hasNext()) {
    var f = it.next();
    if (re.test(f.getName())) { f.setTrashed(true); n++; }
  }
  showResult_({ message: '已把 ' + n + ' 個暫存試算表移到垃圾桶（30 天內可還原）。PDF 與 Excel 檔不受影響。' });
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

/** 列印時只顯示指定列與欄（隱藏的列欄不會出現在 PDF）；列印範圍外的浮動圖片移除 */
/** 只套用在產出的 PDF，不會改到模板 */
function applyFont_(sheet, page, lastCol, font, bold) {
  var rng = sheet.getRange(page.start, 1, page.end - page.start + 1, lastCol);
  if (String(font || '').trim()) rng.setFontFamily(String(font).trim());
  if (bold) rng.setFontWeight('bold');
}

function showOnly_(sheet, page, lastCol) {
  sheet.getImages().forEach(function (img) {
    var a = img.getAnchorCell();
    if (a.getColumn() > lastCol || a.getRow() < page.start || a.getRow() > page.end) img.remove();
  });
  var maxR = sheet.getMaxRows(), maxC = sheet.getMaxColumns();
  if (maxC > lastCol) sheet.hideColumns(lastCol + 1, maxC - lastCol);
  if (page.start > 1) sheet.hideRows(1, page.start - 1);
  if (maxR > page.end) sheet.hideRows(page.end + 1, maxR - page.end);
}

/**
 * 固定縮放比例：PDF 匯出只能「符合寬度」，所以用欄寬算出右邊界，
 * 讓 A～I 欄縮放後剛好等於指定比例（A4 寬 8.27 英吋，96 像素＝1 英吋）。
 */
function printParams_(tplSheet, lastCol, pct, cfg) {
  var px = 0;
  for (var c = 1; c <= lastCol; c++) px += tplSheet.getColumnWidth(c);
  var scale = (Number(pct) || 68) / 100;
  var tb = Number(cfg['列印上下邊界']);
  if (isNaN(tb)) tb = 0.75;
  var contentW = px * scale / 96; // 縮放後內容寬度（英吋）
  var left;
  if (String(cfg['水平對齊']).trim() === '靠左') {
    left = Number(cfg['列印左邊界']);
    if (isNaN(left)) left = 0.7;
  } else {
    // 置中：左右留白相同，再加上微調
    left = (8.27 - contentW) / 2 + (Number(cfg['水平微調']) || 0);
  }
  var right = 8.27 - left - contentW;
  if (left < 0 || right < 0) throw new Error('縮放 ' + pct + '% 時內容超出紙張，請調小縮放比例或水平微調');
  return 'size=A4&portrait=true&scale=2&top_margin=' + tb + '&bottom_margin=' + tb +
    '&left_margin=' + left.toFixed(3) + '&right_margin=' + right.toFixed(3) + '&horizontal_alignment=CENTER&vertical_alignment=TOP';
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
    if (isDate_(v)) v = Utilities.formatDate(v, TZ, r[0].indexOf('時間') >= 0 ? 'HH:mm' : 'yyyy-MM');
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
      shipDate: isDate_(d) ? fmtDate_(d) : Core.normalizeDate(d),
      store: String(r[COL['店家']] || '').trim(),
      product: String(r[COL['型號']] || '').trim(),
      qty: r[COL['數量']],
      pin8: r[COL['8pin數']],
      note: String(r[COL['附註']] || '').trim(),
      discount: r[COL['折讓金額']],
      paid: r[COL['已收金額']],
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
    .map(function (r) { return isDate_(r[0]) ? fmtDate_(r[0]) : Core.normalizeDate(r[0]); }).filter(String);
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

/* ───────────── 訊息解析（第二階段的規則層，先提供測試用） ───────────── */

function readAliases_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(SHEET.ALIASES);
  if (!sh || sh.getLastRow() < 2) return Parser.DEFAULT_ALIASES;
  return sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues()
    .filter(function (r) { return String(r[0]).trim() && String(r[1]).trim(); })
    .map(function (r) { return { alias: String(r[0]).trim(), product: String(r[1]).trim(), pin: Number(r[2]) || 0 }; });
}

/** 歷史訂單：出貨清單 ＋（有設定主檔時）主檔「庫存管理」的出庫紀錄 */
function readHistory_() {
  var hist = readOrders_().rows
    .filter(function (r) { return r.store && r.product; })
    .map(function (r) { return { store: r.store, product: r.product, qty: r.qty, date: r.shipDate }; });
  var id = readConfig_()['主檔試算表ID'];
  if (id) {
    var sh = SpreadsheetApp.openById(id).getSheetByName('庫存管理');
    if (sh && sh.getLastRow() > 2) {
      // A 日期、C 出庫、D 商品名稱、E 數量、G 出貨渠道、H 客戶名稱
      sh.getRange(3, 1, sh.getLastRow() - 2, 8).getValues().forEach(function (r) {
        if (r[2] !== '出庫' || !r[7] || !r[3] || r[6] === '特贈') return;
        hist.push({ store: String(r[7]).trim(), product: String(r[3]).trim(), qty: r[4], date: isDate_(r[0]) ? fmtDate_(r[0]) : Core.normalizeDate(r[0]) });
      });
    }
  }
  return hist;
}

function runParseTest() {
  var sh = ensureSheet_(SHEET.PARSE_TEST, PARSE_HEADERS);
  var n = sh.getLastRow() - 1;
  if (n < 1) { showResult_({ message: '請在「解析測試」A 欄貼上客戶訊息（一格一段對話），再執行一次' }); return; }
  var aliases = readAliases_(), today = fmtDate_(new Date());
  var history = null;
  var kindText = { order: '✅ 明確訂單', unclear: '⚠ 待確認', not_order: '— 不是訂單' };
  var input = sh.getRange(2, 1, n, 3).getValues();
  var out = input.map(function (r) {
    if (!String(r[0]).trim()) return ['', '', '', '', ''];
    var res = Parser.parse(r[0], { aliases: aliases, hasImage: r[2] === true, today: today });
    var sug = '';
    if (res.vague && String(r[1]).trim()) {
      history = history || readHistory_();
      var h = Parser.suggestFromHistory(String(r[1]).trim(), history);
      sug = h ? h.product + ' × ' + h.qty + '（' + h.date + '）' : '查無這家店的歷史訂單';
    }
    return [
      kindText[res.kind],
      res.items.map(function (it) { return it.product + ' × ' + it.qty + (it.pin8 ? '（8pin ' + it.pin8 + '）' : ''); }).join('\n'),
      res.notes.join('、'),
      res.reasons.join('\n'),
      sug
    ];
  });
  sh.getRange(2, 4, n, 5).setValues(out);
  showResult_({ message: '解析完成：' + out.filter(function (o) { return o[0]; }).length + ' 筆' });
}

/* ───────────── 初始化 ───────────── */

function setup() {
  var ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(TZ);
  [SHEET.INVOICE, SHEET.LABEL, SHEET.VENDORS].forEach(function (n) {
    if (!ss.getSheetByName(n)) throw new Error('缺少「' + n + '」工作表：請從主檔用「複製到 → 現有試算表」複製過來，並把名稱改回「' + n + '」');
  });

  var cfg = ensureSheet_(SHEET.CONFIG, ['項目', '值', '說明']);
  var obsolete = ['出貨單第一聯列', '出貨單第二聯列', '列印欄數', '出貨單PDF參數', '貨運單PDF參數', '出貨單列印設定', '貨運單列印設定', 'PDF字型', '出貨單字型', '貨運單字型'];
  // 上一版預設字型 Noto Sans TC 會讓版面跑掉：只清除一次，之後使用者自己填的不再更動
  var sp = PropertiesService.getScriptProperties();
  if (!sp.getProperty('fontReset1')) {
    for (var rf = 2; rf <= cfg.getLastRow(); rf++) {
      var kf = cfg.getRange(rf, 1).getValue();
      if ((kf === '出貨單字型' || kf === '貨運單字型') && cfg.getRange(rf, 2).getValue() === 'Noto Sans TC') {
        cfg.getRange(rf, 2, 1, 2).setValues([['', '空白＝與模板相同（建議）。換字型可能讓字變高、版面跑掉；Google 產 PDF 無法使用微軟正黑體']]);
      }
    }
    sp.setProperty('fontReset1', '1');
  }
  // 舊版預設的貨運單欄數 10 改為 9（A～I）
  for (var rj = 2; rj <= cfg.getLastRow(); rj++) {
    if (cfg.getRange(rj, 1).getValue() === '貨運單列印欄數' && Number(cfg.getRange(rj, 2).getValue()) === 10) cfg.getRange(rj, 2, 1, 2).setValues([[9, 'A～I 欄']]);
  }
  for (var ri = cfg.getLastRow(); ri >= 2; ri--) {
    if (obsolete.indexOf(cfg.getRange(ri, 1).getValue()) >= 0) cfg.deleteRow(ri);
  }
  var existing = cfg.getLastRow() > 1 ? cfg.getRange(2, 1, cfg.getLastRow() - 1, 1).getValues().map(function (r) { return r[0]; }) : [];
  CONFIG_DEFAULTS.forEach(function (d) { if (existing.indexOf(d[0]) < 0) cfg.appendRow(d); });
  var keys = cfg.getRange(1, 1, cfg.getLastRow(), 1).getValues();
  keys.forEach(function (k, i) {
    if ([SUPPLEMENT_KEY, '週六出貨', '試跑模式', 'AI判讀', '輸出Excel', '輸出PDF', '貨運單粗體'].indexOf(k[0]) >= 0) cfg.getRange(i + 1, 2).insertCheckboxes();
    if (k[0] === '單據編號月份' || String(k[0]).indexOf('時間') >= 0) cfg.getRange(i + 1, 2).setNumberFormat('@');
  });

  var orders = ensureSheet_(SHEET.ORDERS, ORDER_HEADERS);
  // 舊版工作表補上新增的欄位標題（只加在最後，不移動既有資料）
  var have = orders.getRange(1, 1, 1, Math.max(orders.getLastColumn(), 1)).getValues()[0];
  ORDER_HEADERS.forEach(function (h, i) {
    if (have[i] !== h) {
      if (have[i]) throw new Error('「出貨清單」第 ' + (i + 1) + ' 欄標題應為「' + h + '」，目前是「' + have[i] + '」，請勿移動欄位順序');
      orders.getRange(1, i + 1).setValue(h).setFontWeight('bold');
    }
  });
  orders.getRange(2, COL['折讓金額'] + 1, orders.getMaxRows() - 1, 2).setNumberFormat('#,##0');
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

  var bh = ensureSheet_(SHEET.BATCHES, BATCH_HEADERS);
  bh.getRange(1, 1, 1, BATCH_HEADERS.length).setValues([BATCH_HEADERS]).setFontWeight('bold');
  var al = ensureSheet_(SHEET.ALIASES, ALIAS_HEADERS);
  if (al.getLastRow() < 2) {
    al.getRange(2, 1, Parser.DEFAULT_ALIASES.length, 3).setValues(Parser.DEFAULT_ALIASES.map(function (a) { return [a.alias, a.product, a.pin || '']; }));
  } else {
    var haveAlias = al.getRange(2, 1, al.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]).trim().toUpperCase(); });
    Parser.DEFAULT_ALIASES.forEach(function (a) {
      if (Parser.ADDED_ALIASES.indexOf(a.alias) >= 0 && haveAlias.indexOf(a.alias.toUpperCase()) < 0) al.appendRow([a.alias, a.product, a.pin || '']);
    });
  }
  var pt = ensureSheet_(SHEET.PARSE_TEST, PARSE_HEADERS);
  pt.getRange(2, 3, pt.getMaxRows() - 1, 1).insertCheckboxes();
  pt.getRange(2, 1, pt.getMaxRows() - 1, 8).setWrap(true).setVerticalAlignment('top');
  ensureSheet_(SHEET.HOLIDAYS, ['日期', '說明']);
  ensureSheet_(LINE_SHEET.LOG, LOG_HEADERS).setFrozenRows(1);
  var trial = ensureSheet_(LINE_SHEET.TRIAL, ORDER_HEADERS);
  trial.setFrozenRows(1);
  trial.getRange(2, COL['出貨日'] + 1, trial.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd');
  var bind = ensureSheet_(LINE_SHEET.BIND, BIND_HEADERS);
  bind.getRange(1, 1, 1, BIND_HEADERS.length).setValues([BIND_HEADERS]).setFontWeight('bold');
  bind.setFrozenRows(1);
  bind.getRange(2, 3, bind.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(ss.getSheetByName(SHEET.VENDORS).getRange('C2:C'), true).setAllowInvalid(false).build());

  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('onEditInstalled').forSpreadsheet(ss).onEdit().create();
  formatSheets_();
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
  return '<p>批次 ' + batchId + '，附件為出貨單與貨運單。<b>列印請用 Excel 檔</b>（已設定微軟正黑體、A4、縮放比例與置中，用 Excel 開啟後直接列印「整本活頁簿」）；PDF 供手機查看或備份。</p>' +
    groupsTable_(built.groups) + (warn ? '<p>⚠ 請注意：</p><ul>' + warn + '</ul>' : '') +
    errorsHtml_(built.errors) + '<p><a href="' + url + '">開啟華暉出貨自動化</a></p>';
}

function groupsTable_(groups) {
  return '<table border="1" cellpadding="4" style="border-collapse:collapse"><tr><th>單據編號</th><th>店家</th><th>品項</th></tr>' +
    groups.map(function (g) {
      return '<tr><td>' + (g.orderNo || '（未編號）') + '</td><td>' + esc_(g.store) + '</td><td>' +
        g.lines.map(function (l) { return esc_(l.product + ' × ' + l.qty + (l.note ? '（' + l.note + '）' : '')); }).join('<br>') +
        (g.discount ? '<br>折讓 ' + g.discount : '') + (g.paid ? '<br>已收 ' + g.paid : '') +
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

/** 試算表日期值；不用 instanceof，避免跨環境判斷失敗 */
function isDate_(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }

function fmtDate_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }

function splitList_(s) { return String(s || '').split(/[,，]/).map(function (x) { return x.trim(); }).filter(String); }
function truthy_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function esc_(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

function showResult_(res) {
  SpreadsheetApp.getUi().alert(res && res.message ? res.message : '完成');
}
