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
  '- 只說「小電池」「小電」「幫我出10+1」等沒有型號的訊息：items 留空，concerns 寫明「沒有型號」。',
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
function askClaude_(text, images, ctx, store) {
  var key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) return { error: '尚未設定 Claude API 金鑰' };
  var budget = Number(ctx.cfg['AI每月上限美元']);
  if (budget > 0 && aiMonthCost_() >= budget) return { error: '本月 AI 預算 US$' + budget + ' 已用完，請客服判斷' };
  var model = String(ctx.cfg['AI模型'] || 'claude-opus-5-5').trim();
  var aliasText = '型號清單：' + ctx.products.join('、') + '\n客戶常用說法：' +
    ctx.aliases.map(function (a) { return a.alias + '→' + a.product + (a.pin ? '（' + a.pin + 'pin）' : ''); }).join('、');

  var content = [];
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
  recordAiUsage_(json, model, text);
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
  return { is_order: !!out.is_order, items: valid, concerns: concerns, notes: String(out.notes || '').trim() };
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
  } catch (e) { console.error('記錄 AI 用量失敗', e); }
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
    '\n\n模型：' + (cfg['AI模型'] || 'claude-opus-5-5') + '\n本月累計估計費用：US$' + aiMonthCost_().toFixed(4) +
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
