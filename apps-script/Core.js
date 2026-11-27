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
