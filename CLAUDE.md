# page-state-recorder 工作守則

- 唯一的程式檔是 `page-state-recorder.user.js`，沒有打包步驟，直接改這支。
- 設計背景與定案（三個檔次、包裝永遠裝／錄製才開關、不設白名單改用排除名單、不設深度上限）寫在檔頭註解與 README；需求來源是知識庫 `bgtsai/claude-knowledge-base` 的 `_handoff/20261105-2355_page-state-recorder.md`。
- 每次改動的固定流程：
  1. 遞增 `@version`
  2. `NODE_PATH=/opt/npm-tools/node_modules node tools/check.js`（語法、重複宣告、未定義識別字＋作用域；三項都要 OK）
  3. `NODE_PATH=/opt/npm-tools/node_modules node tests/run-tests.js`（全部通過才推送）
  4. 改到封存內容時，再跑 `tests/real-site.js https://www.youtube.com/`，確認 `pageErrors` 為空、`hookErrors` 為 0
  5. 新增功能就在 `tests/run-tests.js` 補斷言，並先用壞掉的版本反證斷言抓得到
- `tests/out-*.json` 是測試輸出，不進版控（見 `.gitignore`）。
- 尚未實作：第 4 檔（「是誰改了屬性／樣式」的呼叫堆疊，平常只對選取器選定的元素抓，必要時切換成全頁抓 class 與 style）、取素材模式（滑鼠選取器＋最小重現片段）。
