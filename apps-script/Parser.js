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
