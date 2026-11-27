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
  function suggestFromHistory(store, history, exclude, prefer) {
    exclude = exclude || /工具|起子|批頭|線組/;
    var key = storeKey(store);
    var rows = (history || []).filter(function (h) { return storeKey(h.store) === key && h.product && !exclude.test(h.product); });
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
    var key = storeKey(store);
    var row = table.rows.filter(function (r) { return storeKey(r[0]) === key; })[0];
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
    var key = storeKey(store);
    var rows = (history || []).filter(function (h) { return storeKey(h.store) === key && h.product; });
    rows.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    return rows.slice(0, n || 3).map(function (h) { return { product: h.product, qty: Number(h.qty), date: h.date }; });
  }

  /**
   * 新 LINE 帳號：用 LINE 名稱與訊息內容比對廠商清冊，找出最可能的店家。
   * 完整店名出現最優先，其次是去掉「車業／有限公司」等字尾後的店名核心（至少 2 字）。
   * 有兩家以上同分時不建議（回傳 ''），交給客服選。
   */
  var SUFFIX = /(股份有限公司|有限公司|企業社|工作室|車業行|機車行|車業|車行|電動車|電能車業|電能|動能|社區店|商行|科技|國際|實業|企業|貿易|智能|行)$/;
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
  var ADDED_ALIASES = ['小電池工具組', '工具組', '工具', '2000A', '2000S', 'GPB-6000', '6000'];

  return { DEFAULT_ALIASES: DEFAULT_ALIASES, ADDED_ALIASES: ADDED_ALIASES, recentFor: recentFor, storeKey: storeKey, topProduct: topProduct, suggestVendor: suggestVendor, extractDate: extractDate, matchStore: matchStore, addrKey: addrKey, extractContact: extractContact, newCustomerCombo: newCustomerCombo, normalize: normalize, parse: parse, suggestFromHistory: suggestFromHistory };
})();

if (typeof module !== 'undefined') module.exports = Parser;
