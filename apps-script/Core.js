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

  /** 買十送一：同一行、同品項，每 10 個送 1 個，不跨品項、不跨訂單累計 */
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
      if (list.length > INVOICE_MAX_LINES) {
        list.forEach(function (r) {
          errors.push({ rowId: r.id, message: '同一家店超過 ' + INVOICE_MAX_LINES + ' 行品項，出貨單放不下，請拆單或人工處理' });
        });
        return;
      }
      groups.push({
        store: store,
        duplicateVendor: !!dupVendors[store],
        rowIds: list.map(function (r) { return r.id; }),
        lines: list.map(function (r) {
          return { product: r.product, qty: Number(r.qty), note: buildNote(r, opts.eligible) };
        })
      });
    });
    return { groups: groups, errors: errors };
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
