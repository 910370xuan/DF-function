# 第二階段：LINE 訂單自動進表 — 安裝與試跑

```
客戶傳 LINE → 官方帳號（照常手動回覆）
  → Cloudflare Worker：確認是 LINE 送來的（簽章），轉送
  → Apps Script：存進「訊息紀錄」
  → 每 5 分鐘：同一位客戶停止傳訊 10 分鐘後合併成一段
      → 規則解析（型號對照）→ 只寫「小電池／10+1」時查上一筆訂單 → 仍判斷不了才問 Claude（可關）
      → 推定出貨日（16:00 前今天、之後下一個出貨日、跳過假日）
      → 試跑模式：寫進「LINE試跑」；正式：寫進「出貨清單」
  → 15:30 寄出「待確認」清單與「不是訂單」的訊息清單
```
系統**不會傳任何訊息給客戶**。

## 一、Apps Script（約 10 分鐘）
1. 貼上新版 `華暉出貨_一次貼上.gs`，儲存，**執行一次 `setup`**（會新增「訊息紀錄」「LINE帳號對照」「LINE試跑」工作表）。
2. 右上角 **部署 → 新增部署作業**：
   - 類型：**網頁應用程式**
   - 執行身分：**我**；誰可以存取：**所有人**
   - 按「部署」，複製「網頁應用程式網址」（結尾是 `/exec`），等一下貼到 Cloudflare。
   - ⚠ 之後每次更新程式，要到 **部署 → 管理部署作業 → 編輯（鉛筆）→ 版本選「新版本」→ 部署**，網址不變，LINE 才會用到新程式。
3. 回到試算表，選單 **華暉出貨 → 設定金鑰**：
   - LINE Channel access token：見下方第二步取得後再來貼（可以先按取消）
   - Claude API 金鑰：先按取消
   - 最後會顯示「轉送密鑰」，複製起來貼到 Cloudflare。

## 二、LINE 測試官方帳號（約 15 分鐘）
建議先用**測試用的官方帳號**，確認沒問題再換正式帳號。
1. 用 LINE Official Account Manager 建立一個新的官方帳號（例如「華暉測試」）。
2. 官方帳號後台 → **設定 → Messaging API → 啟用 Messaging API**（第一次會要求建立「服務提供者」，名稱填公司名）。
3. 打開 LINE Developers Console（developers.line.biz）→ 剛剛的頻道：
   - **Basic settings** → 複製 **Channel secret**（給 Cloudflare 用）
   - **Messaging API** → 最下方 **Channel access token (long-lived)** → Issue → 複製（回到試算表「設定金鑰」貼上）
4. 官方帳號後台 → **設定 → 回應設定**：**聊天：開啟**、**Webhook：開啟**；其他照你們原本的設定。

## 三、Cloudflare Worker（約 10 分鐘，免費）
1. 註冊 Cloudflare（建議公司信箱），左側 **Workers & Pages → 建立 → Worker**，名稱例如 `huahui-line`，先按部署。
2. 按 **編輯程式碼**，把 repo 的 `worker/index.js` 全部貼上，按 **部署**。
3. Worker 的 **設定 → 變數和密碼**，新增三個（類型選 **密碼 / Secret**）：
   - `LINE_CHANNEL_SECRET`：LINE 的 Channel secret
   - `GAS_URL`：Apps Script 網頁應用程式網址（`/exec` 結尾）
   - `FORWARD_SECRET`：試算表「設定金鑰」顯示的轉送密鑰
4. 複製 Worker 網址（例如 `https://huahui-line.xxx.workers.dev`）。
5. 回到 LINE Developers → Messaging API → **Webhook URL** 填 `https://huahui-line.xxx.workers.dev/line` → 按 **Verify** 應顯示成功 → 打開 **Use webhook**。

## 四、關鍵測試：手動聊天模式下收不收得到
1. 用自己的 LINE 加測試官方帳號好友。
2. 在官方帳號後台把這個聊天切到 **手動聊天**。
3. 用自己的 LINE 傳：`GPB-2000*3 不需要工具`
4. 1 分鐘內打開試算表「**訊息紀錄**」→ 應該出現一列 ✅
   - **有出現 → 方案可行**，繼續下一步。
   - 沒出現 → 先在「切回自動回應」的狀態再傳一次比對，把兩種結果告訴我。
5. 「**LINE帳號對照**」會出現你的 LINE 名稱 → 「店家」欄隨便選一家測試店。
6. 選單 **華暉出貨 → 立即處理 LINE 訊息**（平常每 5 分鐘自動處理，且會等客戶 10 分鐘沒傳新訊息）。
7. 「**LINE試跑**」應出現一列：店家、GPB-2000、3、出貨日、備註「不需工具」、狀態「建議」。
8. 再試：`幫我出10+1`、傳一張圖片 +「我要一組這個」、`謝謝`，看判斷與「系統訊息」欄的說明。

## 五、Claude 判讀（可選，之後再開）
1. 到 platform.claude.com 用公司信箱註冊 → 儲值（例如 US$5–10）→ **設定每月花費上限** → 建立 API 金鑰。
2. 試算表 **華暉出貨 → 設定金鑰** 貼上 Claude 金鑰（金鑰不會出現在試算表）。
3. 「設定」勾選 **AI判讀**。只有規則判斷不了的訊息（沒有品項、含圖片）才會呼叫，結果一律標「待確認」。
4. 「AI模型」預設 `claude-opus-5-5`；可改 `claude-haiku-5-5` 比較費用與準確度。

## 六、試跑 → 正式
- 試跑期間（建議 1–2 週）：你們照原本方式作業，每天對照「LINE試跑」與實際出貨，判斷錯的截圖給我調整。
- 準確度滿意後：
  1. 「設定」取消勾選 **試跑模式** → 之後 LINE 訂單直接寫進「出貨清單」：明確的是「待出貨」（10:00 自動產單），其他是「待確認」（客服核對後改成「待出貨」）。
  2. LINE Webhook 改接正式官方帳號（正式帳號同樣要啟用 Messaging API，換 Channel secret、access token）。

## 安全性
- LINE Channel secret 只放在 Cloudflare；LINE token、Claude 金鑰只放在 Apps Script 的指令碼屬性，都不會出現在試算表。
- Apps Script 網址即使被別人知道，沒有轉送密鑰也寫不進資料。
