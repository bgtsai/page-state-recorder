// 無頭瀏覽器回歸測試：在測試頁上跑封存器，逐項斷言匯出檔內容。
// 用法：NODE_PATH=<playwright 所在的 node_modules> node tests/run-tests.js
// 每個斷言都要寫得跟實際要求一樣嚴（01 第④條）：不只看「有沒有報錯」，要比對具體值。
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'page-state-recorder.user.js'), 'utf8');
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8');
const ORIGIN = 'https://psr.test';

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail).slice(0, 300) : '')); }
};

// Tampermonkey API 的最小替身：GM 儲存放在 window 上的一份 JSON（每個 context 各自一份）
const gmStub = (store) => `
  window.__gmStore = ${JSON.stringify(store)};
  window.GM_info = { script: { version: 'test' } };
  window.GM_getValue = (k, d) => (k in window.__gmStore ? window.__gmStore[k] : d);
  window.GM_setValue = (k, v) => { window.__gmStore[k] = v; };
  window.GM_registerMenuCommand = (label) => { (window.__menu = window.__menu || []).push(label); return label; };
  window.GM_unregisterMenuCommand = (id) => { window.__menu = (window.__menu || []).filter((l) => l !== id); };
`;

async function openPage(browser, store) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.route(ORIGIN + '/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/api/data') return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'x-test': 'yes' }, body: '{"ok":true}' });
    if (u.pathname === '/api/xhr') return route.fulfill({ status: 201, contentType: 'text/plain', body: 'xhr-body' });
    return route.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE });
  });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.addInitScript(gmStub(store || {}));
  await page.addInitScript(SCRIPT);
  await page.goto(ORIGIN + '/', { waitUntil: 'load' });
  return { ctx, page, pageErrors };
}
async function getDump(page, tier) {
  const s = await page.evaluate((t) => window.__psrTest.dumpParts(t).join(''), tier);
  return JSON.parse(s);
}

// ── 讀匯出檔的小工具（等於「我事後寫腳本查」的那一端） ──
const byId = (d, id) => d.nodes.find((n) => n.a && n.a.some(([k, v]) => k === 'id' && v === id));
const attr = (n, k) => { const p = n && n.a && n.a.find((x) => x[0] === k); return p ? p[1] : undefined; };
const kids = (d, n) => d.nodes.filter((c) => c.p === n.id);
function findValue(d, start, pred) {
  // 從某個值出發，沿 $ref 走訪，找到第一個符合 pred 的原始值；回傳走了幾層
  const seen = new Set();
  const stack = [[start, 0]];
  while (stack.length) {
    const [v, depth] = stack.pop();
    if (pred(v)) return depth;
    if (v && typeof v === 'object') {
      if ('$ref' in v) { if (seen.has(v.$ref)) continue; seen.add(v.$ref); stack.push([d.objs[v.$ref], depth + 1]); continue; }
      const vals = v.p ? Object.values(v.p) : v.a ? v.a : Array.isArray(v) ? v : Object.values(v);
      for (const x of vals) stack.push([x, depth]);
    }
  }
  return -1;
}

(async () => {
  const browser = await chromium.launch();

  console.log('【A】第 1 級，錄製關閉');
  {
    const { ctx, page, pageErrors } = await openPage(browser);
    const d = await getDump(page, 1);
    fs.writeFileSync(path.join(__dirname, 'out-tier1.json'), JSON.stringify(d));
    check('網頁本身沒有被包裝弄出錯誤', pageErrors.length === 0, pageErrors);
    check('env 基本欄位', d.env.tool === 'page-state-recorder' && d.env.url === ORIGIN + '/' && d.env.tier === 1 && /\+08:00$/.test(d.env.time), d.env);
    check('包裝全部裝上', ['addEventListener', 'attachShadow', 'fetch', 'XMLHttpRequest', 'console'].every((h) => d.env.hooksInstalled.includes(h)), d.env.hooksInstalled);
    check('沒有自身錯誤', d.env.hookErrorCount === 0, d.env.hookErrors);
    check('節點 id 等於陣列索引', d.nodes.every((n, i) => n.id === i));
    check('父子關係：每個非根節點的父節點存在', d.nodes.every((n) => n.p === -1 || (n.p >= 0 && n.p < d.nodes.length)));

    const card = byId(d, 'card1');
    const sr = card && kids(d, card).find((c) => c.via === 'shadow-open');
    check('open shadow root 被走進去', !!sr && sr.t === 11 && sr.mode === 'open', sr);
    const inner = sr && d.nodes.find((n) => n.p === sr.id && n.n === 'span');
    check('shadow 內的 span 與文字', !!inner && kids(d, inner).some((t) => t.v === 'shadow 內文'));
    const nestedLeaf = d.nodes.find((n) => n.n === 'b' && attr(n, 'class') === 'nested-leaf');
    check('巢狀 shadow 的葉子抓得到', !!nestedLeaf);
    const sec = byId(d, 'sec');
    const csr = sec && kids(d, sec).find((c) => c.via === 'shadow-closed');
    check('closed shadow root 抓得到（攔 attachShadow）', !!csr && d.nodes.some((n) => n.p === csr.id && n.n === 'i'), csr);
    check('stats 的 closed 計數', d.stats.closedShadowRoots === 1, d.stats);

    check('自訂元素自有屬性 __data', card && card.x && card.x.__data && findValue(d, card.x.__data, (v) => v === 'BADGE_STYLE_TYPE_LIVE') >= 0, card && card.x);
    const depth = card && card.x && card.x.data ? findValue(d, card.x.data, (v) => v === 'DEEP_LEAF_VALUE') : -1;
    check('類別 getter data 的深層值（不設深度上限，至少 12 層）', depth >= 12, depth);
    check('getter 拋例外只記錄，不中斷', card && card.x && card.x.explodes && /故意拋例外/.test(card.x.explodes.$getterError || ''), card && card.x && card.x.explodes);
    check('內部資料不混入瀏覽器內建屬性（內建原型的 constructor 被換掉時）',
      card && card.x && !['title', 'hidden', 'lang', 'innerText', 'tagName'].some((k) => k in card.x), card && card.x && Object.keys(card.x));
    check('getter 清單標出 data', card && card.xg && card.xg.includes('data'));
    // 循環：_self.again 必須指回 _self 自己
    const selfRef = card && card.x && card.x._self && card.x._self.$ref;
    check('循環以 $ref 收斂', selfRef !== undefined && d.objs[selfRef].p.again.$ref === selfRef, selfRef !== undefined && d.objs[selfRef]);
    check('物件裡的 DOM 節點寫成 $node', selfRef !== undefined && d.objs[selfRef].p.owner.$node === card.id);
    const dataObj = card && card.x && d.objs[card.x.data.$ref];
    const list = dataObj && d.objs[dataObj.p.list.$ref].a;
    check('undefined 與 bigint 可分辨', list && list[3] && list[3].$undef === 1 && list[4] && list[4].$bigint === '3', list);

    const p1 = byId(d, 'p1');
    check('內嵌 svg 的 path d 完整保留', attr(p1, 'd') === 'M2 2 L18 2 L10 18 Z');
    const bin = attr(byId(d, 'bin'), 'src');
    check('大塊二進位 data: 換成描述（MIME／長度／雜湊）', bin && bin.$binary === 'image/png' && bin.len > 5000 && /^[0-9a-f]{8}$/.test(bin.hash), bin);
    const svgsrc = attr(byId(d, 'svgimg'), 'src');
    check('data:image/svg+xml 原樣保留', typeof svgsrc === 'string' && svgsrc.startsWith('data:image/svg+xml') && svgsrc.length > 1024);
    const styled = byId(d, 'styled');
    check('inline style 含優先權', styled && styled.st && styled.st.some(([k, v, pr]) => k === 'width' && v === '100px' && pr === 'important'), styled && styled.st);
    const tpl = byId(d, 'tpl');
    check('template 內容抓得到', tpl && kids(d, tpl).some((c) => c.via === 'template'));

    const btn = byId(d, 'btn');
    const bl = d.listeners.find((l) => l.node === btn.id);
    const clicks = bl ? bl.list.filter((x) => x.type === 'click') : [];
    check('監聽器：重複註冊只算一次', clicks.length === 1, clicks);
    check('監聽器：capture／passive 與函式名稱', clicks[0] && clicks[0].capture === true && clicks[0].passive === true && d.objs[clicks[0].fn.$ref].name === 'namedClickHandler', clicks[0]);
    check('監聽器：錄製關閉時沒有註冊堆疊', clicks[0] && clicks[0].stack === null);
    check('on* 屬性的處理函式', bl && bl.list.some((x) => x.type === 'mouseover' && x.via === 'property'));
    check('window 上的監聽器', d.listeners.some((l) => l.target === 'window' && l.list.some((x) => x.type === 'resize')));

    const diagOk = d.diag.find((x) => x.name === '測試腳本');
    check('__diagQueue 的內部狀態', diagOk && findValue(d, diagOk.value, (v) => v === 'b2') >= 0, d.diag);
    check('__diag 失敗只記錯誤', d.diag.some((x) => x.name === '壞掉的腳本' && /diag 故意失敗/.test(x.error || '')));
    check('沒開錄製時明講沒有網路紀錄', d.notCaptured.some((s) => /錄製從未打開/.test(s)) && d.network.length === 0);
    check('第 1 級沒有 styles', d.styles === null);
    check('沒有任何省略（預算內）', d.omissions.count === 0, d.omissions);
    await ctx.close();
  }

  console.log('【B】第 3 級錄製、第 2 級樣式、重新整理後延續');
  {
    const { ctx, page, pageErrors } = await openPage(browser);
    await page.evaluate(() => window.__psrTest.setRecording(true));
    await page.evaluate(async () => {
      const r = await fetch('/api/data', { method: 'POST', headers: { 'x-req': '1' }, body: 'hello' });
      await r.json();
      await new Promise((res) => { const x = new XMLHttpRequest(); x.open('GET', '/api/xhr'); x.setRequestHeader('x-h', 'v'); x.onloadend = res; x.send(); });
      console.log('LOG_MARK', { a: 1 });
      console.warn('WARN_MARK', document.getElementById('btn'));
      const s = document.getElementById('styled');
      s.setAttribute('data-x', '1');
      s.classList.add('k');
      s.style.color = 'blue'; // 包不到的那條路，但變更歷程看得到
      document.getElementById('btn').addEventListener('dblclick', function recordedHandler() {});
      setTimeout(() => { throw new Error('BOOM_MARK'); }, 0);
      await new Promise((res) => setTimeout(res, 300));
    });
    const d = await getDump(page, 2);
    fs.writeFileSync(path.join(__dirname, 'out-tier2-rec.json'), JSON.stringify(d));
    check('錄製狀態寫進 env', d.env.recording.on === true && d.env.recording.since);
    const f = d.network.find((n) => n.kind === 'fetch' && /\/api\/data$/.test(n.url));
    check('fetch：方法、狀態、回應標頭、請求內容', f && f.method === 'POST' && f.status === 200 && f.done === true &&
      f.resHeaders.some(([k, v]) => k === 'x-test' && v === 'yes') && f.reqBody && f.reqBody.head === 'hello', f);
    check('fetch：發起堆疊', f && typeof f.stack === 'string' && f.stack.length > 0);
    check('fetch：預設不留回應內容', f && !('body' in f));
    const x = d.network.find((n) => n.kind === 'xhr');
    check('XHR：狀態與請求標頭', x && x.status === 201 && x.method === 'GET' && x.done === true, x);
    const log = d.console.find((c) => c.level === 'log');
    check('console.log 參數', log && log.args[0] === 'LOG_MARK', log);
    const warn = d.console.find((c) => c.level === 'warn');
    check('console.warn 的節點參數指回樹上節點', warn && warn.args[1] && warn.args[1].node && warn.args[1].node.$node === byId(d, 'btn').id, warn);
    const m = d.mutations.find((mm) => mm.type === 'attributes' && mm.attr === 'data-x');
    check('變更歷程：屬性舊值／新值／目標', m && m.old === null && m.now === '1' && m.target.$node === byId(d, 'styled').id, m);
    check('變更歷程：style.xxx = 的改法也看得到', d.mutations.some((mm) => mm.attr === 'style' && /blue/.test(mm.now || '')));
    check('錯誤：未捕捉例外', d.errors.some((e) => /BOOM_MARK/.test(e.message || '')), d.errors);
    const bl = d.listeners.find((l) => l.node === byId(d, 'btn').id);
    const dbl = bl && bl.list.find((l) => l.type === 'dblclick');
    check('錄製中註冊的監聽器有註冊堆疊', dbl && typeof dbl.stack === 'string' && dbl.stack.length > 0, dbl);
    check('第 2 級：computed style 去重表', Array.isArray(d.styles) && d.styles.length > 0 && d.stats.uniqueStyles === d.styles.length);
    const styled = byId(d, 'styled');
    check('第 2 級：元素的 computed style 值', styled && d.styles[styled.cs].includes('width:100px'), styled && styled.cs);
    const heart = byId(d, 'heart');
    check('第 2 級：::before 的 content', heart && heart.pseudo && heart.pseudo['::before'] && /♥|\\2665/.test(heart.pseudo['::before'].content), heart && heart.pseudo);
    check('第 2 級：bounding box', styled && Array.isArray(styled.box) && styled.box[2] === 100, styled && styled.box);
    check('網頁本身沒有錯誤（BOOM 是故意的除外）', pageErrors.every((e) => /BOOM_MARK/.test(e)), pageErrors);

    await page.reload({ waitUntil: 'load' });
    const d2 = await getDump(page, 1);
    check('重新整理後錄製延續（sessionStorage）', d2.env.recording.on === true, d2.env.recording);
    check('重新整理後抓得到載入期間註冊監聽器的堆疊', (() => {
      const b = d2.listeners.find((l) => l.node === byId(d2, 'btn').id);
      const c = b && b.list.find((l) => l.type === 'click');
      return c && typeof c.stack === 'string' && /namedClickHandler|psr\.test/.test(c.stack + JSON.stringify(d2.objs[c.fn.$ref]));
    })());
    await ctx.close();
  }

  console.log('【C】排除名單');
  {
    const { ctx, page, pageErrors } = await openPage(browser, { settings: { exclude: ['psr.test'] } });
    const d = await getDump(page, 1);
    check('排除時不裝任何包裝', d.env.excluded === true && d.env.hooksInstalled.length === 0, d.env.hooksInstalled);
    check('排除時第 1 級照樣可用', d.nodes.length > 20 && byId(d, 'card1'));
    check('排除時明講第 3 級全部沒有', d.notCaptured.some((s) => /排除名單/.test(s)));
    check('排除時 closed shadow 拿不到（符合預期）', d.stats.closedShadowRoots === 0);
    const menu = await page.evaluate(() => window.__menu);
    check('選單顯示「移出排除名單」', menu.some((l) => /移出排除名單/.test(l)), menu);
    check('網頁本身沒有錯誤', pageErrors.length === 0, pageErrors);
    await ctx.close();
  }

  await browser.close();
  console.log(`\n結果：${pass} 通過，${fail} 失敗`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
