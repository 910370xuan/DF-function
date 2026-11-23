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
