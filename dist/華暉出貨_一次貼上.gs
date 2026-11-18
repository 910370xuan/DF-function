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

  function validateRow(r, vendorSet, productSet) {
    if (!r.store) return '缺少店家';
    if (!vendorSet[r.store]) return '店家不在廠商清冊：' + r.store;
    if (!r.product) return '缺少型號';
    if (!productSet[r.product]) return '型號不在出貨單價格表：' + r.product;
    var q = Number(r.qty);
    if (!(q > 0) || Math.floor(q) !== q) return '數量必須是正整數';
    var p8 = Number(r.pin8) || 0;
    if (p8 < 0 || p8 > q || Math.floor(p8) !== p8) return '8pin 數量不正確';
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
    ['GPB-2000A', 'GPB-2000A'], ['A款', 'GPB-2000A'],
    ['GPB-2000S', 'GPB-2000S'], ['S款', 'GPB-2000S'],
    ['GPB-2000', 'GPB-2000'], ['GPB2000', 'GPB-2000'], ['一般的', 'GPB-2000'], ['2000', 'GPB-2000'],
    ['DCB-6000', 'DCB-6000'], ['DCB6000', 'DCB-6000'], ['直流電力盒', 'DCB-6000'], ['電力盒', 'DCB-6000'],
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
  var SPECIAL_PATTERNS = [
    [/下週|下周|下禮拜|禮拜[一二三四五六日天]|星期[一二三四五六日天]|週[一二三四五六日]|明天|後天|今天|\d{1,2}\s*[\/月]\s*\d{1,2}/, '有指定日期'],
    [/中午|上午|下午|晚上|早上|\d{1,2}\s*點|營業後|之後送|再送|後送|先不要|延後/, '有指定時間或送貨要求'],
    [/統編|發票|收據/, '要統編或發票'],
    [/記帳|下個月帳|月結|月底結|賒/, '帳務備註'],
    [/取消|不要了|改成|改為|更正|修改|換成|追加|多加|再加|加訂/, '改單或追加'],
    [/還沒收到|沒收到|少寄|寄錯|退貨|換貨|瑕疵|壞/, '客訴或售後']
  ];
  var NO_TOOL = /(不需|不用|不要|免)(要)?(帶)?(小電池)?工具(組)?/g;

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
      var re = new RegExp(/^\d+$/.test(key) ? '(?<![\\d\\-])' + escapeRe(key) + '(?![\\dA-Z])' : escapeRe(key), 'g');
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
    var raw = normalize(text);
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
    var vagueQty = 0, pendingDcb = false, mentioned = false;

    lines.forEach(function (line) {
      if (isQuestion(line)) return; // 詢問句不算下單
      var hits = findProducts(line, aliases);
      if (hits.length) mentioned = true;
      if (!hits.length) {
        var vm = line.match(/(\d+)\s*\+\s*1/) || (VAGUE_WORDS.some(function (w) { return line.indexOf(w) >= 0; }) && line.match(new RegExp('(\\d+)\\s*' + UNIT)));
        if (vm) vagueQty += Number(vm[1]);
        return;
      }
      // 同一行連續的 DCB 別名（例：4pin直流電力盒、4PIN 直流）視為同一個品項
      var groups = [];
      hits.forEach(function (h) {
        var last = groups[groups.length - 1];
        if (last && last.product === 'DCB-6000' && h.product === 'DCB-6000' &&
            /^[\s()]*$/.test(line.slice(last.end, h.start))) {
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
          reasons.push('「' + g.product + '」沒有數量');
          return;
        }
        items.push({ product: g.product, qty: qty, pin8: g.product === 'DCB-6000' && g.pin === 8 ? qty : 0 });
      });
    });

    if (pendingDcb && !items.some(function (it) { return it.product === 'DCB-6000'; })) reasons.push('「DCB-6000」沒有數量');

    // 合併同型號（DCB 的 4pin / 8pin 加總）
    var merged = [];
    items.forEach(function (it) {
      var m = merged.filter(function (x) { return x.product === it.product; })[0];
      if (m) { m.qty += it.qty; m.pin8 += it.pin8; } else merged.push({ product: it.product, qty: it.qty, pin8: it.pin8 });
    });

    SPECIAL_PATTERNS.forEach(function (p) { if (p[0].test(raw)) reasons.push(p[1]); });
    if (noTool) notes.push('不需工具');
    if (opts.hasImage) reasons.push('含圖片，需人工看圖');
    if (vagueQty) reasons.push('沒寫型號（' + vagueQty + ' 個），需查上一筆訂單');

    var kind;
    if (!merged.length && !vagueQty && !opts.hasImage && !mentioned) kind = 'not_order';
    else if (!merged.length || reasons.length) kind = 'unclear';
    else kind = 'order';
    // 沒有任何品項、只是客訴或閒聊的訊息不列為訂單
    if (kind === 'unclear' && !merged.length && !vagueQty && !opts.hasImage && !mentioned) kind = 'not_order';

    return { kind: kind, items: merged, notes: notes, reasons: unique(reasons), vague: vagueQty ? { qty: vagueQty } : null };
  }

  /** 從歷史訂單找這家店最近一次的電池類品項，給「小電池」「幫我出10+1」當建議 */
  function suggestFromHistory(store, history, exclude) {
    exclude = exclude || /工具|起子|批頭|線組/;
    var rows = (history || []).filter(function (h) { return h.store === store && h.product && !exclude.test(h.product); });
    rows.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    return rows.length ? { product: rows[0].product, qty: Number(rows[0].qty), date: rows[0].date } : null;
  }

  function unique(arr) { return arr.filter(function (x, i) { return arr.indexOf(x) === i; }); }

  /** 新版才加入的對照，舊的「型號對照」工作表會自動補上 */
  var ADDED_ALIASES = ['小電池工具組', '工具組', '工具'];

  return { DEFAULT_ALIASES: DEFAULT_ALIASES, ADDED_ALIASES: ADDED_ALIASES, normalize: normalize, parse: parse, suggestFromHistory: suggestFromHistory };
})();

if (typeof module !== 'undefined') module.exports = Parser;


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

var ORDER_HEADERS = ['訂單ID', '收單時間', '出貨日', '店家', '型號', '數量', '8pin數', '附註', '狀態', '批次', '單據編號', '來源', '系統訊息', '折讓金額', '已收金額'];
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
  ['出貨單列印列', '1-57', '第一聯＋第二聯印在同一頁（對應原本第 57 列的分頁符號）'],
  ['出貨單列印欄數', 9, 'A～I 欄'],
  ['出貨單清空欄位', 'B17,E17', '模板上手動輸入的欄位（折讓金額、已收金額），產單前清空；是公式則不動'],
  ['貨運單第一頁列', '1-41', '對應原本第 41 列的分頁符號'],
  ['貨運單第二頁列', '42-84', ''],
  ['貨運單列印欄數', 9, 'A～I 欄'],
  ['出貨單縮放比例', 68, '%；與 Google 試算表列印的「依分頁符號自動調整（68%）」相同'],
  ['貨運單縮放比例', 68, '%；貼紙對不準時微調，例如 67 或 69'],
  ['列印上下邊界', 0.75, '英吋；Google「標準」邊界＝上下 0.75'],
  ['列印左邊界', 0.7, '英吋；Google「標準」邊界＝左右 0.7；貼紙整體偏左就加大、偏右就減小'],
  [SUPPLEMENT_KEY, false, '勾選後立即產生補單（手機也可以）']
];

/* ───────────── 選單與觸發 ───────────── */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('華暉出貨')
    .addItem('產生今日主批次', 'menuMainBatch')
    .addItem('產生補單', 'menuSupplement')
    .addSeparator()
    .addItem('解析測試（貼訊息試辨識）', 'runParseTest')
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

    var folder = cfg['輸出資料夾ID'] ? DriveApp.getFolderById(cfg['輸出資料夾ID']) : DriveApp.getRootFolder();
    var invSS = buildInvoices_(ss, built.groups, today, cfg, tmpSheets);
    var lblSS = buildLabels_(ss, built.groups.map(function (g) { return g.store; }), cfg, tmpSheets);

    var name = batchId + '_' + type;
    var invParams = printParams_(mustSheet_(SHEET.INVOICE), Number(cfg['出貨單列印欄數']) || 9, cfg['出貨單縮放比例'], cfg);
    var lblParams = printParams_(mustSheet_(SHEET.LABEL), Number(cfg['貨運單列印欄數']) || 9, cfg['貨運單縮放比例'], cfg);
    var invPdf = folder.createFile(exportBlob_(invSS.getId(), 'pdf', invParams).setName('出貨單_' + name + '.pdf'));
    var lblPdf = folder.createFile(exportBlob_(lblSS.getId(), 'pdf', lblParams).setName('貨運單_' + name + '.pdf'));
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
function newOutput_(ss, name) {
  var out = SpreadsheetApp.create(name);
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
  var left = Number(cfg['列印左邊界']);
  if (isNaN(left)) left = 0.7;
  var right = 8.27 - left - px * scale / 96;
  if (right < 0) throw new Error('縮放 ' + pct + '% 時內容比紙寬，請調小縮放比例或左邊界');
  return 'size=A4&portrait=true&scale=2&top_margin=' + tb + '&bottom_margin=' + tb +
    '&left_margin=' + left + '&right_margin=' + right.toFixed(3) + '&horizontal_alignment=LEFT&vertical_alignment=TOP';
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
  var obsolete = ['出貨單第一聯列', '出貨單第二聯列', '列印欄數', '出貨單PDF參數', '貨運單PDF參數', '出貨單列印設定', '貨運單列印設定'];
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
    if (k[0] === SUPPLEMENT_KEY || k[0] === '週六出貨') cfg.getRange(i + 1, 2).insertCheckboxes();
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

  ensureSheet_(SHEET.BATCHES, BATCH_HEADERS);
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
