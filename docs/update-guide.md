# 更新版本後的重新串連步驟（約 5 分鐘）

```
GitHub main ──自動──▶ Cloudflare Worker（不用動）
     │
     └─手動複製──▶ Apps Script ──▶ 初始化 ──▶ 部署「新版本」（網址不變）
```

## 一、Cloudflare：不用動
- `worker/` 有更新時，Cloudflare 會在 1–2 分鐘內自動從 GitHub 部署。
- 三個密鑰（LINE_CHANNEL_SECRET、GAS_URL、FORWARD_SECRET）保留在 Cloudflare，不會被覆蓋。

## 二、Apps Script（每次更新都要做）
1. 打開 GitHub `dist/華暉出貨_一次貼上.gs` → 右上角「Copy raw file」（複製圖示）。
2. 打開 Apps Script → 左側 `Code.gs` → **Ctrl+A 全選刪除** → 貼上 → **儲存**（磁碟圖示）。
3. 回到試算表，**重新整理頁面**（F5）。
4. 選單 **華暉出貨 → 初始化／修復工作表與排程** → 確認第一行版本是新的、下面全部 ✅。
5. Apps Script 右上角 **部署 → 管理部署作業** → 點目前那筆旁的 **鉛筆（編輯）** → 「版本」選 **新版本** → **部署**。
   - ⚠ **不要按「新增部署作業」**：那會產生新網址，Cloudflare 還在送舊網址，LINE 訊息就收不到。
   - 網址維持不變，Cloudflare 的 GAS_URL 不用改。

## 三、確認（1 分鐘）
1. 打開 https://df-function.defunction-net.workers.dev/check → 最下面「連線測試」要是 ✅。
2. 用自己的 LINE 傳一則訊息給官方帳號 → 試算表「訊息紀錄」1 分鐘內多一列。

## 不需要重做的事
| 項目 | 為什麼不用動 |
|---|---|
| 設定金鑰（LINE token、Claude 金鑰、轉送密鑰） | 存在 Apps Script 的指令碼屬性，換程式碼不會消失 |
| 「設定」工作表的內容 | 初始化只會補上新項目，不會改你填的值 |
| 出貨清單、LINE帳號對照等資料 | 不會被清除 |
| 排程（每 5 分鐘、10:00 產單） | 初始化會自動重建 |
| LINE Webhook 網址 | 一直是 Cloudflare 的網址，不會變 |

## 什麼時候才需要重新設定金鑰
| 發生的事 | 要改的地方 |
|---|---|
| LINE 的 Channel secret 重新產生 | Cloudflare `LINE_CHANNEL_SECRET` → Deploy |
| LINE 的 Channel access token 重新產生 | 試算表「華暉出貨 → 設定金鑰」第一格 |
| 不小心按了「新增部署作業」 | 把新網址貼到 Cloudflare `GAS_URL` → Deploy（或封存新的那筆，改用「編輯 → 新版本」） |
| 換了一份新的試算表 | 新試算表重新「設定金鑰」，把新的轉送密鑰和新網址貼到 Cloudflare |

## 出問題時
打開 `/check` 看「連線測試」那一行，它會直接寫出是哪一段的問題（密鑰不符、存取權限、網址錯誤）。
