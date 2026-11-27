// 把 Core.js + Main.js 合併成一個檔案，方便直接貼進 Apps Script
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, 'apps-script', f), 'utf8');
const version = new Date().toISOString().slice(0, 16).replace('T', ' ');
const out = [
  '/* 華暉出貨自動化：請整份貼進 Apps Script 的 Code.gs（取代原本內容）。由 scripts/bundle.js 產生，請勿手改。 */',
  "var APP_VERSION = '" + version + "';",
  read('Core.js'),
  read('Parser.js'),
  read('Xlsx.js'),
  read('Main.js'),
  read('Line.js'),
  read('Customers.js'),
  read('Recycle.js'),
  read('Ui.js')
].join('\n\n');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', '華暉出貨_一次貼上.gs'), out);
console.log('dist/華暉出貨_一次貼上.gs', out.length, 'chars');
