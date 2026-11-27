/* 華暉出貨自動化：請整份貼進 Apps Script 的 Code.gs（取代原本內容）。由 scripts/bundle.js 產生，請勿手改。 */

var APP_VERSION = '2026-11-27 08:28';

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

  function storeKey(name) {
    return String(name || '').replace(/[\(（][^\)）]*[\)）]/g, '').replace(/\s+/g, '').trim();
  }

  /**
   * 把店名對應到廠商清冊上現在的名稱：完全相同優先；否則去掉括號註記後只有一家相符時採用。
   * 例：綁定時是「信耀車業」，清冊改名「信耀車業(午後收貨)」→ 仍對得上。
   */
  function resolveVendor(name, vendors) {
    var n = String(name || '').trim();
    if (!n) return '';
    if ((vendors || []).indexOf(n) >= 0) return n;
    var key = storeKey(n), hits = [];
    (vendors || []).forEach(function (v) { if (storeKey(v) === key && hits.indexOf(v) < 0) hits.push(v); });
    return hits.length === 1 ? hits[0] : '';
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
      var canonical = resolveVendor(r.store, opts.vendors);
      if (canonical && canonical !== r.store) r = Object.assign({}, r, { store: canonical });
      opts_combos = opts.combos ? toSet(opts.combos) : null;
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
        priceCombo: (list.filter(function (r) { return r.priceCombo; })[0] || {}).priceCombo || '',
        discount: sumAmount(list, 'discount'),
        paid: sumAmount(list, 'paid'),
        lines: merged.map(function (m) {
          return { product: m.product, qty: m.qty, note: buildNote(m, opts.eligible) };
        })
      });
    });
    return { groups: groups, errors: errors };
  }

  /** 金額欄可空白；有填就必須是 0 以上的數字（可含千分位逗號） */
  function toAmount(v) {
    if (v === '' || v == null) return 0;
    var n = Number(String(v).replace(/[,，\s]/g, ''));
    return n;
  }

  function isAmount(v) {
    var n = toAmount(v);
    return !isNaN(n) && n >= 0;
  }

  /** 同一家店同一批的折讓／已收金額加總（填在任一列皆可） */
  function sumAmount(list, key) {
    return list.reduce(function (acc, r) { return acc + toAmount(r[key]); }, 0);
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

  var opts_combos = null;
  function validateRow(r, vendorSet, productSet) {
    if (!r.store) return '缺少店家';
    if (!vendorSet[r.store]) return '店家不在廠商清冊：' + r.store;
    if (!r.product) return '缺少型號';
    if (!productSet[r.product]) return '型號不在出貨單價格表：' + r.product;
    var q = Number(r.qty);
    if (!(q > 0) || Math.floor(q) !== q) return '數量必須是正整數';
    var p8 = Number(r.pin8) || 0;
    if (p8 < 0 || p8 > q || Math.floor(p8) !== p8) return '8pin 數量不正確';
    if (r.priceCombo && opts_combos && !opts_combos[r.priceCombo]) return '價格組合不在出貨單價格表：' + r.priceCombo;
    if (!isAmount(r.discount)) return '折讓金額必須是 0 以上的數字';
    if (!isAmount(r.paid)) return '已收金額必須是 0 以上的數字';
    return '';
  }

  /**
   * 文字日期轉成 'YYYY-MM-DD'；接受 2026/11/17、2026-11-17、2026.11.17、民國 115/11/17。
   * 無法辨識回傳 ''。
   */
  function normalizeDate(s) {
    var m = String(s == null ? '' : s).trim().match(/^(\d{2,4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
    if (!m) return '';
    var y = Number(m[1]);
    if (m[1].length <= 3) y += 1911;
    var mo = Number(m[2]), d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    return y + '-' + pad(mo, 2) + '-' + pad(d, 2);
  }

  /** 沒有產出任何出貨單時，說明每一列被略過的原因 */
  function diagnose(rows, today) {
    var out = { total: 0, byStatus: {}, noDate: 0, future: [], ready: 0 };
    rows.forEach(function (r) {
      if (!r.store && !r.product && !r.qty) return;
      out.total++;
      var st = r.status || '（空白）';
      out.byStatus[st] = (out.byStatus[st] || 0) + 1;
      if (r.status !== '待出貨') return;
      if (!r.shipDate) out.noDate++;
      else if (r.shipDate > today) out.future.push(r.shipDate);
      else out.ready++;
    });
    return out;
  }

  function describeDiagnosis(d, today) {
    if (!d.total) return '「出貨清單」工作表沒有讀到任何訂單列（請確認是填在「出貨清單」第 2 列以下，且有填店家）。';
    var parts = ['讀到 ' + d.total + ' 筆訂單列'];
    var st = Object.keys(d.byStatus).map(function (k) { return k + ' ' + d.byStatus[k] + ' 筆'; }).join('、');
    parts.push('狀態：' + st);
    if (d.noDate) parts.push(d.noDate + ' 筆「待出貨」沒有出貨日或日期格式無法辨識');
    if (d.future.length) parts.push(d.future.length + ' 筆出貨日在今天（' + today + '）之後：' + d.future.slice(0, 5).join('、'));
    return parts.join('；') + '。';
  }

  /**
   * 庫存管理出庫紀錄（照主檔「庫存管理」A～K 欄格式）：
   * 日期、入庫、出庫、商品名稱、數量、建檔人員、出貨渠道、客戶名稱、收款狀況、備註、實收金額
   * 每行品項一列；10+1 的贈品另起一列「特贈」。
   * g: { store, orderNo, lines:[{product, qty, subtotal}] }
   */
  function ledgerRows(g, date, opts) {
    opts = opts || {};
    var rows = [];
    g.lines.forEach(function (l) {
      rows.push([date, '', '出庫', l.product, l.qty, opts.staff || '系統', opts.channel || 'B2B廠商', g.store, opts.pay || '',
        '單據 ' + g.orderNo + (opts.batchId ? '／批次 ' + opts.batchId : ''), l.subtotal === '' || l.subtotal == null ? '' : Number(l.subtotal) || 0]);
      var gift = giftQty(l.qty, l.product, opts.eligible);
      if (gift > 0) rows.push([date, '', '出庫', l.product, gift, opts.staff || '系統', '特贈', g.store, '', '10+1 贈品／單據 ' + g.orderNo, '']);
    });
    return rows;
  }

  /**
   * 主檔「N月電力盒回收統計」：在 A 欄找各月份區塊。
   * colA：A 欄值（由第 1 列起）→ [{ month, titleRow, headerRow, firstRow, subtotalRow }]（列號從 1 起）
   */
  function findRecycleBlocks(colA) {
    var blocks = [];
    for (var i = 0; i < colA.length; i++) {
      var m = String(colA[i] == null ? '' : colA[i]).match(/(\d{1,2})\s*月.*回收/);
      if (!m) continue;
      var b = { month: Number(m[1]), titleRow: i + 1, headerRow: i + 2, firstRow: i + 3, subtotalRow: 0 };
      for (var j = i + 2; j < colA.length; j++) {
        if (String(colA[j]).replace(/\s/g, '') === '小計') { b.subtotalRow = j + 1; break; }
        if (/(\d{1,2})\s*月.*回收/.test(String(colA[j]))) break;
      }
      blocks.push(b);
    }
    return blocks;
  }

  /**
   * 在「小計」上方插入一列後，小計公式的範圍不會自動包含新列（例如 SUM(C3:C13) 插在第 14 列）。
   * 把結尾是 lastRow 的範圍延伸到 lastRow + 1。
   */
  function extendRangeEnd(formula, lastRow) {
    return String(formula).replace(/(\$?[A-Z]{1,3}\$?)(\d+)(\s*:\s*)(\$?[A-Z]{1,3}\$?)(\d+)/g, function (all, c1, r1, sep, c2, r2) {
      return Number(r2) === lastRow ? c1 + r1 + sep + c2 + (lastRow + 1) : all;
    });
  }

  /** 依標題列找欄位位置（從 0 起），找不到為 -1 */
  function recycleColumns(header) {
    var find = function (re) { for (var i = 0; i < header.length; i++) if (re.test(String(header[i]))) return i; return -1; };
    return { date: find(/回收日期/), store: find(/客戶名稱/), qty: find(/完整版.*數量/), total: find(/總金額/), note: find(/備註/), done: find(/已匯款|已折抵|匯款\s*\/\s*折抵/) };
  }

  /**
   * 要在這次出貨單折抵的回收：備註含「折貨款」、打勾欄未勾、還沒被系統折抵過（備註沒有「已於」）
   * rows：[{ row, store, total, note, done }]
   */
  function recycleCredits(rows, store) {
    var key = storeKey(store);
    return rows.filter(function (r) {
      return r.store && storeKey(r.store) === key && /折貨款/.test(String(r.note)) && r.done !== true &&
        !/已於/.test(String(r.note)) && Number(r.total) > 0;
    });
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

  function addDays(dateStr, n) {
    var p = parseDate(dateStr);
    var d = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1, 2) + '-' + pad(d.getUTCDate(), 2);
  }

  function nextShippingDay(dateStr, holidays, shipSaturday) {
    var d = addDays(dateStr, 1);
    for (var i = 0; i < 30 && !isShippingDay(d, holidays, shipSaturday); i++) d = addDays(d, 1);
    return d;
  }

  /**
   * 推定出貨日：出貨日的截止時間前收到 → 當天；否則下一個出貨日。
   * 截止前 nearMinutes 分鐘內收到的標記為「接近截止」，請客服判斷。
   * opts: { holidays, shipSaturday, cutoff: '16:00', nearMinutes: 30 }
   */
  function inferShipDate(dateStr, hm, opts) {
    opts = opts || {};
    var cutoff = opts.cutoff || '16:00';
    var holidays = opts.holidays || [];
    var near = false, date;
    if (isShippingDay(dateStr, holidays, opts.shipSaturday) && hm < cutoff) {
      date = dateStr;
      var c = cutoff.split(':').map(Number), h = hm.split(':').map(Number);
      near = (c[0] * 60 + c[1]) - (h[0] * 60 + h[1]) <= (opts.nearMinutes == null ? 30 : opts.nearMinutes);
    } else {
      date = nextShippingDay(dateStr, holidays, opts.shipSaturday);
    }
    return { date: date, nearCutoff: near };
  }

  /**
   * 合併對話：同一位客戶最後一則訊息已安靜 quietMs 以上（或 force），整段送出解析。
   * msgs: [{userId, ts, ...}]（皆為未處理） → [{userId, msgs:[...] }]（依時間排序）
   */
  function readySegments(msgs, nowMs, quietMs, force) {
    var byUser = {}, order = [];
    msgs.forEach(function (m) {
      if (!byUser[m.userId]) { byUser[m.userId] = []; order.push(m.userId); }
      byUser[m.userId].push(m);
    });
    var out = [];
    order.forEach(function (u) {
      var list = byUser[u].slice().sort(function (a, b) { return a.ts - b.ts; });
      var last = list[list.length - 1].ts;
      if (force || nowMs - last >= quietMs) out.push({ userId: u, msgs: list });
    });
    return out;
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
    ledgerRows: ledgerRows,
    findRecycleBlocks: findRecycleBlocks,
    recycleColumns: recycleColumns,
    extendRangeEnd: extendRangeEnd,
    recycleCredits: recycleCredits,
    mergeSameProduct: mergeSameProduct,
    chunkLabels: chunkLabels,
    labelPagesFor: labelPagesFor,
    isShippingDay: isShippingDay,
    nextBatchId: nextBatchId,
    storeKey: storeKey,
    resolveVendor: resolveVendor,
    addDays: addDays,
    nextShippingDay: nextShippingDay,
    inferShipDate: inferShipDate,
    readySegments: readySegments,
    pendingSignature: pendingSignature,
    findDuplicates: findDuplicates,
    normalizeDate: normalizeDate,
    diagnose: diagnose,
    describeDiagnosis: describeDiagnosis,
    parseRowRange: parseRowRange
  };
})();

if (typeof module !== 'undefined') module.exports = Core;


/**
 * 規則解析：把 LINE 訊息（已合併的一段對話）轉成品項與數量。
 * 只處理有把握的寫法；不確定的一律標記原因，交給 AI 或客服確認，不猜。
 */
var Parser = (function () {
  /** 預設型號對照（試算表「型號對照」可增修）。pin：4 / 8 表示同時指定 DCB-6000 的 pin 數 */
  var DEFAULT_ALIASES = [
    ['GPB-2000A', 'GPB-2000A'], ['A款', 'GPB-2000A'], ['2000A', 'GPB-2000A'],
    ['GPB-2000S', 'GPB-2000S'], ['S款', 'GPB-2000S'], ['2000S', 'GPB-2000S'],
    ['GPB-2000', 'GPB-2000'], ['GPB2000', 'GPB-2000'], ['一般的', 'GPB-2000'], ['2000', 'GPB-2000'],
    ['GBP-2000A', 'GPB-2000A'], ['GBP-2000S', 'GPB-2000S'], ['GBP-2000', 'GPB-2000'], ['GBP2000', 'GPB-2000'],
    ['DCB-6000', 'DCB-6000'], ['DCB6000', 'DCB-6000'], ['GPB-6000', 'DCB-6000'], ['6000', 'DCB-6000'],
    ['直流電力盒', 'DCB-6000'], ['電力盒', 'DCB-6000'],
    ['直流', 'DCB-6000'], ['DC BOX', 'DCB-6000'], ['DCBOX', 'DCB-6000'],
    ['4PIN', 'DCB-6000', 4], ['8PIN', 'DCB-6000', 8],
    ['GPB-3600', 'GPB-3600'], ['方形小電池', 'GPB-3600'], ['方形', 'GPB-3600'], ['鉛酸', 'GPB-3600'],
    ['飛絡力', 'Lite數位'], ['FL-1800', 'Lite數位'], ['LITE數位', 'Lite數位'],
    ['AL-1800', 'Lite類比'], ['LITE類比', 'Lite類比'], ['類比', 'Lite類比'],
    ['小電池工具組', '小電池工具組'], ['工具組', '小電池工具組'], ['工具', '小電池工具組']
  ].map(function (a) { return { alias: a[0], product: a[1], pin: a[2] || 0 }; });

  /** 只說「小電池」「小電」或只說 10+1：要查上一筆訂單 */
  var VAGUE_WORDS = ['小電池', '小電', '電池', '老樣子', '同上次', '一樣'];
  var UNIT = '(?:顆|個|組|台|付|副|入|pcs|PCS|片)?';
  // 只有真的需要人判斷的才列為待確認原因
  var SPECIAL_PATTERNS = [
    [/先不要|延後|暫停|晚點再寄|等我通知/, '要求延後出貨'],
    [/還沒收到|沒收到|少寄|寄錯|退貨|換貨|瑕疵|壞/, '客訴或售後']
  ];
  var INVOICE_RE = /統編|發票|收據/;
  var ACCOUNT_RE = /(記[^，,。\s]{0,6}帳|下個月帳|月結|月底結|賒帳)/;
  var MOD_REPLACE = /改成|改為|更正|修改|換成|改一下|修正/;
  var MOD_ADD = /追加|多加|再加|加訂|另外再/;
  var MOD_CANCEL = /取消|不要了|先取消/;
  var WEEKDAY = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };
  var VAGUE_DATE = /月底|月初|過幾天|改天|之後再|下週(?![一二三四五六日天])|下周(?![一二三四五六日天])|下禮拜(?![一二三四五六日天])|下星期(?![一二三四五六日天])/;  var NO_TOOL = /(不需|不須|不用|不要|免|無須|無需)(要)?(帶)?(小電池)?工具(組)?/g;

  var CN_DIGIT = { '零': 0, '〇': 0, '一': 1, '二': 2, '兩': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
  /** 中文數字（一～九十九、兩）轉阿拉伯數字；無法轉換回傳 NaN */
  function cnNumber(s) {
    if (/^[零〇一二兩两三四五六七八九]$/.test(s)) return CN_DIGIT[s];
    var m = s.match(/^([一二兩两三四五六七八九])?十([一二三四五六七八九])?$/);
    if (m) return (m[1] ? CN_DIGIT[m[1]] : 1) * 10 + (m[2] ? CN_DIGIT[m[2]] : 0);
    return NaN;
  }

  function normalize(text) {
    return String(text || '')
      .replace(/[！-～]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }) // 全形轉半形
      .replace(/　/g, ' ')
      .replace(/[×Ｘ]/g, 'x')
      .toUpperCase();
  }

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /** 在一行裡找出所有型號（長的別名優先，不重疊；純數字別名前後不能接數字） */
  function findProducts(line, aliases) {
    var sorted = aliases.slice().sort(function (a, b) { return b.alias.length - a.alias.length; });
    var taken = [], hits = [];
    sorted.forEach(function (a) {
      var key = normalize(a.alias);
      var re = new RegExp(/^\d+$/.test(key) ? '(?<![\\d\\-$])' + escapeRe(key) + '(?![\\dA-Z元塊])' : escapeRe(key), 'g');
      var m;
      while ((m = re.exec(line))) {
        var s = m.index, e = s + m[0].length;
        if (taken.some(function (t) { return s < t[1] && e > t[0]; })) continue;
        taken.push([s, e]);
        hits.push({ start: s, end: e, product: a.product, pin: a.pin, pinOnly: /^[48]PIN$/.test(key) });
      }
    });
    return hits.sort(function (a, b) { return a.start - b.start; });
  }

  /** 型號後面的數量：*3、x10、 10顆、10+1 */
  function qtyAfter(rest) {
    var m = rest.match(new RegExp('^\\s*\\)?\\s*(?:\\(\\s*[48]PIN\\s*\\))?\\s*(?:[*X]\\s*(\\d+)|(\\d+)\\s*(?:\\+\\s*1|' + UNIT.slice(3, -2) + '))'));
    if (m) return Number(m[1] || m[2]);
    m = rest.match(/^\s*[*X]?\s*(\d+)\s*$/);
    return m ? Number(m[1]) : 0;
  }

  /** 型號前面的數量：4個2000、20組4pin */
  function qtyBefore(head) {
    var m = head.match(new RegExp('(\\d+)\\s*' + UNIT + '\\s*$'));
    return m ? Number(m[1]) : 0;
  }

  function isQuestion(line) {
    return /[?？]|嗎|是不是|請問|有沒有|多少錢|價格/.test(line);
  }

  /**
   * 解析一段（已合併的）訊息。
   * opts: { aliases, hasImage, dcbDefaultPin: 4 }
   * 回傳 { kind: 'order'|'unclear'|'not_order', items:[{product, qty, pin8}], notes:[], reasons:[], vague:{qty} }
   */
  function parse(text, opts) {
    opts = opts || {};
    var aliases = opts.aliases || DEFAULT_ALIASES;
    var raw = normalize(text)
      .replace(/(\d+)\s*[搭送塔加]\s*1(?!\d)/g, '$1+1') // 10搭1、10送1、10塔1（錯字）＝10+1
      // 「十顆」「兩顆」等中文數量 → 數字（只轉後面接單位的，避免「一店」被改掉）
      .replace(/([零〇一二兩两三四五六七八九十]{1,3})\s*(顆|個|組|台|付|副|片|入|盒|PCS)/g, function (all, n, u) {
        var v = cnNumber(n);
        return isNaN(v) ? all : v + u;
      });
    if (opts.today) {
      // 客戶在訊息開頭寫的當天日期只是抬頭，不算指定出貨日
      var t = opts.today.split('-').map(Number);
      raw = raw.replace(/(\d{4})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{1,2})/g, function (all, y, m, d) {
        return Number(y) === t[0] && Number(m) === t[1] && Number(d) === t[2] ? ' ' : all;
      });
    }
    var noTool = NO_TOOL.test(raw);
    NO_TOOL.lastIndex = 0;
    raw = raw.replace(NO_TOOL, ' '); // 「不需工具」是備註，不是品項
    var lines = raw.split(/[\n\r,，、；;。]+/).map(function (l) { return l.trim(); }).filter(String);
    var items = [], reasons = [], notes = [];
    var vagueQty = 0, pendingDcb = false, mentioned = false, noQty = [];

    lines.forEach(function (line) {
      if (isQuestion(line)) return; // 詢問句不算下單
      var hits = findProducts(line, aliases);
      if (hits.length) mentioned = true;
      if (!hits.length) {
        var vm = line.match(/(\d+)\s*\+\s*1/) || (VAGUE_WORDS.some(function (w) { return line.indexOf(w) >= 0; }) && line.match(new RegExp('(\\d+)\\s*' + UNIT))) ||
          line.match(/^\D{0,6}?(\d+)\s*(?:顆|個|組|台|付|副|片|入|盒|PCS)/);
        if (vm) vagueQty += Number(vm[1]);
        return;
      }
      // 同一行連續的 DCB 別名（例：4pin直流電力盒、4PIN 直流）視為同一個品項
      var groups = [];
      hits.forEach(function (h) {
        var last = groups[groups.length - 1];
        if (last && last.product === 'DCB-6000' && h.product === 'DCB-6000' &&
            /^[\s()的]*$/.test(line.slice(last.end, h.start))) {
          last.end = h.end; if (h.pin) last.pin = h.pin;
        } else {
          groups.push({ start: h.start, end: h.end, product: h.product, pin: h.pin, pinOnly: h.pinOnly });
        }
      });
      groups.forEach(function (g, i) {
        var nextStart = i + 1 < groups.length ? groups[i + 1].start : line.length;
        var prevEnd = i > 0 ? groups[i - 1].end : 0;
        var after = line.slice(g.end, nextStart);
        var pinInLine = after.match(/\(\s*([48])PIN\s*\)/);
        if (pinInLine && g.product === 'DCB-6000') g.pin = Number(pinInLine[1]);
        var qty = qtyAfter(after) || qtyBefore(line.slice(prevEnd, g.start));
        var prevItem = items[items.length - 1];
        if (!qty && g.pinOnly && i > 0 && prevItem && prevItem.product === 'DCB-6000') {
          // 例：DCB-6000 *2 (8pin) → pin 註記屬於前一個品項
          prevItem.pin8 = g.pin === 8 ? prevItem.qty : 0;
          return;
        }
        if (!qty) {
          if (g.product === 'DCB-6000' && !g.pin) { pendingDcb = true; return; } // 例：先寫 DCB-6000，下一行才寫 (4pin)*2
          noQty.push(g.product);
          return;
        }
        items.push({ product: g.product, qty: qty, pin8: g.product === 'DCB-6000' && g.pin === 8 ? qty : 0 });
      });
    });

    if (pendingDcb && !items.some(function (it) { return it.product === 'DCB-6000'; })) noQty.push('DCB-6000');
    // 例：「出三顆備用電池、2000型」「GPB-2000A，10搭1」：型號和數量被標點分開
    // 只有一個型號沒數量、而別處剛好有一個沒型號的數量 → 配在一起
    noQty = unique(noQty);
    if (noQty.length === 1 && vagueQty) {
      items.push({ product: noQty[0], qty: vagueQty, pin8: 0 });
      vagueQty = 0;
      noQty = [];
    }
    noQty.forEach(function (prod) { reasons.push('「' + prod + '」沒有數量'); });

    // 合併同型號（DCB 的 4pin / 8pin 加總）
    var merged = [];
    items.forEach(function (it) {
      var m = merged.filter(function (x) { return x.product === it.product; })[0];
      if (m) { m.qty += it.qty; m.pin8 += it.pin8; } else merged.push({ product: it.product, qty: it.qty, pin8: it.pin8 });
    });

    SPECIAL_PATTERNS.forEach(function (p) { if (p[0].test(raw)) reasons.push(p[1]); });

    // 指定日期：能判斷就直接當出貨日，不能判斷才請客服確認
    var shipDate = '';
    if (opts.today) {
      var d = extractDate(raw, opts.today);
      if (d.date) shipDate = d.date;
      else if (d.ambiguous) reasons.push('有指定日期但無法判斷（' + d.text + '），請確認出貨日');
    }
    // 統編發票：價格組合改用開發票的組合
    var priceCombo = INVOICE_RE.test(raw) ? (opts.invoiceCombo || 'D(稅外加)') : '';
    if (priceCombo) notes.push('開發票');
    // 帳務：原文寫進附註
    var acc = String(text || '').match(ACCOUNT_RE);
    if (acc) notes.push(acc[1]);
    // 改單類型：交給呼叫端比對同一客戶未出貨的訂單
    var modification = MOD_CANCEL.test(raw) && !merged.length ? 'cancel' : MOD_REPLACE.test(raw) ? 'replace' : MOD_ADD.test(raw) ? 'add' : '';
    if (noTool) notes.push('不需工具');
    if (opts.hasImage) reasons.push('含圖片，需人工看圖');
    if (/方案/.test(raw)) reasons.push('指定促銷方案，請確認品項與價格');
    // 回收：不是訂單，另外記錄（之後回收折抵用）；同時有訂貨字眼才當訂單並提醒
    var recycle = /回收/.test(raw);
    if (recycle && /訂|叫貨|出貨|要\s*\d/.test(raw)) { reasons.push('訊息同時提到回收，請確認'); recycle = false; }
    if (vagueQty) reasons.push('沒寫型號（' + vagueQty + ' 個），需查上一筆訂單');

    var kind;
    if (!merged.length && !vagueQty && !opts.hasImage && !mentioned) kind = 'not_order';
    else if (!merged.length || reasons.length) kind = 'unclear';
    else kind = 'order';
    // 沒有任何品項、只是客訴或閒聊的訊息不列為訂單
    if (kind === 'unclear' && !merged.length && !vagueQty && !opts.hasImage && !mentioned) kind = 'not_order';

    if (modification === 'cancel' && kind === 'not_order') kind = 'unclear';
    if (recycle && merged.length) kind = 'recycle';
    return { kind: kind, items: merged, notes: unique(notes), reasons: unique(reasons), vague: vagueQty ? { qty: vagueQty } : null,
      shipDate: shipDate, priceCombo: priceCombo, modification: modification };
  }

  /** 從歷史訂單找這家店最近一次的電池類品項，給「小電池」「幫我出10+1」當建議 */
  /** 店名比對用：去掉括號註記與空白，例如「信耀車業(午後收貨)」與「信耀車業」視為同一家 */
  function storeKey(name) {
    return String(name || '').replace(/[\(（][^\)）]*[\)）]/g, '').replace(/\s+/g, '').trim();
  }

  /**
   * 從歷史訂單找這家店最近一次的品項（給「小電池」「幫我出10+1」當建議）。
   * prefer：優先考慮的型號（例如 10+1 適用的電池），有的話只在這些型號裡找。
   */
  /** 店名核心：去括號、空白與「車業／有限公司」等字尾，例：「鑫沅車業」「鑫沅」都是「鑫沅」 */
  function coreName(name) {
    var k = normalize(storeKey(name));
    for (var i = 0; i < 4; i++) k = k.replace(SUFFIX, '');
    return k;
  }

  /** 歷史紀錄的店名可能和廠商清冊寫法不同：完整相同或核心相同（至少 2 字）都算同一家 */
  function sameStore(a, b) {
    if (storeKey(a) === storeKey(b)) return true;
    var ca = coreName(a), cb = coreName(b);
    return ca.length >= 2 && ca === cb;
  }

  function suggestFromHistory(store, history, exclude, prefer) {
    exclude = exclude || /工具|起子|批頭|線組/;
    var rows = (history || []).filter(function (h) { return sameStore(h.store, store) && h.product && !exclude.test(h.product); });
    if (prefer && prefer.length) {
      var preferred = rows.filter(function (h) { return prefer.indexOf(h.product) >= 0; });
      if (preferred.length) rows = preferred;
    }
    rows.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    return rows.length ? { product: rows[0].product, qty: Number(rows[0].qty), date: rows[0].date } : null;
  }

  function ymd(y, m, d) {
    var t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() + '-' + ('0' + (t.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + t.getUTCDate()).slice(-2);
  }

  /**
   * 從訊息找出指定的出貨日（today：'YYYY-MM-DD'）。
   * 回傳 { date } 或 { ambiguous, text } 或 {}（沒有提到日期）。
   */
  function extractDate(raw, today) {
    var t = today.split('-').map(Number);
    var base = new Date(Date.UTC(t[0], t[1] - 1, t[2]));
    var dow = base.getUTCDay() || 7; // 週一＝1 … 週日＝7
    var found = [];
    var add = function (n) { found.push(ymd(t[0], t[1], t[2] + n)); };
    var m, re;
    if (/今天/.test(raw)) add(0);
    if (/明天/.test(raw)) add(1);
    if (/後天/.test(raw) && !/明後天/.test(raw)) add(2);
    re = /(下下|下|這|本)?(?:週|周|禮拜|星期)([一二三四五六日天])/g;
    while ((m = re.exec(raw))) {
      var w = WEEKDAY[m[2]];
      var offset = m[1] === '下下' ? 14 : m[1] === '下' ? 7 : 0;
      var n = w - dow + offset;
      if (!m[1] && n < 0) n += 7; // 只說「禮拜五」且已過：下週五
      add(n);
    }
    re = /(?:^|[^\d.\-])(\d{1,2})\s*(?:\/|月)\s*(\d{1,2})\s*(?:日|號)?(?![\dP])/g;
    while ((m = re.exec(raw))) {
      var mo = Number(m[1]), da = Number(m[2]);
      if (mo < 1 || mo > 12 || da < 1 || da > 31) continue;
      var y = t[0];
      if (ymd(y, mo, da) < ymd(t[0], t[1], t[2] - 60)) y++; // 例：12 月說 1/5 → 明年
      found.push(ymd(y, mo, da));
    }
    found = unique(found);
    if (found.length === 1) return { date: found[0] };
    if (found.length > 1) return { ambiguous: true, text: '提到多個日期' };
    var v = raw.match(VAGUE_DATE);
    if (v) return { ambiguous: true, text: v[0] };
    return {};
  }

  /**
   * 分析表單（每家店各型號累計數量）→ 這家店買最多的型號。
   * table: { headers: [型號...], rows: [[店名, 數量...]] }；只在 prefer 型號中挑（有給的話）。
   */
  function topProduct(store, table, prefer) {
    if (!table || !table.rows) return '';
    var row = table.rows.filter(function (r) { return sameStore(r[0], store); })[0];
    if (!row) return '';
    var best = '', max = 0;
    table.headers.forEach(function (h, i) {
      var q = Number(row[i + 1]) || 0;
      if (prefer && prefer.length && prefer.indexOf(h) < 0) return;
      if (q > max) { max = q; best = h; }
    });
    return best;
  }

  /** 這家店最近 n 筆訂單（給 AI 當參考，不送整份歷史） */
  function recentFor(store, history, n) {
    var rows = (history || []).filter(function (h) { return sameStore(h.store, store) && h.product; });
    rows.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    return rows.slice(0, n || 3).map(function (h) { return { product: h.product, qty: Number(h.qty), date: h.date }; });
  }

  /**
   * 新 LINE 帳號：用 LINE 名稱與訊息內容比對廠商清冊，找出最可能的店家。
   * 完整店名出現最優先，其次是去掉「車業／有限公司」等字尾後的店名核心（至少 2 字）。
   * 有兩家以上同分時不建議（回傳 ''），交給客服選。
   */
  var SUFFIX = /(股份有限公司|有限公司|企業社|工作室|車業行|機車行|車業|車行|電動車|電能車業|電能|動能|社區店|商行|科技|國際|實業|企業|貿易|智能|電動機車|電動|行)$/;
  function suggestVendor(texts, vendors) {
    var hay = normalize((texts || []).join(' ')).replace(/\s+/g, '');
    if (!hay) return '';
    var best = '', bestScore = 0, tie = false;
    unique((vendors || []).filter(String)).forEach(function (v) {
      var full = normalize(v).replace(/\s+/g, '');
      var core = full;
      for (var i = 0; i < 3; i++) core = core.replace(/\(.*?\)$/, '').replace(SUFFIX, '');
      var score = 0;
      if (full.length >= 2 && hay.indexOf(full) >= 0) score = 100 + full.length;
      else if (core.length >= 2 && hay.indexOf(core) >= 0) score = core.length;
      if (!score) return;
      if (score > bestScore) { best = v; bestScore = score; tie = false; }
      else if (score === bestScore) tie = true;
    });
    return tie ? '' : best;
  }

  /** 地址比對用：台/臺統一、去空白、去郵遞區號、只取到「號」 */
  function addrKey(a) {
    var s = normalize(a).replace(/臺/g, '台').replace(/\s+/g, '').replace(/^\d{3,6}/, '');
    var i = s.indexOf('號');
    return i >= 0 ? s.slice(0, i + 1) : s;
  }

  /** 地址的「路段＋門牌」部分，例：新北市中和區景平路319號 → 景平路319號 */
  function streetKey(a) {
    var k = addrKey(a);
    var m = k.match(/^.*?[縣市].*?[區鄉鎮市](.+號)$/);
    return m ? m[1] : (/號$/.test(k) ? k : '');
  }

  /**
   * 從訊息判斷是哪一家店（多店帳號、群組下單用）：
   * 1. 訊息中的地址（路段＋門牌）與廠商清冊送貨地址相同
   * 2. 訊息中出現店名（完整或去掉「車業」等字尾）
   * vendors：[{ name, address }]；candidates：只在這些店裡找（可省略）
   * 只有唯一結果才回傳，否則回傳 ''。
   */
  function matchStore(text, vendors, candidates) {
    var hay = normalize(text).replace(/臺/g, '台').replace(/\s+/g, '');
    var pool = (vendors || []).filter(function (v) { return v && v.name && (!candidates || candidates.indexOf(v.name) >= 0); });
    var byAddr = pool.filter(function (v) { var k = streetKey(v.address || ''); return k.length >= 5 && hay.indexOf(k) >= 0; });
    if (byAddr.length === 1) return byAddr[0].name;
    var names = pool.map(function (v) { return v.name; });
    var byName = suggestVendor([text], byAddr.length > 1 ? byAddr.map(function (v) { return v.name; }) : names);
    return byName || '';
  }

  /**
   * 新客戶：從訊息抓店名、地址、電話、統編（抓不到留空，由客服補）
   */
  function extractContact(text) {
    var raw = normalize(text).replace(/臺/g, '台');
    var out = { storeName: '', address: '', phone: '', taxId: '', district: '' };
    var ph = raw.match(/(?:^|[^\d])(09\d{2}[-\s]?\d{3}[-\s]?\d{3}|0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4})(?!\d)/);
    if (ph) out.phone = ph[1].replace(/\s/g, '');
    var tx = raw.match(/(?:統編|統一編號)[^\d]{0,4}(\d{8})(?!\d)/);
    if (tx) out.taxId = tx[1];
    var ad = raw.match(/(\d{3,6})?\s*([^\s,，。:：]{2,4}?[縣市][^\s,，。:：]{1,4}?[區鄉鎮市][^\s,，。:：]+?號(?:之\d+)?(?:\d+樓)?(?:之\d+)?)/);
    if (ad) {
      out.address = (ad[1] || '') + ad[2];
      var dm = ad[2].match(/^(.{2,4}?[縣市].{1,4}?[區鄉鎮市])/);
      if (dm) out.district = dm[1];
    }
    var lines = String(text || '').split(/[\n\r,，。]+/).map(function (l) { return l.trim(); }).filter(String);
    for (var i = 0; i < lines.length; i++) {
      // 同一行若含地址，先把地址拿掉再找店名
      var l = normalize(lines[i]).replace(/臺/g, '台');
      if (out.address) l = l.replace(out.address.replace(/^\d+/, ''), ' ');
      if (/\d{2,}/.test(l) && !/店|車業|車行/.test(l)) continue;
      var m = l.match(/([^\s，,。:：我們是的]{2,16}(?:車業行|車業|機車行|車行|電動車|電動機車|動能|電能|科技|企業社|商行|工作室|社區店|一店|二店|三店|分店|店))/);
      if (m && !/需要|要訂|叫貨|訂貨/.test(m[1])) { out.storeName = m[1]; break; }
    }
    return out;
  }

  /** 新客戶預設價格組合：要工具 → B；不用工具但要發票 → D(稅外加)；其他 → A */
  function newCustomerCombo(text, items, combos) {
    combos = combos || {};
    var raw = normalize(text);
    var noTool = /(不需|不須|不用|不要|免|無須|無需)(要)?(帶)?(小電池)?工具/.test(raw);
    var wantsTool = !noTool && ((items || []).some(function (it) { return it.product === '小電池工具組'; }) || /工具/.test(raw));
    if (wantsTool) return combos.tool || 'B';
    if (/統編|發票|收據/.test(raw)) return combos.invoice || 'D(稅外加)';
    return combos.base || 'A';
  }

  function unique(arr) { return arr.filter(function (x, i) { return arr.indexOf(x) === i; }); }

  /** 新版才加入的對照，舊的「型號對照」工作表會自動補上 */
  var ADDED_ALIASES = ['小電池工具組', '工具組', '工具', '2000A', '2000S', 'GPB-6000', '6000', 'GBP-2000A', 'GBP-2000S', 'GBP-2000', 'GBP2000'];

  return { DEFAULT_ALIASES: DEFAULT_ALIASES, ADDED_ALIASES: ADDED_ALIASES, recentFor: recentFor, storeKey: storeKey, sameStore: sameStore, topProduct: topProduct, suggestVendor: suggestVendor, extractDate: extractDate, matchStore: matchStore, addrKey: addrKey, extractContact: extractContact, newCustomerCombo: newCustomerCombo, normalize: normalize, parse: parse, suggestFromHistory: suggestFromHistory };
})();

if (typeof module !== 'undefined') module.exports = Parser;


/**
 * Excel 列印檔調整（純文字處理，不呼叫 Google 服務，Node 可測試）
 * Google 匯出的 xlsx 已有 A4、標準邊界、水平置中；這裡補上：
 *   - 字型：全部改成指定字型（例如 微軟正黑體），可全部加粗
 *   - 縮放比例：與 Excel／試算表列印時相同（例如 68%）
 */
var Xlsx = (function () {
  // OOXML 規定的元素順序：printOptions / pageMargins / pageSetup 必須放在這些元素之前
  var AFTER_PAGE_SETUP = ['headerFooter', 'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors',
    'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture', 'oleObjects', 'controls',
    'webPublishItems', 'tableParts', 'extLst'];

  function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

  /** styles.xml：每個 <font> 改字型、移除 scheme（否則 Excel 會改用佈景主題字型）、可選加粗 */
  function patchStyles(xml, fontName, bold) {
    return xml.replace(/<fonts\b[^>]*>[\s\S]*?<\/fonts>/, function (block) {
      return block.replace(/<font\b[^>]*?(\/>|>[\s\S]*?<\/font>)/g, function (font) {
        if (/\/>$/.test(font) && !/<\/font>$/.test(font)) font = font.replace(/\/>$/, '></font>');
        var f = font;
        if (fontName) {
          f = f.replace(/<scheme\b[^>]*\/>/g, '').replace(/<family\b[^>]*\/>/g, '').replace(/<charset\b[^>]*\/>/g, '');
          if (/<name\b[^>]*\/>/.test(f)) f = f.replace(/<name\b[^>]*\/>/, '<name val="' + escAttr(fontName) + '"/>');
          else f = f.replace(/<\/font>$/, '<name val="' + escAttr(fontName) + '"/></font>');
        }
        if (bold && !/<b\s*\/>/.test(f) && !/<b\s+val="(1|true)"\s*\/>/.test(f)) {
          f = f.replace(/<b\s+val="(0|false)"\s*\/>/, '');
          f = f.replace(/^(<font\b[^>]*>)/, '$1<b/>');
        }
        return f;
      });
    });
  }

  /** sharedStrings.xml：儲存格內個別設定字型的文字（rich text） */
  function patchSharedStrings(xml, fontName, bold) {
    var out = xml;
    if (fontName) out = out.replace(/<rFont\b[^>]*\/>/g, '<rFont val="' + escAttr(fontName) + '"/>');
    if (bold) out = out.replace(/<rPr>(?![\s\S]{0,40}?<b\s*\/>)/g, '<rPr><b/>');
    return out;
  }

  /** 工作表：設定縮放比例（不使用「符合頁面」），其餘列印設定保留 Google 匯出的值 */
  function patchSheet(xml, opt) {
    var scale = Math.round(Number(opt.scale) || 100);
    var out = xml.replace(/<pageSetUpPr\b[^>]*\/>/g, '<pageSetUpPr fitToPage="0"/>');
    var center = opt.center === false ? '' : ' horizontalCentered="1"';
    var printOptions = '<printOptions' + center + '/>';
    var m = opt.margins || {};
    var pageMargins = '<pageMargins left="' + (m.left == null ? 0.7 : m.left) + '" right="' + (m.right == null ? 0.7 : m.right) +
      '" top="' + (m.top == null ? 0.75 : m.top) + '" bottom="' + (m.bottom == null ? 0.75 : m.bottom) + '" header="0.3" footer="0.3"/>';
    var pageSetup = '<pageSetup paperSize="9" scale="' + scale + '" orientation="portrait" pageOrder="overThenDown"/>';

    out = out.replace(/<printOptions\b[^>]*\/>/g, '').replace(/<pageMargins\b[^>]*\/>/g, '')
      .replace(/<pageSetup\b[^>]*\/>/g, '').replace(/<pageSetup\b[^>]*>[\s\S]*?<\/pageSetup>/g, '')
      .replace(/<rowBreaks\b[^>]*\/>/g, '').replace(/<rowBreaks\b[^>]*>[\s\S]*?<\/rowBreaks>/g, ''); // 每張工作表只印一頁，不需分頁符號
    var insert = printOptions + pageMargins + pageSetup;
    var pos = -1;
    AFTER_PAGE_SETUP.forEach(function (tag) {
      var i = out.search(new RegExp('<' + tag + '[\\s>/]'));
      if (i >= 0 && (pos < 0 || i < pos)) pos = i;
    });
    if (pos < 0) pos = out.lastIndexOf('</worksheet>');
    return out.slice(0, pos) + insert + out.slice(pos);
  }

  function isSheetPath(p) { return /^xl\/worksheets\/sheet\d+\.xml$/.test(p); }

  /**
   * files: [{ name, text }]（xlsx 解壓後的文字檔）→ 回傳修改後的 files
   * opt: { font, bold, scale, margins, center }
   */
  function patchFiles(files, opt) {
    return files.map(function (f) {
      if (f.name === 'xl/styles.xml') return { name: f.name, text: patchStyles(f.text, opt.font, opt.bold) };
      if (f.name === 'xl/sharedStrings.xml') return { name: f.name, text: patchSharedStrings(f.text, opt.font, opt.bold) };
      if (isSheetPath(f.name)) return { name: f.name, text: patchSheet(f.text, opt) };
      return f;
    });
  }

  return { patchStyles: patchStyles, patchSharedStrings: patchSharedStrings, patchSheet: patchSheet, patchFiles: patchFiles, isSheetPath: isSheetPath };
})();

if (typeof module !== 'undefined') module.exports = Xlsx;


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
var PARSE_HEADERS = ['訊息（貼上客戶訊息）', '店家（可空白）', '有圖片', '判斷', '品項', '備註', '需確認原因', '上一筆訂單建議',
  '正確答案（選填，例：GPB-2000A*10, DCB-6000*10, 8pin*2；4pin 與 8pin 分開寫）', '模型A', 'A判讀', 'A費用', '模型B', 'B判讀', 'B費用', '比對',
  '圖片（雲端硬碟連結，選填）'];

var ORDER_HEADERS = ['訂單ID', '收單時間', '出貨日', '店家', '型號', '數量', '8pin數', '附註', '狀態', '批次', '單據編號', '來源', '系統訊息', '折讓金額', '已收金額', '確認', '價格組合'];
var COL = {}; ORDER_HEADERS.forEach(function (h, i) { COL[h] = i; });
var STATUSES = ['待出貨', '待確認', '建議', '已產單', '已手打', '暫緩', '取消', '已出貨'];
var BATCH_HEADERS = ['批次ID', '產生時間', '類型', '店家數', '單據編號', '出貨單PDF', '貨運單PDF', '出貨單Excel', '執行者', '貨運單Excel'];
var TZ = 'Asia/Taipei';
var SUPPLEMENT_KEY = '產生補單（勾選執行）';

/** 設定預設值：[鍵, 值, 說明] */
var CONFIG_DEFAULTS = [
  ['通知Email', '', '多個以逗號分隔'],
  ['輸出資料夾ID', '', 'Google 雲端硬碟資料夾網址最後那串 ID；空白則放在我的雲端硬碟根目錄'],
  ['主檔試算表ID', '', '日常的「庫存管理及出貨單」試算表 ID；可填多個用逗號分隔（今年在前、去年在後）。第一個用來同步廠商清冊，全部用來查歷史訂單'],
  ['單據編號月份', '', '例：2026-11（系統自動維護）'],
  ['單據編號最後流水號', 0, '本月已用到的最後號碼；手打出貨單時也請改這裡，避免撞號'],
  ['主批次時間', '10:00', ''],
  ['當日截止時間', '16:00', '截止後不再詢問補單'],
  ['週六出貨', false, ''],
  ['10+1適用型號', 'GPB-2000,GPB-2000A,GPB-2000S,DCB-6000', '逗號分隔；空白代表所有型號'],
  ['輸出Excel', false, '另存 Excel 檔（出貨單、貨運單）；平常列印用 PDF 即可'],
  ['Excel字型', '微軟正黑體', 'Excel 列印檔使用的字型（在 Windows 的 Excel 開啟列印）'],
  ['輸出PDF', true, '列印用 PDF（A4、68%、置中）'],
  ['開發票價格組合', 'D(稅外加)', '客戶訊息提到統編／發票時，這張單改用的價格組合'],
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
  ['記錄回收', true, '「XX回收電力盒*N」寫入主檔「N月電力盒回收統計」（日期、客戶、數量）；備註「折貨款」且未打勾的，下次產單自動折抵'],
  ['自動寫入庫存管理', true, '產單後把出庫（含 10+1 特贈）接在主檔「庫存管理」最後面，建檔人員為「系統」；不會修改既有資料'],
  ['新客戶價格組合', 'A', '新客戶建檔草稿的預設價格組合'],
  ['新客戶要工具價格組合', 'B', '新客戶第一張訂單要工具時'],
  ['新客戶要發票價格組合', 'D(稅外加)', '新客戶不用工具但要統編發票時'],
  ['本公司人員', '', '公司同事的 LINE 名稱（逗號分隔），例如：李宗光,Jessica Tsai。他們在群組講的話不當訂單；他們私訊官方帳號替店家下單時，自動用「業務代訂」逐則判斷店家'],
  ['AI判讀', false, '勾選後，規則判斷不了的訊息交給 Claude 判讀（需先設定金鑰）'],
  ['AI模型', 'claude-haiku-5-5', 'claude-haiku-5-5（便宜、快）或 claude-opus-5-5（較準、約貴 40 倍）'],
  ['AI思考強度', 'low', 'low / medium / high'],
  ['AI比較模型', '', '「AI 模型比較」時要一起比較的第二個模型；空白＝只測「AI模型」'],
  ['AI每月上限美元', 5, '本月 AI 估計費用超過這個金額就停止呼叫，改由客服判斷；0＝不限制（費用明細見「AI使用紀錄」）']
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
    .addItem('AI 連線測試', 'menuTestAi')
    .addItem('AI 判讀測試（解析測試的訊息）', 'menuCompareModels')
    .addItem('同步廠商清冊', 'syncVendors')
    .addItem('清理產單暫存試算表', 'cleanupTempSheets')
    .addItem('整理表格外觀', 'menuFormatSheets')
    .addSeparator()
    .addItem('取得下一個單據編號（手打出貨單用）', 'reserveOrderNo')
    .addItem('初始化／修復工作表與排程', 'menuSetup')
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

  if (hm >= cfg['主批次時間'] && props.getProperty('archiveDone') !== today) {
    props.setProperty('archiveDone', today);
    try { archiveLog_(30); } catch (err) { console.error('封存失敗', err); }
  }
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
  if (r.getSheet().getName() === NEW_SHEET && r.getColumn() <= NC['確認建檔'] + 1 && r.getLastColumn() >= NC['確認建檔'] + 1) {
    handleNewCustomerEdit_(r);
    return;
  }
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
      combos: readCombos_(),
      eligible: splitList_(cfg['10+1適用型號'])
    });
    writeRowMessages_(orders, built.errors);

    if (!built.groups.length) {
      var msg = type + '：今日無待出貨訂單' + (built.errors.length ? '（另有 ' + built.errors.length + ' 筆資料有誤，請看「系統訊息」欄）' : '') +
        '\n\n診斷：' + Core.describeDiagnosis(Core.diagnose(orders.rows, today), today);
      if (!opts.manual || built.errors.length) notify_('【出貨】' + today + ' ' + type + '：今日無待出貨訂單', '<p>' + esc_(msg).replace(/\n/g, '<br>') + '</p>', []);
      return { ok: true, message: msg };
    }

    // 重印：整張單的每一列原本就有批次編號（已產單後被改回待出貨）→ 不再寫庫存、不再折抵回收
    var byId = {};
    orders.rows.forEach(function (r) { byId[r.id] = r; });
    built.groups.forEach(function (g) { g.reprint = g.rowIds.every(function (id) { return byId[id] && byId[id].batch; }); });
    var fresh = built.groups.filter(function (g) { return !g.reprint; });
    var recycleNote = truthy_(cfg['記錄回收']) && mainIds_()[0] ? applyRecycleCredits_(fresh) : '';
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

    try { markRecycleUsed_(fresh, today); } catch (e) { recycleNote += '<p>⚠ 回收統計備註註明失敗，請手動註明已折抵：' + esc_(e && e.message || e) + '</p>'; }
    var ledgerNote = recycleNote;
    if (truthy_(cfg['自動寫入庫存管理']) && mainIds_()[0]) {
      try {
        ledgerNote += fresh.length ? '<p>已寫入主檔「庫存管理」' + appendLedger_(fresh, today, batchId, cfg) + ' 列（建檔人員：系統）。</p>' : '';
        var re = built.groups.filter(function (g) { return g.reprint; }).map(function (g) { return g.store; });
        if (re.length) ledgerNote += '<p>重印：' + re.map(esc_).join('、') + '（之前已產單），沒有再寫入庫存管理、沒有再折抵回收。</p>';
      }
      catch (e) { ledgerNote = '<p>⚠ 寫入庫存管理失敗，請手動登記：' + esc_(e && e.message || e) + '</p>'; }
    }
    notify_('【出貨】' + today + ' ' + type + ' ' + batchId + '：' + built.groups.length + ' 家店',
      summaryHtml_(built, batchId, ss.getUrl()) + ledgerNote, attachments);
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
    if (g.priceCombo) { tmp.getRange('N3').setValue(g.priceCombo); SpreadsheetApp.flush(); } // 這張單指定的價格組合（例如開發票）
    // 記下各行小計與收款條件，產單成功後寫入庫存管理
    var calc = tmp.getRange('C9:G15').getValues();
    g.pay = tmp.getRange('E4').getDisplayValue();
    g.lines.forEach(function (l, k) { l.subtotal = calc[k] ? calc[k][4] : ''; });

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

/** 出庫紀錄接在主檔「庫存管理」最後一筆資料之後（只寫入空白列） */
function appendLedger_(groups, today, batchId, cfg) {
  var sh = SpreadsheetApp.openById(mainIds_()[0]).getSheetByName('庫存管理');
  if (!sh) throw new Error('主檔找不到「庫存管理」');
  var p = today.split('-').map(Number);
  var date = new Date(p[0], p[1] - 1, p[2]);
  var eligible = splitList_(cfg['10+1適用型號']);
  var rows = [];
  groups.forEach(function (g) {
    rows = rows.concat(Core.ledgerRows({ store: g.store, orderNo: g.orderNo, lines: g.lines }, date, { eligible: eligible, pay: g.pay, batchId: batchId }));
  });
  if (!rows.length) return 0;
  var data = sh.getRange(1, 1, sh.getLastRow(), 11).getValues();
  var last = 0;
  data.forEach(function (r, i) { if (String(r[0]).trim() || String(r[2]).trim() || String(r[3]).trim()) last = i + 1; });
  var target = last + 1;
  if (target + rows.length - 1 <= data.length) {
    var busy = data.slice(target - 1, target - 1 + rows.length).some(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); });
    if (busy) throw new Error('庫存管理第 ' + target + ' 列之後不是空白，為避免覆蓋資料已停止');
  }
  sh.getRange(target, 1, rows.length, 11).setValues(rows);
  return rows.length;
}

/** 手打出貨單時：取號並記錄，避免與系統撞號 */
function reserveOrderNo() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { showResult_({ message: '系統正在產單，請稍後再試' }); return; }
  try {
    var cfg = readConfig_();
    var r = Core.nextOrderNo({ month: String(cfg['單據編號月份'] || ''), last: Number(cfg['單據編號最後流水號']) || 0 }, fmtDate_(new Date()));
    setConfig_('單據編號月份', r.state.month);
    setConfig_('單據編號最後流水號', r.state.last);
    showResult_({ message: '這張手打出貨單請用：\n\n' + r.orderNo + '\n\n（已記錄，系統下一張會自動接續）' });
  } finally { lock.releaseLock(); }
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
      priceCombo: String(r[COL['價格組合']] || '').trim(),
      discount: r[COL['折讓金額']],
      paid: r[COL['已收金額']],
      status: String(r[COL['狀態']] || '').trim(),
      batch: String(r[COL['批次']] || '').trim()
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

/** 廠商清冊：只採用 A 欄有序號的店家（沒有序號的視為停用或重複資料） */
function readVendorInfo_() {
  var sh = mustSheet_(SHEET.VENDORS);
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues()
    .filter(function (r) { return String(r[0]).trim() !== '' && !isNaN(Number(r[0])) && String(r[2]).trim(); })
    .map(function (r) { return { no: Number(r[0]), name: String(r[2]).trim(), contact: String(r[3]).trim(), address: String(r[4]).trim(), phone: String(r[5]).trim() }; });
}

function readVendorNames_() {
  return readVendorInfo_().map(function (v) { return v.name; });
}

function readCombos_() {
  return mustSheet_(SHEET.INVOICE).getRange('O3:O103').getValues()
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
function mainIds_() {
  return String(readConfig_()['主檔試算表ID'] || '').split(/[,，\s]+/).map(function (x) { return x.trim(); }).filter(String);
}

function syncVendors() {
  var id = mainIds_()[0];
  if (!id) throw new Error('請先在「設定」填入主檔試算表ID');
  var src = SpreadsheetApp.openById(id).getSheetByName(SHEET.VENDORS);
  if (!src) throw new Error('主檔找不到「廠商清冊」工作表');
  var values = src.getRange(1, 1, src.getLastRow(), src.getLastColumn()).getValues();
  if (values.length < 2) throw new Error('主檔廠商清冊是空的，已停止同步（避免清掉這裡的資料）');
  var dst = mustSheet_(SHEET.VENDORS);
  if (dst.getMaxColumns() < values[0].length) dst.insertColumnsAfter(dst.getMaxColumns(), values[0].length - dst.getMaxColumns());
  if (dst.getMaxRows() < values.length) dst.insertRowsAfter(dst.getMaxRows(), values.length - dst.getMaxRows());
  // 先寫入新資料，再清掉多出來的舊列與舊欄（過程中不會有空白的時候）
  dst.getRange(1, 1, values.length, values[0].length).setValues(values);
  var oldRows = dst.getLastRow(), oldCols = dst.getLastColumn();
  if (oldRows > values.length) dst.getRange(values.length + 1, 1, oldRows - values.length, Math.max(oldCols, 1)).clearContent();
  if (oldCols > values[0].length) dst.getRange(1, values[0].length + 1, values.length, oldCols - values[0].length).clearContent();
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
  mainIds_().forEach(function (id) {
    try {
      var sh = SpreadsheetApp.openById(id).getSheetByName('庫存管理');
      if (!sh || sh.getLastRow() <= 2) return;
      // A 日期、C 出庫、D 商品名稱、E 數量、G 出貨渠道、H 客戶名稱
      sh.getRange(3, 1, sh.getLastRow() - 2, 8).getValues().forEach(function (r) {
        if (r[2] !== '出庫' || !r[7] || !r[3] || r[6] === '特贈') return;
        hist.push({ store: String(r[7]).trim(), product: String(r[3]).trim(), qty: r[4], date: isDate_(r[0]) ? fmtDate_(r[0]) : Core.normalizeDate(r[0]) });
      });
    } catch (e) { console.error('讀取主檔歷史失敗 ' + id, e); }
  });
  return hist;
}

/** 主檔「分析表單」AA 欄起：每家店各型號累計數量（多個主檔加總） */
function readTopTable_() {
  var byStore = {}, headers = [];
  mainIds_().forEach(function (id) {
    try {
      var sh = SpreadsheetApp.openById(id).getSheetByName('分析表單');
      if (!sh || sh.getLastRow() < 4) return;
      var data = sh.getRange(3, 27, sh.getLastRow() - 2, 8).getValues(); // AA:AH，第 3 列是型號標題
      var head = data[0].slice(1).map(function (h) { return String(h).trim(); });
      data.slice(1).forEach(function (r) {
        var store = String(r[0]).trim();
        if (!store || store === '總和') return;
        byStore[store] = byStore[store] || {};
        head.forEach(function (h, i) {
          if (!h || h === '總和') return;
          if (headers.indexOf(h) < 0) headers.push(h);
          byStore[store][h] = (byStore[store][h] || 0) + (Number(r[i + 1]) || 0);
        });
      });
    } catch (e) { console.error('讀取分析表單失敗 ' + id, e); }
  });
  return { headers: headers, rows: Object.keys(byStore).map(function (st) { return [st].concat(headers.map(function (h) { return byStore[st][h] || 0; })); }) };
}

/** 模糊品項（小電池／10+1）的建議：先查上一筆，沒有再用累計最常買的型號 */
function suggestVague_(store, ctx) {
  var prefer = splitList_(ctx.cfg['10+1適用型號']);
  ctx.history = ctx.history || readHistory_();
  var sug = Parser.suggestFromHistory(store, ctx.history, null, prefer);
  if (sug) return { product: sug.product, why: '上一筆訂單（' + sug.date + '）' };
  ctx.top = ctx.top || readTopTable_();
  var top = Parser.topProduct(store, ctx.top, prefer);
  return top ? { product: top, why: '這家店累計最常買的型號' } : null;
}

/** 解析測試手填的店家（可能是簡稱）→ 廠商清冊上的完整店名 */
function resolveStoreInput_(name) {
  if (!name) return '';
  var vendors = readVendorNames_();
  return Core.resolveVendor(name, vendors) || Parser.matchStore(name, readVendorInfo_()) || name;
}

/** 把品項整理成可比對的文字：型號×數量（8pin n），依型號排序 */
function itemsKey_(items) {
  return (items || []).map(function (it) { return it.product + '×' + it.qty + (it.pin8 ? '(8pin' + it.pin8 + ')' : ''); }).sort().join(', ');
}

/**
 * 解析測試表的每則訊息，分別交給兩個模型判讀，並與「正確答案」比對。
 * 一次最多處理 15 則（避免超過執行時間），已有結果的列會略過；要重跑請清空 K～P 欄。
 */
function menuCompareModels() {
  var cfg = readConfig_();
  if (!PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY')) { showResult_({ message: '請先用「設定金鑰」貼上 Claude 金鑰' }); return; }
  var sh = ensureSheet_(SHEET.PARSE_TEST, PARSE_HEADERS);
  sh.getRange(1, 1, 1, PARSE_HEADERS.length).setValues([PARSE_HEADERS]).setFontWeight('bold');
  var n = sh.getLastRow() - 1;
  if (n < 1) { showResult_({ message: '請先在「解析測試」A 欄貼上客戶訊息（一格一段），I 欄可填正確答案' }); return; }
  var models = [String(cfg['AI模型'] || 'claude-haiku-5-5').trim(), String(cfg['AI比較模型'] || '').trim()].filter(String);
  var base = { aliases: readAliases_(), products: unique_(readProducts_()), history: null };
  var data = sh.getRange(2, 1, n, PARSE_HEADERS.length).getValues();
  var done = 0, score = [0, 0], graded = 0, cost = [0, 0], started = Date.now();
  for (var i = 0; i < data.length && done < 15 && Date.now() - started < 270000; i++) {
    var text = String(data[i][0]).trim();
    if (!text || String(data[i][10]).trim()) continue;
    var store = resolveStoreInput_(String(data[i][1]).trim());
    var expected = String(data[i][8]).trim();
    var expKey = expected ? itemsKey_(Parser.parse(expected, { aliases: base.aliases }).items) : '';
    var out = [];
    var blobs = [];
    var link = String(data[i][16] || '').trim();
    if (link) {
      var fid = (link.match(/[-\w]{25,}/) || [])[0];
      try { if (fid) blobs.push(DriveApp.getFileById(fid).getBlob()); } catch (e) { out.push('', '❌ 圖片讀取失敗：請確認連結是雲端硬碟檔案且你有權限', ''); }
    }
    models.forEach(function (m, k) {
      var c = Object.assign({}, base, { cfg: Object.assign({}, cfg, { 'AI模型': m }) });
      var r = askClaude_(text, [], c, store, blobs);
      if (r.error) { out.push(m, '❌ ' + r.error, ''); return; }
      var key = itemsKey_(r.items);
      cost[k] += r.cost;
      out.push(r.model, (key || '（無品項）') + (r.concerns.length ? '\n疑點：' + r.concerns.join('；') : ''), Math.round(r.cost * 10000) / 10000);
      if (expKey) { if (key === expKey) score[k]++; out[out.length - 2] = (key === expKey ? '✅ ' : '❌ ') + out[out.length - 2]; }
    });
    while (out.length < 6) out.push('');
    out = out.slice(0, 6);
    var verdict = !expKey ? '（未填正確答案）' : (out[1].indexOf('✅') === 0 ? 'A對' : 'A錯') + (models[1] ? '／' + (out[4].indexOf('✅') === 0 ? 'B對' : 'B錯') : '');
    if (expKey) graded++;
    sh.getRange(i + 2, 10, 1, 7).setValues([out.concat([verdict])]);
    done++;
  }
  sh.getRange(2, 11, n, 1).setWrap(true);
  sh.getRange(2, 14, n, 1).setWrap(true);
  var msg = '本次比較 ' + done + ' 則訊息\n\n' +
    'A：' + models[0] + (graded ? '　答對 ' + score[0] + '/' + graded : '') + '　費用 US$' + cost[0].toFixed(4) +
    (models[1] ? '\nB：' + models[1] + (graded ? '　答對 ' + score[1] + '/' + graded : '') + '　費用 US$' + cost[1].toFixed(4) : '') +
    (done === 15 ? '\n\n還有沒比較的訊息，請再執行一次。' : '') +
    '\n\n在 I 欄填正確答案就能自動評分；要重跑某一列，清空那一列的 J～P 欄。';
  showResult_({ message: msg });
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
      history = history || { cfg: readConfig_() };
      var st = resolveStoreInput_(String(r[1]).trim());
      var h = mainIds_().length ? suggestVague_(st, history) : null;
      sug = !mainIds_().length ? '未設定主檔試算表ID，無法查歷史訂單' :
        h ? h.product + '（' + h.why + (st !== String(r[1]).trim() ? '；店家：' + st : '') + '）' : '查無「' + st + '」的歷史訂單';
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

/**
 * 初始化：每個步驟各自執行，某一步出錯也會繼續做完其他步驟，最後列出結果。
 * 從 Apps Script 編輯器執行時，結果會顯示在下方「執行記錄」。
 */
function setup() {
  var results = [];
  var step = function (name, fn) {
    try { fn(); results.push('✅ ' + name); }
    catch (e) { results.push('❌ ' + name + '：' + (e && e.message || e)); console.error(name, e && e.stack || e); }
  };
  step('建立工作表、設定、排程', setupCore_);
  formatSheets_().forEach(function (r) { results.push(r); });
  var text = '版本：' + (typeof APP_VERSION !== 'undefined' ? APP_VERSION : '開發版') + '\n' + results.join('\n');
  console.log(text);
  return text;
}

function menuSetup() { showResult_({ message: setup() }); }

function setupCore_() {
  var ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(TZ);
  [SHEET.INVOICE, SHEET.LABEL, SHEET.VENDORS].forEach(function (n) {
    if (!ss.getSheetByName(n)) throw new Error('缺少「' + n + '」工作表：請從主檔用「複製到 → 現有試算表」複製過來，並把名稱改回「' + n + '」');
  });

  var cfg = ensureSheet_(SHEET.CONFIG, ['項目', '值', '說明']);
  var obsolete = ['出貨單第一聯列', '出貨單第二聯列', '列印欄數', '出貨單PDF參數', '貨運單PDF參數', '出貨單列印設定', '貨運單列印設定', 'PDF字型', '出貨單字型', '貨運單字型'];
  // 依使用者決定改用 Haiku、只測一個模型（只改一次）
  if (!PropertiesService.getScriptProperties().getProperty('haiku1')) {
    for (var rh = 2; rh <= cfg.getLastRow(); rh++) {
      var kh = cfg.getRange(rh, 1).getValue();
      if (kh === 'AI模型') cfg.getRange(rh, 2).setValue('claude-haiku-5-5');
      if (kh === 'AI比較模型') cfg.getRange(rh, 2).setValue('');
    }
    PropertiesService.getScriptProperties().setProperty('haiku1', '1');
  }
  // 回收改為寫入主檔回收統計：舊版預設不勾選的「記錄回收」改為勾選一次
  if (!PropertiesService.getScriptProperties().getProperty('recycle2')) {
    for (var ry = 2; ry <= cfg.getLastRow(); ry++) {
      if (cfg.getRange(ry, 1).getValue() === '記錄回收') cfg.getRange(ry, 2, 1, 2).setValues([[true, '「XX回收電力盒*N」寫入主檔「N月電力盒回收統計」（日期、客戶、數量）；備註「折貨款」且未打勾的，下次產單自動折抵']]);
    }
    PropertiesService.getScriptProperties().setProperty('recycle2', '1');
  }
  // 改為只出 PDF：舊版預設勾選的「輸出Excel」取消一次
  if (!PropertiesService.getScriptProperties().getProperty('pdfOnly1')) {
    for (var rx = 2; rx <= cfg.getLastRow(); rx++) {
      if (cfg.getRange(rx, 1).getValue() === '輸出Excel') cfg.getRange(rx, 2, 1, 2).setValues([[false, '另存 Excel 檔（出貨單、貨運單）；平常列印用 PDF 即可']]);
    }
    PropertiesService.getScriptProperties().setProperty('pdfOnly1', '1');
  }
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
    if ([SUPPLEMENT_KEY, '週六出貨', '試跑模式', 'AI判讀', '輸出Excel', '輸出PDF', '貨運單粗體', '自動寫入庫存管理', '記錄回收'].indexOf(k[0]) >= 0) cfg.getRange(i + 1, 2).insertCheckboxes();
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
  orders.getRange(2, COL['價格組合'] + 1, maxR, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(ss.getSheetByName(SHEET.INVOICE).getRange('O3:O103'), true).setAllowInvalid(false)
    .setHelpText('空白＝用廠商清冊的價格組合；要開發票選 D(稅外加)').build());
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
  pt.getRange(1, 1, 1, PARSE_HEADERS.length).setValues([PARSE_HEADERS]).setFontWeight('bold');
  pt.getRange(2, 3, pt.getMaxRows() - 1, 1).insertCheckboxes();
  pt.getRange(2, 1, pt.getMaxRows() - 1, 8).setWrap(true).setVerticalAlignment('top');
  ensureSheet_(SHEET.HOLIDAYS, ['日期', '說明']);
  var lg = ensureSheet_(LINE_SHEET.LOG, LOG_HEADERS);
  lg.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]).setFontWeight('bold');
  lg.setFrozenRows(1);
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
  return '<p>批次 ' + batchId + '，附件為出貨單與貨運單 PDF，列印時請選「實際大小／100%」。</p>' +
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


/**
 * 第二階段：LINE 訊息 → 訂單
 * Cloudflare Worker 驗證簽章後轉送到這裡（doPost），每 5 分鐘由 tick 合併、解析、寫入。
 * 系統不會傳任何訊息給客戶。
 */

var LINE_SHEET = { LOG: '訊息紀錄', BIND: 'LINE帳號對照', TRIAL: 'LINE試跑', RECYCLE: '回收紀錄' };
var RECYCLE_HEADERS = ['收到時間', '店家', '型號', '數量', '原文', '來源', '狀態', '備註'];
var LOG_HEADERS = ['收到時間', '事件ID', '對話ID（個人或群組）', '類型', '內容', '訊息ID', '狀態', '段落ID', '判斷', '發話者ID', '發話者名稱'];
var BIND_HEADERS = ['LINE對話ID（個人或群組）', 'LINE名稱', '店家', '第一次出現', '備註', '系統建議店家'];
var LOG_COL = {}; LOG_HEADERS.forEach(function (h, i) { LOG_COL[h] = i; });
LOG_COL['LINE使用者ID'] = LOG_COL['對話ID（個人或群組）']; // 舊名稱相容

/* ───────────── 接收 ───────────── */

function doPost(e) {
  var data;
  try { data = JSON.parse(e.postData.contents); } catch (err) { return text_('bad request'); }
  var secret = PropertiesService.getScriptProperties().getProperty('FORWARD_SECRET');
  if (!secret || data.secret !== secret) return text_('forbidden');
  var body;
  try { body = JSON.parse(data.body); } catch (err) { return text_('bad body'); }
  storeEvents_(body.events || []);
  return text_('ok');
}

function doGet() { return text_('華暉出貨自動化：運作中'); }

function text_(s) { return ContentService.createTextOutput(s); }

function storeEvents_(events) {
  var cache = CacheService.getScriptCache();
  var log = ensureSheet_(LINE_SHEET.LOG, LOG_HEADERS);
  var staff = null;
  events.forEach(function (ev) {
    var src = ev.source || {};
    if (ev.type !== 'message' || ['user', 'group', 'room'].indexOf(src.type) < 0) return;
    var id = ev.webhookEventId || (ev.message && ev.message.id);
    if (cache.get('ev:' + id)) return; // LINE 重送的同一事件
    cache.put('ev:' + id, '1', 21600);
    var m = ev.message;
    var content = m.type === 'text' ? m.text : ({ image: '[圖片]', sticker: '[貼圖]', video: '[影片]', audio: '[語音]', file: '[檔案]', location: '[位置]' }[m.type] || '[' + m.type + ']');
    var chat = src.groupId || src.roomId || src.userId;
    var sender = src.userId || '';
    var senderName = '', status = '未處理';
    if (src.type !== 'user') {
      // 群組：記下是誰說的；公司同事在群組講的話不當成訂單
      senderName = sender ? lineMemberName_(src, sender) : '';
      staff = staff || splitList_(readConfig_()['本公司人員']);
      if (senderName && staff.some(function (n) { return senderName.indexOf(n) >= 0; })) status = '本公司';
    }
    log.appendRow([new Date(ev.timestamp), id, chat, m.type, content, m.id, status, '', status === '本公司' ? '本公司人員' : '', sender, senderName]);
    if (status === '未處理') ensureBinding_(chat, m.type === 'text' ? m.text : '', src);
  });
}

/** 個人帳號、群組各一列；同一個對話可以有多列＝綁多家店 */
function ensureBinding_(chatId, text, src) {
  var sh = ensureSheet_(LINE_SHEET.BIND, BIND_HEADERS);
  if (sh.getLastRow() > 1) {
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues();
    var mine = [];
    rows.forEach(function (r, i) { if (r[0] === chatId) mine.push(i); });
    if (mine.length) {
      // 還沒綁定、也還沒有建議：用新訊息再試一次
      var i0 = mine[0];
      if (mine.length === 1 && !String(rows[i0][2]).trim() && !String(rows[i0][5]).trim() && text) {
        var sug = guessStore_([rows[i0][1], text].join(' '));
        if (sug) sh.getRange(i0 + 2, 6).setValue(sug);
      }
      return;
    }
  }
  var name = src && src.type === 'group' ? '群組：' + lineGroupName_(src.groupId) :
    src && src.type === 'room' ? '多人聊天' : lineProfileName_(chatId);
  sh.appendRow([chatId, name, '', new Date(), '', guessStore_([name, text].join(' '))]);
}

/** 用店名或地址從廠商清冊猜是哪家店 */
function guessStore_(text) {
  return Parser.matchStore(text, readVendorInfo_()) || '';
}

function lineGroupName_(groupId) {
  var token = PropertiesService.getScriptProperties().getProperty('LINE_TOKEN');
  if (!token) return '';
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/group/' + encodeURIComponent(groupId) + '/summary', {
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
  });
  return res.getResponseCode() === 200 ? JSON.parse(res.getContentText()).groupName : '';
}

/** 群組成員名稱（快取 6 小時） */
function lineMemberName_(src, userId) {
  var cache = CacheService.getScriptCache();
  var key = 'mem:' + userId;
  var hit = cache.get(key);
  if (hit) return hit;
  var token = PropertiesService.getScriptProperties().getProperty('LINE_TOKEN');
  if (!token) return '';
  var path = src.type === 'group' ? 'group/' + encodeURIComponent(src.groupId) : 'room/' + encodeURIComponent(src.roomId);
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/' + path + '/member/' + encodeURIComponent(userId), {
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
  });
  var name = res.getResponseCode() === 200 ? JSON.parse(res.getContentText()).displayName : '';
  if (name) cache.put(key, name, 21600);
  return name;
}

function lineProfileName_(userId) {
  var token = PropertiesService.getScriptProperties().getProperty('LINE_TOKEN');
  if (!token) return '';
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/profile/' + encodeURIComponent(userId), {
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
  });
  return res.getResponseCode() === 200 ? JSON.parse(res.getContentText()).displayName : '';
}

function lineContent_(messageId) {
  var token = PropertiesService.getScriptProperties().getProperty('LINE_TOKEN');
  if (!token) return null;
  var res = UrlFetchApp.fetch('https://api-data.line.me/v2/bot/message/' + encodeURIComponent(messageId) + '/content', {
    headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
  });
  return res.getResponseCode() === 200 ? res.getBlob() : null;
}

/* ───────────── 合併與解析（tick 每 5 分鐘） ───────────── */

function menuProcessLine() { showResult_({ message: processLine_(true) }); } // 手動執行不等待合併時間

function processLine_(force) {
  var cfg = readConfig_();
  var log = ensureSheet_(LINE_SHEET.LOG, LOG_HEADERS);
  if (log.getLastRow() < 2) return '沒有 LINE 訊息';
  var data = log.getRange(2, 1, log.getLastRow() - 1, LOG_HEADERS.length).getValues();
  var seen = {}, msgs = [];
  var agents = readAgentChats_();
  data.forEach(function (r, i) {
    if (r[LOG_COL['狀態']] !== '未處理') return;
    var eid = r[LOG_COL['事件ID']];
    if (seen[eid]) { log.getRange(i + 2, LOG_COL['狀態'] + 1).setValue('重複'); return; }
    seen[eid] = true;
    var chat = r[LOG_COL['對話ID（個人或群組）']], sender = r[LOG_COL['發話者ID']] || '';
    var isGroup = /^[CR]/.test(String(chat)); // 群組 ID 以 C 開頭、多人聊天以 R 開頭
    msgs.push({
      row: i + 2, ts: new Date(r[LOG_COL['收到時間']]).getTime(),
      // 合併訊息的單位：個人；群組裡依發話者分開；業務代訂帳號每則訊息各自處理（每則可能是不同店家）
      userId: agents[chat] ? chat + '|m' + (i + 2) : isGroup && sender ? chat + '|' + sender : chat,
      chat: chat, type: r[LOG_COL['類型']], text: String(r[LOG_COL['內容']]), messageId: r[LOG_COL['訊息ID']]
    });
  });
  if (!msgs.length) { notifyUnbound_(); return '沒有待處理的訊息'; }

  var hm = Utilities.formatDate(new Date(), TZ, 'HH:mm');
  var forceNow = force || (hm >= cfg['強制合併時間'] && hm < cfg['當日截止時間']);
  var segs = Core.readySegments(msgs, Date.now(), (Number(cfg['合併等待分鐘']) || 10) * 60000, forceNow);
  var ctx = {
    cfg: cfg, aliases: readAliases_(), products: unique_(readProducts_()), holidays: readHolidays_(),
    bindings: readBindings_(), vendorInfo: readVendorInfo_(), agents: agents, history: null, today: fmtDate_(new Date())
  };
  var counts = { order: 0, unclear: 0, not_order: 0, recycle: 0 };
  segs.forEach(function (seg) {
    var kind = handleSegment_(seg, ctx, log);
    counts[kind]++;
  });
  notifyUnbound_();
  return '處理 ' + segs.length + ' 段對話：明確 ' + counts.order + '、待確認 ' + counts.unclear + '、非訂單 ' + counts.not_order + '、回收 ' + counts.recycle +
    (msgs.length && !segs.length ? '（客戶可能還在輸入，' + (cfg['合併等待分鐘'] || 10) + ' 分鐘沒有新訊息後才會處理）' : '');
}

function handleSegment_(seg, ctx, log) {
  var cfg = ctx.cfg;
  var first = seg.msgs[0];
  var segId = seg.userId.slice(-6) + '-' + first.ts;
  var text = seg.msgs.filter(function (m) { return m.type === 'text'; }).map(function (m) { return m.text; }).join('\n');
  var images = seg.msgs.filter(function (m) { return m.type === 'image'; });
  var recvDate = fmtDate_(new Date(first.ts));
  var recvHm = Utilities.formatDate(new Date(first.ts), TZ, 'HH:mm');

  var res = Parser.parse(text, { aliases: ctx.aliases, hasImage: images.length > 0, today: recvDate, invoiceCombo: cfg['開發票價格組合'] });
  var mark = function (kindText) {
    seg.msgs.forEach(function (m) {
      log.getRange(m.row, LOG_COL['狀態'] + 1, 1, 3).setValues([['已處理', segId, kindText]]);
    });
  };
  if (res.kind === 'not_order') { mark('非訂單'); return 'not_order'; }

  var chat = seg.msgs[0].chat || seg.userId;
  var vendorNames = ctx.vendors || (ctx.vendors = readVendorNames_());
  // 廠商清冊改名（例如加上「(午後收貨)」）後仍對得上
  var bound = (ctx.bindings[chat] || []).map(function (b) { return Core.resolveVendor(b, vendorNames) || b; });
  var store = '', storeNote = '';
  var agent = !!(ctx.agents && ctx.agents[chat]);
  if (agent) {
    // 業務代訂：每則訊息從店名或地址判斷是哪一家
    store = Parser.matchStore(text, ctx.vendorInfo);
    if (!store) storeNote = '業務代訂：訊息中找不到廠商清冊上的店名，請選擇店家';
  } else if (bound.length === 1) {
    store = bound[0];
  } else if (bound.length > 1) {
    // 多店帳號／群組：從訊息裡的分店名或地址判斷
    store = Parser.matchStore(text, ctx.vendorInfo, bound);
    if (!store) storeNote = '這個帳號／群組綁了多家店（' + bound.join('、') + '），訊息沒寫是哪一家，請選擇店家';
  }
  if (res.kind === 'recycle') {
    // 回收不是訂單：寫入主檔當月回收統計（日期、客戶、數量），打勾留給人工
    if (!truthy_(cfg['記錄回收'])) { mark('回收（不處理）'); return 'recycle'; }
    var rStore = store || Parser.matchStore(text, ctx.vendorInfo) || (text.split('回收')[0] || '').trim();
    var qty = res.items.reduce(function (a, it) { return a + it.qty; }, 0);
    var p = recvDate.split('-').map(Number);
    try {
      var where = recordRecycle_(new Date(p[0], p[1] - 1, p[2]), rStore, qty);
      mark('回收：已寫入 ' + where);
    } catch (e) {
      mark('回收：寫入失敗');
      notify_('【出貨】回收未能寫入主檔', '<p>' + esc_(rStore + ' 回收 ' + qty + ' 個：' + (e && e.message || e)) + '</p><p>原文：' + esc_(text) + '</p><p>請手動登記到回收統計。</p>', []);
    }
    return 'recycle';
  }
  var items = res.items.slice(), reasons = res.reasons.slice(), notes = res.notes.slice();
  var kind = res.kind;

  // 只說「小電池／幫我出10+1」：先查上一筆訂單，沒有再用累計最常買的型號（都免費）
  if (res.vague && !items.length && store) {
    var sug = suggestVague_(store, ctx);
    if (sug) {
      items = [{ product: sug.product, qty: res.vague.qty, pin8: 0 }];
      reasons.push('型號依' + sug.why + '推測：' + sug.product + '，請確認');
    } else {
      reasons.push('這家店沒有歷史訂單可參考，請確認型號');
    }
  }
  // 還是判斷不了（沒有品項、或有圖片）才交給 Claude
  if (kind === 'unclear' && truthy_(cfg['AI判讀']) && (!items.length || images.length)) {
    var ai = askClaude_(text, images, ctx, store);
    if (ai.error) {
      reasons.push('AI 判讀失敗：' + ai.error);
    } else {
      if (ai.items.length) items = ai.items;
      ai.concerns.forEach(function (c) { reasons.push('AI：' + c); });
      if (ai.notes) notes.push(ai.notes);
      if (!ai.is_order) reasons.push('AI 判斷可能不是訂單');
      reasons.push('品項由 AI 判讀，請核對');
    }
  }
  if (storeNote) reasons.push(storeNote);
  else if (!store && !agent) {
    var hint = Parser.matchStore(text, ctx.vendorInfo);
    reasons.push('LINE 帳號尚未綁定店家，請到「LINE帳號對照」選擇店家' + (hint ? '（系統建議：' + hint + '）' : '（廠商清冊找不到相符店名或地址，可能是新客戶，已建立「新客戶待建檔」草稿）'));
    if (!hint) draftNewCustomer_(chat, text, res, items);
  }

  var ship = Core.inferShipDate(recvDate, recvHm, {
    holidays: ctx.holidays, shipSaturday: truthy_(cfg['週六出貨']), cutoff: cfg['當日截止時間'],
    nearMinutes: Number(cfg['接近截止提醒分鐘'])
  });
  if (res.shipDate) {
    // 客戶指定日期：直接當出貨日；不合理才請客服確認
    var sd = res.shipDate;
    if (sd < recvDate) reasons.push('指定日期 ' + sd + ' 已經過了，請確認出貨日');
    else if (!Core.isShippingDay(sd, ctx.holidays, truthy_(cfg['週六出貨']))) reasons.push('指定日期 ' + sd + ' 不是出貨日，請確認');
    else if (sd === recvDate && ship.date !== recvDate) reasons.push('指定今天出貨，但已過 ' + cfg['當日截止時間'] + ' 截止，請確認');
    ship = { date: sd, nearCutoff: sd === recvDate && ship.nearCutoff };
  }
  if (ship.nearCutoff) reasons.push('接近 ' + cfg['當日截止時間'] + ' 截止，請確認今天是否來得及出貨');

  var trial = truthy_(cfg['試跑模式']);
  var target = ensureSheet_(trial ? LINE_SHEET.TRIAL : SHEET.ORDERS, ORDER_HEADERS);
  var recvAt = new Date(first.ts);
  var stamp = Utilities.formatDate(recvAt, TZ, 'MM/dd HH:mm');

  // 改單／追加／取消：比對同一個 LINE 帳號還沒出貨的訂單
  var prev = findOpenOrders_(target, agent ? chat : seg.userId, segId, recvDate, store);
  var mod = res.modification;
  var implicit = false;
  if (!mod && prev.pending.length && items.length) {
    implicit = true; // 沒寫「改成」「再加」，但同一客戶已有未出貨的單
    var oldProducts = prev.pending.map(function (p) { return p.product; });
    mod = items.some(function (it) { return oldProducts.indexOf(it.product) >= 0; }) ? 'replace' : 'add';
  }
  if (mod === 'cancel') {
    if (prev.pending.length) {
      prev.pending.forEach(function (p) {
        target.getRange(p.row, COL['狀態'] + 1).setValue('待確認');
        target.getRange(p.row, COL['系統訊息'] + 1).setValue('⚠ 客戶 ' + stamp + ' 要求取消，確認後請把狀態改成「取消」\n' + p.sys);
      });
      mark('取消要求');
      return 'unclear';
    }
    reasons.push('客戶要求取消，但找不到未產單的訂單' + (prev.printed.length ? '（可能已產單：' + prev.printed[0].batch + '）' : '') + '，請確認');
  } else if (mod === 'replace') {
    if (prev.pending.length) {
      prev.pending.forEach(function (p) {
        target.getRange(p.row, COL['狀態'] + 1).setValue('取消');
        target.getRange(p.row, COL['系統訊息'] + 1).setValue('（已被 ' + stamp + ' 的改單取代）\n' + p.sys);
      });
      reasons.push((implicit ? '同一客戶又傳了訂單，判斷為改單' : '改單') + '：已依最新訊息更新、舊單已取消，請確認');
    } else if (prev.printed.length) {
      reasons.push('改單：原訂單已產單（批次 ' + prev.printed[0].batch + '），需重印出貨單，請確認');
    } else {
      reasons.push('改單：找不到原訂單，已當成新訂單，請確認');
    }
  } else if (mod === 'add') {
    reasons.push((implicit ? '同一客戶又傳了訂單，判斷為追加' : '追加訂單') + '，原訂單保留，請確認');
  }

  var unclear = kind === 'unclear' || reasons.length > 0;
  var status = unclear ? '待確認' : (trial ? '建議' : '待出貨');
  var sys = (reasons.length ? '⚠ ' + unique_(reasons).join('；') + '\n' : '') + '原文：' + text.slice(0, 300) +
    (images.length ? '\n（含 ' + images.length + ' 張圖片）' : '');
  var shipText = ship.date.replace(/-/g, '/');
  var source = 'LINE|' + seg.userId + '|' + segId;
  var lines = items.length ? items : [{ product: '', qty: '', pin8: 0 }];
  var rows = lines.map(function (it) {
    return [Utilities.getUuid().slice(0, 8), recvAt, shipText, store, it.product, it.qty, it.pin8 || '', unique_(notes).join('/'),
      status, '', '', source, sys, '', '', false, res.priceCombo || ''];
  });
  target.getRange(target.getLastRow() + 1, 1, rows.length, ORDER_HEADERS.length).setValues(rows);
  mark(unclear ? '待確認' : '明確訂單');
  return unclear ? 'unclear' : 'order';
}

/** 同一 LINE 帳號、出貨日還沒到的訂單：未產單（可改）與已產單（需重印） */
function findOpenOrders_(sh, userId, segId, today, store) {
  var out = { pending: [], printed: [] };
  if (sh.getLastRow() < 2) return out;
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, ORDER_HEADERS.length).getValues();
  data.forEach(function (r, i) {
    var src = String(r[COL['來源']]);
    if (src.indexOf('LINE|' + userId + '|') !== 0 || src === 'LINE|' + userId + '|' + segId) return;
    var d = r[COL['出貨日']];
    var ds = isDate_(d) ? fmtDate_(d) : Core.normalizeDate(d);
    if (ds && ds < today) return;
    // 只比對同一家店（代訂帳號、多店帳號底下會有不同店家的單）
    if (store && r[COL['店家']] && Core.storeKey(r[COL['店家']]) !== Core.storeKey(store)) return;
    var item = { row: i + 2, product: r[COL['型號']], batch: r[COL['批次']], sys: String(r[COL['系統訊息']] || '') };
    var st = r[COL['狀態']];
    if (st === '建議' || st === '待確認' || st === '待出貨') out.pending.push(item);
    else if (st === '已產單') out.printed.push(item);
  });
  return out;
}

/** 業務代訂帳號：LINE 名稱在「本公司人員」裡，或備註寫「業務／代訂」 */
function readAgentChats_() {
  var sh = SpreadsheetApp.getActive().getSheetByName(LINE_SHEET.BIND);
  var out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  var staff = splitList_(readConfig_()['本公司人員']);
  sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues().forEach(function (r) {
    if (!r[0] || /^[CR]/.test(String(r[0]))) return; // 群組不算
    var name = String(r[1]), note = String(r[4]);
    if (/業務|代訂/.test(note) || staff.some(function (n) { return n && name.indexOf(n) >= 0; })) out[r[0]] = true;
  });
  return out;
}

function readBindings_() {
  var sh = ensureSheet_(LINE_SHEET.BIND, BIND_HEADERS);
  var map = {};
  if (sh.getLastRow() < 2) return map;
  sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(function (r) {
    var st = String(r[2]).trim();
    if (!r[0] || !st) return;
    map[r[0]] = map[r[0]] || [];
    if (map[r[0]].indexOf(st) < 0) map[r[0]].push(st);
  });
  return map;
}

/** 綁定店家後，把這個帳號尚未填店家的訂單列補上 */
function applyBinding_(userId, store) {
  // 直接綁定舊客戶時，這個對話的新客戶草稿就不需要了
  var draft = SpreadsheetApp.getActive().getSheetByName(NEW_SHEET);
  if (draft && draft.getLastRow() > 1) {
    draft.getRange(2, 1, draft.getLastRow() - 1, NEW_HEADERS.length).getValues().forEach(function (r, i) {
      if (r[NC['LINE對話ID']] === userId && String(r[NC['狀態']]).indexOf('已建檔') !== 0) {
        draft.getRange(i + 2, NC['狀態'] + 1).setValue('已綁定既有店家「' + store + '」，不需建檔');
      }
    });
  }
  var all = readBindings_()[userId] || [];
  if (all.length > 1) return; // 多店帳號：每筆訂單的店家要個別確認，不自動補
  [SHEET.ORDERS, LINE_SHEET.TRIAL].forEach(function (name) {
    var sh = SpreadsheetApp.getActive().getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return;
    var n = sh.getLastRow() - 1;
    var data = sh.getRange(2, 1, n, ORDER_HEADERS.length).getValues();
    data.forEach(function (r, i) {
      if (!r[COL['店家']] && String(r[COL['來源']]).indexOf('LINE|' + userId + '|') === 0) {
        sh.getRange(i + 2, COL['店家'] + 1).setValue(store);
      }
    });
  });
}

/** 新的、尚未綁定的 LINE 帳號：寄一次通知 */
function notifyUnbound_() {
  var sh = ensureSheet_(LINE_SHEET.BIND, BIND_HEADERS);
  if (sh.getLastRow() < 2) return;
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues();
  var agentsNow = readAgentChats_();
  var fresh = [];
  data.forEach(function (r, i) {
    if (r[0] && !String(r[2]).trim() && String(r[4]).indexOf('已通知') < 0 && !/業務|代訂/.test(String(r[4])) && !agentsNow[r[0]]) {
      fresh.push(r);
      sh.getRange(i + 2, 5).setValue('已通知 ' + Utilities.formatDate(new Date(), TZ, 'MM/dd HH:mm'));
    }
  });
  if (!fresh.length) return;
  notify_('【出貨】有 ' + fresh.length + ' 個新的 LINE 帳號，請選擇店家',
    '<p>以下 LINE 帳號第一次傳訊息，請到「' + LINE_SHEET.BIND + '」工作表的「店家」欄選擇是哪一家店（選一次即可）：</p><ul>' +
    fresh.map(function (r) {
      return '<li>' + esc_(r[1] || '（未取得名稱）') + (r[5] ? '　→ 系統建議：<b>' + esc_(r[5]) + '</b>' : '　→ 找不到相符店名') + '</li>';
    }).join('') + '</ul><p>建議正確的話，在「店家」欄選同一家即可。找不到的話若是<b>新客戶</b>：請先在主檔「廠商清冊」建檔（店名、地址、電話、收款條件、價格組合），' +
    '系統產單前會自動同步，再回來選擇店家。這個帳號在綁定前收到的訂單，綁定後會自動補上店家。</p>' +
    '<p><a href="' + SpreadsheetApp.getActive().getUrl() + '">開啟華暉出貨自動化</a></p>', []);
}

/* ───────────── 15:30 待確認提醒 ───────────── */

function remindPending_(today) {
  var list = [];
  [SHEET.ORDERS, LINE_SHEET.TRIAL].forEach(function (name) {
    var sh = SpreadsheetApp.getActive().getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return;
    sh.getRange(2, 1, sh.getLastRow() - 1, ORDER_HEADERS.length).getValues().forEach(function (r) {
      if (r[COL['狀態']] === '待確認') list.push([name, r[COL['店家']] || '（未綁定）', r[COL['型號']], r[COL['數量']], r[COL['系統訊息']]]);
    });
  });
  var nonOrders = [];
  var log = SpreadsheetApp.getActive().getSheetByName(LINE_SHEET.LOG);
  if (log && log.getLastRow() > 1) {
    log.getRange(2, 1, log.getLastRow() - 1, LOG_HEADERS.length).getValues().forEach(function (r) {
      if (r[LOG_COL['判斷']] === '非訂單' && fmtDate_(new Date(r[LOG_COL['收到時間']])) === today && r[LOG_COL['類型']] === 'text') {
        nonOrders.push(String(r[LOG_COL['內容']]).slice(0, 60));
      }
    });
  }
  // 今天與下個出貨日的待出貨：讓客服對照自己在 LINE 答應客戶的日期
  var next = Core.nextShippingDay(today, readHolidays_(), truthy_(readConfig_()['週六出貨']));
  var ship = [];
  var osh = SpreadsheetApp.getActive().getSheetByName(SHEET.ORDERS);
  if (osh && osh.getLastRow() > 1) {
    osh.getRange(2, 1, osh.getLastRow() - 1, ORDER_HEADERS.length).getValues().forEach(function (r) {
      if (r[COL['狀態']] !== '待出貨') return;
      var d = r[COL['出貨日']], ds = isDate_(d) ? fmtDate_(d) : Core.normalizeDate(d);
      if (ds && ds <= next) ship.push([ds <= today ? '今天' : ds.slice(5).replace('-', '/'), r[COL['店家']], r[COL['型號']], r[COL['數量']], r[COL['附註']]]);
    });
  }
  if (!list.length && !nonOrders.length && !ship.length) return;
  var html = '';
  if (ship.length) {
    html += '<p>📦 今天與下個出貨日（' + next.slice(5).replace('-', '/') + '）的待出貨，請對照在 LINE 答應客戶的日期：</p><table border="1" cellpadding="4" style="border-collapse:collapse"><tr><th>出貨</th><th>店家</th><th>品項</th><th>附註</th></tr>' +
      ship.map(function (x) { return '<tr><td>' + esc_(x[0]) + '</td><td>' + esc_(x[1]) + '</td><td>' + esc_(x[2] + ' × ' + x[3]) + '</td><td>' + esc_(x[4] || '') + '</td></tr>'; }).join('') + '</table>';
  }
  if (list.length) {
    html += '<p>還有 <b>' + list.length + '</b> 筆待確認：</p><table border="1" cellpadding="4" style="border-collapse:collapse"><tr><th>工作表</th><th>店家</th><th>品項</th><th>原因／原文</th></tr>' +
      list.map(function (x) { return '<tr><td>' + esc_(x[0]) + '</td><td>' + esc_(x[1]) + '</td><td>' + esc_((x[2] || '?') + ' × ' + (x[3] || '?')) + '</td><td>' + esc_(x[4]).replace(/\n/g, '<br>') + '</td></tr>'; }).join('') + '</table>';
  }
  if (nonOrders.length) {
    html += '<p>今天判斷為「不是訂單」的訊息（請掃一眼，有漏判的再補單）：</p><ul>' +
      nonOrders.map(function (t) { return '<li>' + esc_(t) + '</li>'; }).join('') + '</ul>';
  }
  html += '<p><a href="' + SpreadsheetApp.getActive().getUrl() + '">開啟華暉出貨自動化</a></p>';
  notify_('【出貨】' + today + ' 待確認 ' + list.length + ' 筆、待出貨 ' + ship.length + ' 筆', html, []);
}

/* ───────────── Claude 判讀 ───────────── */

var AI_SYSTEM_PROMPT = [
  '你是華暉興業（Gogoro 周邊電池供應商）的訂單助理，負責從店家在 LINE 傳來的訊息中整理訂單。',
  '只根據訊息與圖片中明確寫出的內容抽取品項與數量，不要猜測；不確定的地方寫進 concerns，由客服確認。',
  '規則：',
  '- 品項只能從提供的型號清單中選擇。',
  '- 「10+1」代表訂 10 個，贈品由系統另外計算，數量填 10，不要自己加 1。',
  '- DCB-6000 沒寫 pin 數就是 4pin，pin8 填 0；明確寫 8pin 的數量才填進 pin8。',
  '- 「不需工具／不用工具」是備註，不是訂購工具；「工具」指小電池工具組。',
  '- 型號可能打錯字（GBP-2000＝GPB-2000、GPB-6000＝DCB-6000）、數量可能是中文（十顆、兩顆）或和型號分在不同行，請合在一起判斷。',
  '- 「小電池」「小電」「備用電池」「電池」「一次20個」「幫我出10+1」等沒有型號的訊息：',
  '  若有提供這家店最近的訂單，以最近一筆電池類型號（GPB-2000／A／S、DCB-6000、GPB-3600）當作品項，數量照這次訊息，並在 concerns 寫「依歷史訂單推測型號」；',
  '  沒有歷史訂單可參考時，items 留空，concerns 寫明「沒有型號」。',
  '- 圖片若是促銷文宣，請依文宣上的型號與方案判斷，並在 concerns 說明依據。',
  '- 詢問、道謝、匯款通知、催貨、客訴不是訂單：is_order 為 false、items 留空。',
  '- 指定日期、送貨時間、統編發票、記帳、改單等特殊要求，寫進 concerns。',
  'concerns 與 notes 請用繁體中文、簡短。'
].join('\n');

function aiSchema_(products) {
  return {
    type: 'object', additionalProperties: false,
    required: ['is_order', 'items', 'concerns', 'notes'],
    properties: {
      is_order: { type: 'boolean' },
      items: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          required: ['product', 'qty', 'pin8', 'evidence'],
          properties: {
            product: { type: 'string', enum: products },
            qty: { type: 'integer' },
            pin8: { type: 'integer' },
            evidence: { type: 'string' }
          }
        }
      },
      concerns: { type: 'array', items: { type: 'string' } },
      notes: { type: 'string' }
    }
  };
}

/** 回傳 { is_order, items, concerns, notes } 或 { error } */
function askClaude_(text, images, ctx, store, imageBlobs) {
  var key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) return { error: '尚未設定 Claude API 金鑰' };
  var budget = Number(ctx.cfg['AI每月上限美元']);
  if (budget > 0 && aiMonthCost_() >= budget) return { error: '本月 AI 預算 US$' + budget + ' 已用完，請客服判斷' };
  var model = String(ctx.cfg['AI模型'] || 'claude-opus-5-5').trim();
  var aliasText = '型號清單：' + ctx.products.join('、') + '\n客戶常用說法：' +
    ctx.aliases.map(function (a) { return a.alias + '→' + a.product + (a.pin ? '（' + a.pin + 'pin）' : ''); }).join('、');

  var content = [];
  (imageBlobs || []).slice(0, 3).forEach(function (blob) {
    content.push({ type: 'image', source: { type: 'base64', media_type: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) } });
  });
  images.slice(0, 3).forEach(function (img) {
    var blob = lineContent_(img.messageId);
    if (blob) content.push({ type: 'image', source: { type: 'base64', media_type: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) } });
  });
  // 只附這家店最近 3 筆訂單當參考（幾十個 token），不送整份歷史
  var recent = '';
  if (store) {
    ctx.history = ctx.history || readHistory_();
    var r = Parser.recentFor(store, ctx.history, 3);
    if (r.length) recent = '這家店最近的訂單（僅供參考，以這次訊息為準）：' + r.map(function (h) { return h.date + ' ' + h.product + ' × ' + h.qty; }).join('；') + '\n';
  }
  content.push({ type: 'text', text: recent + '以下是同一位店家連續傳來的訊息（已合併）：\n' + (text || '（只有圖片）') });

  var body = {
    model: model,
    max_tokens: 8000,
    system: [{ type: 'text', text: AI_SYSTEM_PROMPT + '\n\n' + aliasText }],
    messages: [{ role: 'user', content: content }],
    output_config: { effort: String(ctx.cfg['AI思考強度'] || 'low').trim(), format: { type: 'json_schema', schema: aiSchema_(ctx.products) } }
  };
  var headers = { 'x-api-key': key, 'anthropic-version': '2026-10-21' };
  if (/^claude-(fable-5-[12]|opus-5-5|opus-5|sonnet-5-5)$/.test(model)) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default'; // 安全分類器拒答時自動改用其他模型
  }
  var res;
  try {
    res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json', headers: headers, payload: JSON.stringify(body), muteHttpExceptions: true
    });
  } catch (e) {
    return { error: '連線失敗' };
  }
  var code = res.getResponseCode();
  if (code !== 200) {
    console.error('Claude API ' + code + ': ' + res.getContentText().slice(0, 500));
    return { error: 'HTTP ' + code };
  }
  var json = JSON.parse(res.getContentText());
  var usedCost = recordAiUsage_(json, model, text);
  if (json.stop_reason === 'refusal') return { error: 'AI 拒絕判讀' };
  if (json.stop_reason === 'max_tokens') return { error: '回應過長被截斷' };
  var block = (json.content || []).filter(function (b) { return b.type === 'text'; })[0];
  if (!block) return { error: '沒有回應內容' };
  var out;
  try { out = JSON.parse(block.text); } catch (e) { return { error: '回應格式錯誤' }; }

  var valid = [], concerns = (out.concerns || []).slice();
  (out.items || []).forEach(function (it) {
    var q = Number(it.qty), p8 = Number(it.pin8) || 0;
    if (ctx.products.indexOf(it.product) < 0 || !(q > 0) || Math.floor(q) !== q || p8 < 0 || p8 > q) {
      concerns.push('略過不合理的品項：' + it.product + ' × ' + it.qty);
      return;
    }
    valid.push({ product: it.product, qty: q, pin8: it.product === 'DCB-6000' ? p8 : 0 });
  });
  return { is_order: !!out.is_order, items: valid, concerns: concerns, notes: String(out.notes || '').trim(), model: json.model || model, cost: usedCost || 0 };
}

/* ───────────── AI 費用控管 ───────────── */

// 每百萬 tokens 的美元價格（輸入、輸出）；其他模型以 Opus 計，寧可高估
var AI_PRICES = {
  'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.10, 0.50]
};
var AI_LOG_HEADERS = ['時間', '模型', '輸入tokens', '輸出tokens', '估計費用USD', '訊息摘要'];

function aiCostOf_(usage, model) {
  var p = AI_PRICES[model] || AI_PRICES['claude-opus-5-5'];
  var u = usage || {};
  var input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1;
  return (input * p[0] + (u.output_tokens || 0) * p[1]) / 1e6;
}

function recordAiUsage_(json, model, text) {
  try {
    var u = json.usage || {};
    var cost = aiCostOf_(u, json.model || model);
    var props = PropertiesService.getScriptProperties();
    var key = 'aiCost:' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
    props.setProperty(key, String((Number(props.getProperty(key)) || 0) + cost));
    ensureSheet_('AI使用紀錄', AI_LOG_HEADERS).appendRow([new Date(), json.model || model, u.input_tokens || 0, u.output_tokens || 0,
      Math.round(cost * 10000) / 10000, String(text || '').slice(0, 60)]);
    return cost;
  } catch (e) { console.error('記錄 AI 用量失敗', e); return 0; }
}

function aiMonthCost_() {
  return Number(PropertiesService.getScriptProperties().getProperty('aiCost:' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM'))) || 0;
}

/** 選單：用範例訊息實際呼叫一次，確認金鑰與設定可用 */
function menuTestAi() {
  var cfg = readConfig_();
  var ctx = { cfg: cfg, aliases: readAliases_(), products: unique_(readProducts_()), history: [] };
  var sample = '老闆我要訂小電池A款十顆，另外直流的也來兩顆8pin，不用工具';
  var started = Date.now();
  var r = askClaude_(sample, [], ctx, '');
  var secs = ((Date.now() - started) / 1000).toFixed(1);
  if (r.error) { showResult_({ message: '❌ AI 呼叫失敗：' + r.error + '\n\n請確認「設定金鑰」裡的 Claude 金鑰，以及 Claude Console 是否已儲值。' }); return; }
  showResult_({ message: '✅ AI 連線正常（' + secs + ' 秒）\n\n範例：' + sample + '\n判讀：' +
    (r.items.map(function (it) { return it.product + ' × ' + it.qty + (it.pin8 ? '（8pin ' + it.pin8 + '）' : ''); }).join('、') || '（無品項）') +
    (r.concerns.length ? '\n疑點：' + r.concerns.join('；') : '') +
    '\n\n設定的模型：' + (cfg['AI模型'] || 'claude-opus-5-5') + '　實際回應：' + r.model + '　這次費用：US$' + r.cost.toFixed(4) + '\n本月累計估計費用：US$' + aiMonthCost_().toFixed(4) +
    '（上限 US$' + (Number(cfg['AI每月上限美元']) || '不限') + '）' });
}

/* ───────────── 金鑰 ───────────── */

function menuSetKeys() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var ask = function (title, prop) {
    var r = ui.prompt(title, '貼上後按「確定」；不更改請直接按「取消」。（金鑰只存在 Apps Script，不會出現在試算表）', ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() === ui.Button.OK && r.getResponseText().trim()) props.setProperty(prop, r.getResponseText().trim());
  };
  ask('LINE Channel access token（長期）', 'LINE_TOKEN');
  ask('Claude API 金鑰（可先略過）', 'ANTHROPIC_API_KEY');
  if (!props.getProperty('FORWARD_SECRET')) props.setProperty('FORWARD_SECRET', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  ui.alert('轉送密鑰（請貼到 Cloudflare 的 FORWARD_SECRET）', props.getProperty('FORWARD_SECRET') +
    '\n\n目前狀態：LINE token ' + (props.getProperty('LINE_TOKEN') ? '已設定' : '未設定') +
    '；Claude 金鑰 ' + (props.getProperty('ANTHROPIC_API_KEY') ? '已設定' : '未設定'), ui.ButtonSet.OK);
}

/** 訊息紀錄：已處理且超過 days 天的移到「訊息紀錄封存」，主表保持精簡 */
function archiveLog_(days) {
  var log = SpreadsheetApp.getActive().getSheetByName(LINE_SHEET.LOG);
  if (!log || log.getLastRow() < 2) return 0;
  var cutoff = Date.now() - days * 86400000;
  var data = log.getRange(2, 1, log.getLastRow() - 1, LOG_HEADERS.length).getValues();
  var old = [], oldRows = [];
  data.forEach(function (r, i) {
    var t = new Date(r[LOG_COL['收到時間']]).getTime();
    if (r[LOG_COL['狀態']] !== '未處理' && t < cutoff) { old.push(r); oldRows.push(i + 2); }
  });
  if (!old.length) return 0;
  // 先複製到封存表，再只刪除已封存的列（未處理的訊息完全不動）
  var arc = ensureSheet_(LINE_SHEET.LOG + '封存', LOG_HEADERS);
  arc.getRange(arc.getLastRow() + 1, 1, old.length, LOG_HEADERS.length).setValues(old);
  // 由下往上、把連續的列一次刪除
  for (var k = oldRows.length - 1; k >= 0;) {
    var end = oldRows[k], start = end;
    while (k - 1 >= 0 && oldRows[k - 1] === start - 1) { k--; start--; }
    log.deleteRows(start, end - start + 1);
    k--;
  }
  return old.length;
}

function unique_(arr) { return arr.filter(function (x, i) { return x !== '' && arr.indexOf(x) === i; }); }


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


/**
 * 電力盒回收：寫入主檔「N月電力盒回收統計」，並在下次出貨單折抵「折貨款」。
 * 只寫入日期、客戶名稱、完整版數量；打勾欄留給人工確認。
 * 備註含「折貨款」且未打勾 → 下次產單時把總金額填入折讓，並在備註加註「已於…折抵」避免重複。
 * 打勾欄已勾 → 已處理完成，系統不動。
 */

/** 主檔裡所有回收統計區塊 */
function recycleBlocks_() {
  var id = mainIds_()[0];
  if (!id) throw new Error('請先在「設定」填入主檔試算表ID');
  var out = [];
  SpreadsheetApp.openById(id).getSheets().forEach(function (sh) {
    var n = Math.min(sh.getLastRow(), 600);
    if (n < 2) return;
    var colA = sh.getRange(1, 1, n, 1).getDisplayValues().map(function (r) { return r[0]; });
    Core.findRecycleBlocks(colA).forEach(function (b) {
      if (!b.subtotalRow) return;
      var width = Math.max(sh.getLastColumn(), 10);
      b.sheet = sh;
      b.cols = Core.recycleColumns(sh.getRange(b.headerRow, 1, 1, width).getDisplayValues()[0]);
      if (b.cols.store >= 0 && b.cols.qty >= 0) out.push(b);
    });
  });
  return out;
}

/** 回收寫入當月區塊的下一個空白列；沒有空白列時在「小計」上方插入一列（沿用上一列的公式與格式） */
function recordRecycle_(date, store, qty) {
  var month = date.getMonth() + 1;
  var all = recycleBlocks_();
  var blocks = all.filter(function (b) { return b.month === month; });
  var b = blocks.length ? blocks[blocks.length - 1] : createMonthBlock_(all, month);
  var sh = b.sheet, c = b.cols;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var target = 0;
    if (b.subtotalRow > b.firstRow) {
      // 整列（公式與打勾框以外）都是空的才寫入，避免和別人先填的備註、匯款日期混在一起
      var width = Math.max(sh.getLastColumn(), 10);
      var rng = sh.getRange(b.firstRow, 1, b.subtotalRow - b.firstRow, width);
      var vals = rng.getValues(), fx = rng.getFormulas();
      for (var i = 0; i < vals.length; i++) {
        var empty = vals[i].every(function (v, k) { return fx[i][k] || k === c.done || v === '' || v === false || v === null || v === 0; });
        if (empty) { target = b.firstRow + i; break; }
      }
    }
    if (!target) {
      var oldSub = b.subtotalRow;
      sh.insertRowBefore(oldSub);
      target = oldSub;
      // 小計列下移一列；把它的 SUM 範圍延伸到新列
      var subRange = sh.getRange(oldSub + 1, 1, 1, sh.getLastColumn());
      var subF = subRange.getFormulas()[0];
      subF.forEach(function (fx, k) {
        if (fx) { var nf = Core.extendRangeEnd(fx, oldSub - 1); if (nf !== fx) sh.getRange(oldSub + 1, k + 1).setFormula(nf); }
      });
      var prev = target - 1;
      if (prev >= b.firstRow) {
        sh.getRange(prev, 1, 1, sh.getLastColumn()).copyTo(sh.getRange(target, 1, 1, sh.getLastColumn()));
        // 只保留公式、格式與打勾框，清掉上一列的資料
        var row = sh.getRange(target, 1, 1, sh.getLastColumn());
        var f = row.getFormulas()[0];
        f.forEach(function (x, k) { if (!x && k !== c.done) sh.getRange(target, k + 1).clearContent(); });
        if (c.done >= 0) sh.getRange(target, c.done + 1).setValue(false);
      }
    }
    if (c.date >= 0) sh.getRange(target, c.date + 1).setValue(date);
    sh.getRange(target, c.store + 1).setValue(store);
    sh.getRange(target, c.qty + 1).setValue(qty);
    return sh.getName() + ' 第 ' + target + ' 列';
  } finally {
    lock.releaseLock();
  }
}

/**
 * 當月區塊不存在：把最後一個月份區塊（標題到小計）整段複製到它下方，清空資料、改標題月份。
 * 公式、下拉選單、打勾框、格式都沿用；只新增列，不改動既有資料。
 */
function createMonthBlock_(all, month) {
  if (!all.length) throw new Error('主檔找不到任何「N月電力盒回收統計」可以參考，請先手動建立 ' + month + ' 月的表');
  var prev = all[all.length - 1];
  var sh = prev.sheet;
  var height = prev.subtotalRow - prev.titleRow + 1;
  var width = Math.max(sh.getLastColumn(), 10);
  var start = prev.subtotalRow + 2; // 空一列
  var lastUsed = sh.getLastRow();
  if (start <= lastUsed) {
    var region = sh.getRange(start, 1, Math.min(height, lastUsed - start + 1), width).getValues();
    if (region.some(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); })) start = lastUsed + 2;
  }
  if (sh.getMaxRows() < start + height) sh.insertRowsAfter(sh.getMaxRows(), start + height - sh.getMaxRows());
  sh.getRange(prev.titleRow, 1, height, width).copyTo(sh.getRange(start, 1, height, width));
  var title = String(sh.getRange(prev.titleRow, 1).getDisplayValue()).replace(/\d{1,2}(\s*月)/, month + '$1');
  sh.getRange(start, 1).setValue(title);
  // 清空資料列中「不是公式」的格子；打勾框改回未勾
  var c = prev.cols;
  var firstData = start + (prev.firstRow - prev.titleRow), dataRows = prev.subtotalRow - prev.firstRow;
  if (dataRows > 0) {
    var rng = sh.getRange(firstData, 1, dataRows, width);
    var f = rng.getFormulas();
    for (var i = 0; i < dataRows; i++) {
      for (var k = 0; k < width; k++) {
        if (f[i][k]) continue;
        if (k === c.done) sh.getRange(firstData + i, k + 1).setValue(false);
        else sh.getRange(firstData + i, k + 1).clearContent();
      }
    }
  }
  var created = { month: month, titleRow: start, headerRow: start + 1, firstRow: firstData, subtotalRow: start + height - 1, sheet: sh, cols: c };
  notify_('【出貨】已在主檔建立「' + title + '」', '<p>收到 ' + month + ' 月的第一筆回收，主檔還沒有當月的回收統計，系統已照上個月的格式在「' +
    esc_(sh.getName()) + '」第 ' + start + ' 列建立新表，請確認。</p>', []);
  return created;
}

/** 所有區塊中的回收資料列 */
function readRecycleRows_() {
  var rows = [];
  recycleBlocks_().forEach(function (b) {
    if (b.subtotalRow <= b.firstRow) return;
    var c = b.cols;
    var width = Math.max(c.store, c.total, c.note, c.done) + 1;
    b.sheet.getRange(b.firstRow, 1, b.subtotalRow - b.firstRow, width).getValues().forEach(function (r, i) {
      rows.push({
        sheet: b.sheet, row: b.firstRow + i, noteCol: c.note,
        store: String(r[c.store] || '').trim(), total: c.total >= 0 ? r[c.total] : 0,
        note: c.note >= 0 ? String(r[c.note] || '') : '', done: c.done >= 0 ? r[c.done] === true : false
      });
    });
  });
  return rows;
}

/** 產單前：把「折貨款」加到各店的折讓金額 */
function applyRecycleCredits_(groups) {
  var rows;
  try { rows = readRecycleRows_(); } catch (e) { console.error('讀取回收統計失敗', e); return ''; }
  var lines = [];
  groups.forEach(function (g) {
    var credits = Core.recycleCredits(rows, g.store).filter(function (r) { return r.noteCol >= 0; });
    if (!credits.length) return;
    var sum = credits.reduce(function (a, r) { return a + Number(r.total); }, 0);
    g.discount = (Number(g.discount) || 0) + sum;
    g.recycleUsed = credits;
    lines.push(g.store + ' 折抵回收貨款 ' + sum + ' 元');
  });
  return lines.length ? '<p>♻ 回收折貨款已填入折讓金額：' + lines.map(esc_).join('、') + '（已在回收統計備註註明；確認後請手動打勾）</p>' : '';
}

/** 產單成功後：在回收統計備註註明已折抵，避免下次重複折抵（打勾仍由人工） */
function markRecycleUsed_(groups, today) {
  groups.forEach(function (g) {
    (g.recycleUsed || []).forEach(function (r) {
      r.sheet.getRange(r.row, r.noteCol + 1).setValue(r.note + '（已於 ' + today.slice(5).replace('-', '/') + ' 單據 ' + g.orderNo + ' 折抵）');
    });
  });
}


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
  step('新客戶待建檔', function () { formatNewCustomerSheet_(ensureSheet_(NEW_SHEET, NEW_HEADERS)); });
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
  var order = ['總覽', SHEET.ORDERS, LINE_SHEET.TRIAL, LINE_SHEET.BIND, NEW_SHEET, SHEET.CONFIG, SHEET.ALIASES, SHEET.HOLIDAYS, SHEET.PARSE_TEST,
    LINE_SHEET.LOG, 'AI使用紀錄', SHEET.BATCHES, SHEET.INVOICE, SHEET.LABEL, SHEET.VENDORS];
  var colors = {};
  colors[SHEET.ORDERS] = '#2f7d4f'; colors[LINE_SHEET.TRIAL] = '#7fa8ee'; colors[LINE_SHEET.BIND] = '#f6c453'; colors[NEW_SHEET] = '#a3620a';
  [LINE_SHEET.LOG, 'AI使用紀錄', SHEET.BATCHES, SHEET.INVOICE, SHEET.LABEL, SHEET.VENDORS].forEach(function (n) { colors[n] = '#9aa3af'; });
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
