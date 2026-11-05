[Switch to English](README.md)

# 頁面狀態封存器（Page State Recorder）

一鍵把當下頁面的完整狀態匯出成**單一 JSON 檔**：DOM（含 open／closed Shadow DOM）、自訂元素的內部資料、樣式、監聽器、網路請求、console、錯誤與元素變更歷程。

它是除錯工具。目標是：拿到一份匯出檔之後，事後想到的任何問題都能**用程式在檔案裡查到答案**，不用再回頭請人開開發者工具、跑指令、複製貼上。

## 安裝

需要 Tampermonkey（Chrome、Edge、Firefox）。

[安裝 page-state-recorder.user.js](https://raw.githubusercontent.com/bgtsai/page-state-recorder/main/page-state-recorder.user.js)

腳本在所有網站上載入。平常不做任何事，只在 Tampermonkey 選單裡掛幾個指令。

## 使用

在 Tampermonkey 選單選：

| 指令 | 做什麼 |
|---|---|
| 封存：第 1 級（DOM＋內部資料） | 下載匯出檔。登入的 YouTube 首頁實測約 13 秒、75 MB（約 1.5 萬個節點），頁面會卡住 |
| 封存：第 1＋2 級（加 computed style、位置） | 再加上每個元素的 computed style、`::before`／`::after`、位置大小。比第 1 級再慢很多（未登入的 YouTube 首頁約 4 千個節點就要 15～20 秒、上百 MB） |
| ● 開始錄製／■ 停止錄製 | 第 3 級：記錄網路、console、錯誤、元素變更；錄製中註冊的監聽器會附註冊時的呼叫堆疊。同一個分頁重新整理後會繼續錄 |
| 清空錄製內容 | 清掉已錄的紀錄 |
| 把這個網站加入／移出排除名單 | 網站被封存器弄壞時用。排除的網站不安裝任何包裝（第 1、2 級照樣可用），重新整理後生效 |

## 三個檔次

| 檔次 | 內容 | 要不要事先準備 |
|---|---|---|
| 第 1 級 | 完整 DOM、屬性、inline style（含 `!important`）、自訂元素內部資料（框架掛在元素上的自有屬性，以及自訂類別定義的 getter）、`__diagQueue` 交出的腳本狀態 | 不用 |
| 第 2 級 | ＋ computed style（同一組值只存一份）、偽元素、bounding box | 不用 |
| 第 3 級 | ＋ 監聽器、closed shadow root、網路、console、錯誤、變更歷程 | 要。包裝在網頁程式之前就裝好；網路、console、錯誤、變更要**打開錄製**才開始記 |

### 平常的成本

包裝永遠裝著，錄製才開關。2026-11-06 在 Chrome 量測 YouTube 首頁：包裝裝著、錄製關閉時，長任務時間與記憶體跟沒裝**分不出差別**；錄製打開時，記憶體成長有固定上限（環狀緩衝，回應內容預設不留）。

## 讓你的腳本交出內部狀態：`__diagQueue`

封存器讀不到其他腳本閉包裡的設定與判定結果。在你的腳本加這幾行，封存時就會一併收錄：

```js
const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
(w.__diagQueue = w.__diagQueue || []).push(['我的腳本', () => ({
  settings,             // 完整設定
  state,                // 清單、快取…
  verdicts,             // 每個元素被哪一條規則處理的判定結果
})]);
```

不管兩支腳本誰先載入都可以：封存當下才呼叫這個函式。函式拋出例外時，匯出檔只記錄錯誤，不會中斷封存。

## 匯出檔格式

| 欄位 | 內容 |
|---|---|
| `env` | 時間（台北）、網址、捲動位置、視窗大小、腳本版本、設定、錄製狀態、裝了哪些包裝、封存器自身的錯誤 |
| `notCaptured` | **這份檔案沒抓到什麼**。讀檔時要先看：「不存在」與「沒被抓進來」要靠這裡分辨 |
| `stats`、`omissions` | 數量、耗時；因總量保護而省略的部分（路徑與原因）。沒有就是 0 |
| `nodes` | 扁平陣列，`id` 就是索引；`p` 父節點、`k` 在父節點中的順序、`via` 標示 `shadow-open`／`shadow-closed`／`template` |
| `objs` | 物件表。其他地方用 `{"$ref": n}` 指向這裡；指向節點時寫 `{"$node": id}` |
| `styles` | 第 2 級的 computed style 表，節點的 `cs` 是這裡的索引 |
| `listeners` | 每個節點（`node`）或 `window` 上的監聽器 |
| `network`、`console`、`errors`、`mutations` | 第 3 級錄製內容 |
| `diag` | `__diagQueue` 交出的內部狀態 |
| `frames`、`stylesheets` | iframe 清單、樣式表清單（跨網域樣式表讀不到規則時有 `rulesError`） |

特殊值：`{"$undef":1}`（值是 undefined）、`{"$binary":mime,"len":n,"hash":h}`（大塊二進位 `data:` 換成描述；svg 與文字類一律原樣保留）、`{"$getterError":...}`（getter 拋例外）、`{"$omitted":reason}`（被省略，原因也在 `omissions`）。

序列化**不設深度上限**，循環以 `$ref` 收斂；只有總量保護，任何省略都留下紀錄。

## 已知看不到的範圍

- iframe 內部文件
- 跨網域樣式表的規則內容
- 函式原始碼超過 1000 字的部分（以 `srcCut` 標示）
- 「是誰改了某個屬性或樣式」的呼叫堆疊（第 4 檔，尚未實作）
- WebSocket、EventSource、`sendBeacon`
- 腳本注入前就註冊的監聽器、建立的 closed shadow root；錄製打開之前發生的事件

## 瀏覽器

寫法同時支援 Chrome 與 Firefox；自動測試只在 Chromium 上跑。網站的 CSP 擋住注入、Tampermonkey 改用隔離沙箱時（匯出檔的 `env.context` 是 `isolated`），Firefox 的包裝會經過 `exportFunction`。這條路徑在 Firefox 153 的 YouTube 首頁實機跑過一次：監聽器、closed shadow root 都抓得到，封存器自身零錯誤（2026-11-06）。

## 開發

```
NODE_PATH=<含 playwright 與 acorn 的 node_modules> node tests/run-tests.js   # 回歸測試
NODE_PATH=... node tools/check.js                                             # 語法、重複宣告、未定義識別字＋作用域
NODE_PATH=... node tests/real-site.js https://www.youtube.com/                 # 真實網站冒煙測試
```
