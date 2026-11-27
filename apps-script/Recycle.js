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
      var vals = sh.getRange(b.firstRow, 1, b.subtotalRow - b.firstRow, Math.max(c.store, c.qty) + 1).getValues();
      for (var i = 0; i < vals.length; i++) {
        if (!String(vals[i][c.store]).trim() && !String(vals[i][c.qty]).trim() && (c.date < 0 || !String(vals[i][c.date]).trim())) { target = b.firstRow + i; break; }
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
