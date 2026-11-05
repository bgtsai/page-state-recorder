// ==UserScript==
// @name         頁面狀態封存器 Page State Recorder
// @namespace    https://github.com/bgtsai/page-state-recorder
// @version      1.0.0
// @description  一鍵把當下頁面的完整狀態（DOM、Shadow DOM、自訂元素內部資料、樣式、監聽器、網路、console、變更歷程）匯出成單一 JSON 檔，供事後用程式查詢除錯
// @author       bgtsai
// @match        *://*/*
// @run-at       document-start
// @noframes
// @sandbox      raw
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_info
// @grant        unsafeWindow
// @homepageURL  https://github.com/bgtsai/page-state-recorder
// @supportURL   https://github.com/bgtsai/page-state-recorder/issues
// @updateURL    https://raw.githubusercontent.com/bgtsai/page-state-recorder/main/page-state-recorder.user.js
// @downloadURL  https://raw.githubusercontent.com/bgtsai/page-state-recorder/main/page-state-recorder.user.js
// ==/UserScript==

/*
 * 三個檔次（詳見 README）：
 *   第 1 級：完整 DOM（含 open／closed shadow root）、屬性、inline style、自訂元素內部資料、__diag 交出的腳本狀態
 *   第 2 級：＋ computed style、::before/::after、bounding box
 *   第 3 級：＋ 監聽器、網路、console、錯誤、元素變更歷程（需要 document-start 埋線；錄製要另外打開）
 *
 * 架構決定：包裝永遠裝、錄製才開關。
 *   量測（2026-11-06，沙箱 Chrome，YouTube 首頁）：包裝裝著、錄製關閉時，長任務時間與記憶體跟沒裝分不出差別；
 *   唯一的大成本是抓呼叫堆疊（每次 11～24 µs，全頁抓會讓載入多卡約 1 秒），所以第 3 級只在「註冊監聽器」時、
 *   而且只在錄製打開時抓堆疊。「是誰改了屬性」那一層（第 4 檔）不在這一版。
 *
 * 沙箱：@sandbox raw 讓腳本直接跑在網頁環境（包裝必須裝在網頁那一份原型上才攔得到）。
 *   網站的 CSP 擋住 raw 注入時，Tampermonkey 會改用其他沙箱；Firefox 那時是隔離環境，
 *   塞給網頁的函式要先經過 exportFunction，否則網頁呼叫時會被擋——所有包裝都經過 toPage()。
 */

(function () {
  'use strict';

  const VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '1.0.0';
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const toPage = (fn) => (typeof exportFunction === 'function' && W !== window ? exportFunction(fn, W) : fn);
  const instanceId = Math.random().toString(36).slice(2, 8);
  const HOST = location.hostname;
  const SS_REC_KEY = 'psr-recording'; // 錄製狀態放 sessionStorage：同一分頁重新整理後仍持續錄，才抓得到載入期間的事件

  // ── 設定 ─────────────────────────────────────────────
  const SETTINGS_DEFAULT = {
    exclude: [],          // 排除名單：這些網站連第 3 級包裝都不裝（第 1、2 級照樣可用）
    keepBodies: false,    // 網路回應內容預設不留（會讓錄製時記憶體成長很快）
    bodyMaxChars: 200000, // keepBodies 打開時，每筆回應最多留幾個字元（超過會在該筆記錄 bodyCut）
    budgetUnits: 80e6,    // 第 1 級物件序列化的總量保護（約略等於輸出字元數）；超過的部分寫進 omissions
  };
  function loadSettings() {
    try { return Object.assign({}, SETTINGS_DEFAULT, GM_getValue('settings', {})); }
    catch (e) { return Object.assign({}, SETTINGS_DEFAULT); }
  }
  function saveSettings(s) { try { GM_setValue('settings', s); } catch (e) { hookErr('saveSettings', e); } }
  let settings = loadSettings();
  const excluded = settings.exclude.indexOf(HOST) !== -1;

  // ── 自身錯誤：不中斷，但留痕跡（會寫進匯出檔 env.hookErrors） ──
  const hookErrors = [];
  let hookErrorCount = 0;
  function hookErr(where, e) {
    hookErrorCount++;
    if (hookErrors.length < 200) hookErrors.push({ where, msg: String((e && e.message) || e), t: perfNow() });
  }
  function perfNow() { try { return +W.performance.now().toFixed(1); } catch (e) { return 0; } }
  function safe(name, fn) { try { fn(); } catch (e) { hookErr(name, e); } }

  // ── 環狀緩衝：錄製時記憶體上限固定，被擠掉的筆數記在 dropped ──
  class Ring {
    constructor(cap) { this.cap = cap; this.a = []; this.start = 0; this.dropped = 0; }
    push(x) {
      if (this.a.length < this.cap) this.a.push(x);
      else { this.a[this.start] = x; this.start = (this.start + 1) % this.cap; this.dropped++; }
    }
    toArray() { return this.a.slice(this.start).concat(this.a.slice(0, this.start)); }
    clear() { this.a = []; this.start = 0; this.dropped = 0; }
    get size() { return this.a.length; }
  }

  const REC = {
    on: false,
    since: null,
    seq: 0,
    buf: { network: new Ring(2000), console: new Ring(3000), errors: new Ring(500), mutations: new Ring(20000) },
  };
  const recPush = (kind, item) => { item.seq = ++REC.seq; item.t = perfNow(); REC.buf[kind].push(item); return item; };

  // ── 第 3 級：document-start 包裝（任何 await 之前、網頁程式碼之前） ──
  const listenerReg = new WeakMap();   // target → [{type, fn, capture, once, passive, signal, seq, t, stack}]
  const nonNodeTargets = [];           // 非 DOM 節點的監聽目標（XHR、MediaQueryList…），WeakRef，上限 2000
  const shadowRoots = new WeakMap();   // host → shadowRoot（open 與 closed 都留；closed 只有這裡拿得到）
  const shadowRootRefs = [];           // 錄製時要逐一掛 MutationObserver，所以另存一份可走訪的 WeakRef
  const xhrInfo = new WeakMap();
  let listenerSeq = 0;
  let mo = null;
  const hooksInstalled = [];

  function isNodeLike(o) {
    try { return o instanceof W.Node; } catch (e) { return false; }
  }

  function regListener(target, type, fn, opts) {
    if (fn == null) return;
    const capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
    let list = listenerReg.get(target);
    if (!list) {
      list = [];
      listenerReg.set(target, list);
      if (!isNodeLike(target) && target !== W && nonNodeTargets.length < 2000) {
        try { nonNodeTargets.push(new WeakRef(target)); } catch (e) { /* WeakRef 不存在的舊瀏覽器：只是查不到非節點目標 */ }
      }
    }
    // 瀏覽器對同一組 (type, fn, capture) 的重複註冊會忽略，登記也要一致
    for (const r of list) if (r.type === type && r.fn === fn && r.capture === capture) return;
    const rec = {
      type: String(type), fn, capture,
      once: !!(opts && typeof opts === 'object' && opts.once),
      passive: opts && typeof opts === 'object' && 'passive' in opts ? !!opts.passive : null,
      signal: opts && typeof opts === 'object' ? opts.signal || null : null,
      seq: ++listenerSeq, t: perfNow(),
      // 堆疊只在錄製時抓（量測：抓堆疊是整套最貴的動作）；存 Error 物件延後格式化，比立即取 .stack 省一半
      stack: REC.on ? new Error() : null,
    };
    list.push(rec);
  }
  function unregListener(target, type, fn, opts) {
    const list = listenerReg.get(target);
    if (!list) return;
    const capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (r.type === type && r.fn === fn && r.capture === capture) { list.splice(i, 1); return; }
    }
  }

  function installHooks() {
    const ETP = W.EventTarget && W.EventTarget.prototype;
    const nativeAdd = ETP.addEventListener;
    const nativeRemove = ETP.removeEventListener;
    ETP.addEventListener = toPage(function (type, fn, opts) {
      try { regListener(this, type, fn, opts); } catch (e) { hookErr('addEventListener', e); }
      return nativeAdd.call(this, type, fn, opts);
    });
    ETP.removeEventListener = toPage(function (type, fn, opts) {
      try { unregListener(this, type, fn, opts); } catch (e) { hookErr('removeEventListener', e); }
      return nativeRemove.call(this, type, fn, opts);
    });
    N.addEventListener = nativeAdd;
    hooksInstalled.push('addEventListener', 'removeEventListener');

    safe('hook attachShadow', () => {
      const EP = W.Element.prototype;
      const native = EP.attachShadow;
      if (typeof native !== 'function') return;
      EP.attachShadow = toPage(function (init) {
        const root = native.call(this, init);
        try {
          shadowRoots.set(this, root);
          shadowRootRefs.push(new WeakRef(root));
          if (mo) observeRoot(root);
        } catch (e) { hookErr('attachShadow', e); }
        return root;
      });
      hooksInstalled.push('attachShadow');
    });

    safe('hook fetch', () => {
      const native = W.fetch;
      if (typeof native !== 'function') return;
      W.fetch = toPage(function (input, init) {
        if (!REC.on) return native.apply(this, arguments);
        let rec = null;
        try {
          const isReq = input && typeof input === 'object' && 'url' in input;
          rec = recPush('network', {
            kind: 'fetch',
            method: String((init && init.method) || (isReq && input.method) || 'GET').toUpperCase(),
            url: String(isReq ? input.url : input),
            reqHeaders: headersToList((init && init.headers) || (isReq && input.headers)),
            reqBody: bodyDesc(init && init.body),
            stack: new Error(),
            done: false,
          });
        } catch (e) { hookErr('fetch:pre', e); }
        const p = native.apply(this, arguments);
        // 不回傳 p.then(...)：保持網頁拿到的是原本那個 Promise（身分不變，Firefox 隔離環境也不會拿到沙箱的 Promise）
        if (rec) {
          p.then((res) => {
            try {
              rec.done = true; rec.tEnd = perfNow();
              rec.status = res.status; rec.statusText = res.statusText; rec.type = res.type;
              rec.redirected = res.redirected; rec.finalUrl = res.url;
              rec.resHeaders = headersToList(res.headers);
              if (settings.keepBodies) {
                res.clone().text().then((txt) => {
                  rec.body = txt.length > settings.bodyMaxChars ? txt.slice(0, settings.bodyMaxChars) : txt;
                  if (txt.length > settings.bodyMaxChars) rec.bodyCut = { kept: settings.bodyMaxChars, total: txt.length };
                }, (e) => { rec.bodyError = String(e); });
              }
            } catch (e) { hookErr('fetch:res', e); }
          }, (err) => {
            try { rec.done = true; rec.tEnd = perfNow(); rec.error = String((err && err.message) || err); } catch (e) { hookErr('fetch:err', e); }
          });
        }
        return p;
      });
      hooksInstalled.push('fetch');
    });

    safe('hook XHR', () => {
      const XP = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
      if (!XP) return;
      const nOpen = XP.open, nSend = XP.send, nSetHdr = XP.setRequestHeader;
      XP.open = toPage(function (method, url) {
        try { xhrInfo.set(this, { method: String(method).toUpperCase(), url: String(url), reqHeaders: [] }); } catch (e) { hookErr('xhr.open', e); }
        return nOpen.apply(this, arguments);
      });
      XP.setRequestHeader = toPage(function (k, v) {
        try { const i = xhrInfo.get(this); if (i) i.reqHeaders.push([String(k), String(v)]); } catch (e) { hookErr('xhr.setRequestHeader', e); }
        return nSetHdr.apply(this, arguments);
      });
      XP.send = toPage(function (body) {
        if (REC.on) {
          try {
            const i = xhrInfo.get(this) || {};
            const rec = recPush('network', {
              kind: 'xhr', method: i.method, url: i.url, reqHeaders: i.reqHeaders,
              reqBody: bodyDesc(body), stack: new Error(), done: false,
            });
            const xhr = this;
            N.addEventListener.call(xhr, 'loadend', function () {
              try {
                rec.done = true; rec.tEnd = perfNow();
                rec.status = xhr.status; rec.statusText = xhr.statusText; rec.finalUrl = xhr.responseURL;
                rec.responseType = xhr.responseType;
                rec.resHeaders = String(xhr.getAllResponseHeaders() || '').trim().split(/\r?\n/).filter(Boolean)
                  .map((l) => { const k = l.indexOf(':'); return [l.slice(0, k).trim(), l.slice(k + 1).trim()]; });
                if (settings.keepBodies && (xhr.responseType === '' || xhr.responseType === 'text')) {
                  const txt = xhr.responseText || '';
                  rec.body = txt.length > settings.bodyMaxChars ? txt.slice(0, settings.bodyMaxChars) : txt;
                  if (txt.length > settings.bodyMaxChars) rec.bodyCut = { kept: settings.bodyMaxChars, total: txt.length };
                }
              } catch (e) { hookErr('xhr.loadend', e); }
            });
          } catch (e) { hookErr('xhr.send', e); }
        }
        return nSend.apply(this, arguments);
      });
      hooksInstalled.push('XMLHttpRequest');
    });

    safe('hook console', () => {
      const C = W.console;
      for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'table', 'dir', 'assert']) {
        const native = C[level];
        if (typeof native !== 'function') continue;
        N.console[level] = native;
        C[level] = toPage(function () {
          if (REC.on) {
            try {
              const args = Array.prototype.slice.call(arguments);
              recPush('console', { level, args: shallowArgs(args), stack: level === 'error' || level === 'warn' || level === 'trace' ? new Error() : null });
            } catch (e) { hookErr('console.' + level, e); }
          }
          return native.apply(this, arguments);
        });
      }
      hooksInstalled.push('console');
    });

    safe('hook errors', () => {
      N.addEventListener.call(W, 'error', (ev) => {
        if (!REC.on) return;
        try {
          const tgt = ev.target;
          if (tgt && tgt !== W && isNodeLike(tgt)) {
            recPush('errors', { kind: 'resource', tag: tgt.localName, src: tgt.src || tgt.href || null, node: tgt });
          } else {
            recPush('errors', { kind: 'error', message: ev.message, file: ev.filename, line: ev.lineno, col: ev.colno,
              stack: ev.error && ev.error.stack ? String(ev.error.stack) : null });
          }
        } catch (e) { hookErr('onerror', e); }
      }, true);
      N.addEventListener.call(W, 'unhandledrejection', (ev) => {
        if (!REC.on) return;
        try {
          const r = ev.reason;
          recPush('errors', { kind: 'unhandledrejection', message: String((r && r.message) || r), stack: r && r.stack ? String(r.stack) : null });
        } catch (e) { hookErr('unhandledrejection', e); }
      });
      hooksInstalled.push('window.error', 'unhandledrejection');
    });
  }

  const N = { addEventListener: null, console: {} };

  function headersToList(h) {
    if (!h) return [];
    try {
      if (typeof h.forEach === 'function' && !Array.isArray(h)) { const out = []; h.forEach((v, k) => out.push([k, v])); return out; }
      if (Array.isArray(h)) return h.map((p) => [String(p[0]), String(p[1])]);
      return Object.keys(h).map((k) => [k, String(h[k])]);
    } catch (e) { return [['$error', String(e)]]; }
  }
  function bodyDesc(b) {
    if (b == null) return null;
    try {
      if (typeof b === 'string') return { type: 'string', len: b.length, head: b.length > 2000 ? b.slice(0, 2000) : b, cut: b.length > 2000 };
      const tag = Object.prototype.toString.call(b).slice(8, -1);
      return { type: tag, size: b.size != null ? b.size : b.byteLength != null ? b.byteLength : null };
    } catch (e) { return { type: '$error', msg: String(e) }; }
  }
  // console 參數在錄製當下就轉成字串描述：存原物件會留住大量頁面資料、也會被之後的修改改掉內容
  function shallowArgs(args) {
    return args.map((a) => {
      try {
        if (a == null || typeof a !== 'object' && typeof a !== 'function') return typeof a === 'string' ? a : String(a);
        if (isNodeLike(a)) return { $nodeDesc: nodeDesc(a), node: a };
        const s = JSON.stringify(a);
        if (s === undefined) return String(a);
        return s.length > 20000 ? { $json: s.slice(0, 20000), cut: { kept: 20000, total: s.length } } : { $json: s };
      } catch (e) { return { $str: Object.prototype.toString.call(a), err: String(e && e.message) }; }
    });
  }
  function nodeDesc(n) {
    try {
      if (n.nodeType !== 1) return { nodeType: n.nodeType, name: n.nodeName };
      return { tag: n.localName, id: n.id || undefined, cls: typeof n.className === 'string' ? n.className : undefined, connected: n.isConnected };
    } catch (e) { return { $error: String(e) }; }
  }

  // ── 錄製：元素變更歷程（MutationObserver，原生、批次，成本低） ──
  function observeRoot(root) {
    try {
      mo.observe(root, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true, characterDataOldValue: true });
    } catch (e) { hookErr('mo.observe', e); }
  }
  function startMutationLog() {
    if (mo) return;
    mo = new W.MutationObserver((list) => {
      for (const m of list) {
        try {
          const item = { type: m.type, target: m.target };
          if (m.type === 'attributes') {
            item.attr = m.attributeName; item.old = m.oldValue;
            try { item.now = m.target.getAttribute(m.attributeName); } catch (e) { /* 屬性讀取失敗就只留舊值 */ }
          } else if (m.type === 'characterData') {
            item.old = m.oldValue; item.now = m.target.data;
          } else {
            if (m.addedNodes.length) item.added = Array.prototype.slice.call(m.addedNodes);
            if (m.removedNodes.length) item.removed = Array.prototype.slice.call(m.removedNodes);
          }
          recPush('mutations', item);
        } catch (e) { hookErr('mo.cb', e); }
      }
    });
    observeRoot(document);
    for (const ref of shadowRootRefs) { const r = ref.deref(); if (r) observeRoot(r); }
  }
  function stopMutationLog() {
    if (!mo) return;
    try { const rest = mo.takeRecords(); if (rest.length) hookErr('mo.stop', 'takeRecords 丟棄 ' + rest.length + ' 筆'); } catch (e) { /* 忽略 */ }
    mo.disconnect(); mo = null;
  }
  function setRecording(on) {
    if (on === REC.on) return;
    REC.on = on;
    if (on) { REC.since = { t: perfNow(), time: taipeiTime() }; startMutationLog(); }
    else stopMutationLog();
    try { if (on) W.sessionStorage.setItem(SS_REC_KEY, '1'); else W.sessionStorage.removeItem(SS_REC_KEY); } catch (e) { hookErr('sessionStorage', e); }
  }

  if (!excluded) {
    safe('installHooks', installHooks);
    // 上一次在這個分頁開著錄製就延續：重新整理後也能抓到載入期間的事件
    safe('resume recording', () => { if (W.sessionStorage.getItem(SS_REC_KEY) === '1') setRecording(true); });
  }

  // ── __diag 約定：其他腳本把內部狀態交出來 ──
  // 其他腳本這樣寫（不管誰先載入都可以，封存當下才讀）：
  //   const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  //   (w.__diagQueue = w.__diagQueue || []).push(['腳本名', () => ({ settings, state })]);
  function collectDiag(ser) {
    const out = [];
    let q;
    try { q = W.__diagQueue; } catch (e) { return [{ $error: String(e) }]; }
    if (!q || typeof q.length !== 'number') return out;
    for (let i = 0; i < q.length; i++) {
      const entry = q[i];
      const name = entry && entry[0] != null ? String(entry[0]) : '(未命名 #' + i + ')';
      try {
        const v = typeof entry[1] === 'function' ? entry[1]() : entry[1];
        out.push({ name, value: ser.v(v, 'diag[' + i + ']') });
      } catch (e) { out.push({ name, error: String((e && e.stack) || e) }); }
    }
    return out;
  }

  // ── 序列化：不設深度上限，循環用 $ref，只有總量保護，省略一律記錄 ──
  function fnv(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  // data: 只有大塊二進位換成描述；svg、文字、JSON 類一律保留（svg 的 path d 常常就是判斷依據）
  const TEXTY_MIME = /svg|^text\/|json|xml|javascript|css/;
  const BINARY_MIN_CHARS = 1024;

  function createSerializer(nodeIds, budget) {
    const ids = new Map();
    const objs = [];
    const queue = [];
    let qi = 0;
    let units = 0;
    const omissions = [];
    let omissionCount = 0;
    const OMISSIONS_MAX = 5000;
    let nativeFnCache = new Map();

    function omit(path, reason, extra) {
      omissionCount++;
      if (omissions.length < OMISSIONS_MAX) omissions.push(Object.assign({ path, reason }, extra || {}));
      return { $omitted: reason };
    }
    function str(s) {
      units += s.length;
      if (s.length > BINARY_MIN_CHARS && s.charCodeAt(0) === 100 /* d */ && s.slice(0, 5).toLowerCase() === 'data:') {
        const m = /^data:([^;,]*)/i.exec(s);
        const mime = (m && m[1] || '').toLowerCase();
        if (!TEXTY_MIME.test(mime)) return { $binary: mime || '(無 MIME)', len: s.length, hash: fnv(s) };
      }
      return s;
    }
    function v(x, path) {
      switch (typeof x) {
        case 'string': return str(x);
        case 'number': units += 8; return Number.isFinite(x) ? x : { $num: String(x) };
        case 'boolean': units += 5; return x;
        case 'undefined': units += 10; return { $undef: 1 }; // JSON 會吃掉 undefined，要能分辨「值是 undefined」與「沒有這個屬性」
        case 'bigint': return { $bigint: x.toString() };
        case 'symbol': return { $symbol: String(x) };
        default:
          if (x === null) { units += 4; return null; }
          return ref(x, path);
      }
    }
    function ref(o, path) {
      const nid = nodeIds.get(o);
      if (nid !== undefined) { units += 12; return { $node: nid }; }
      if (o === W || o === window) return { $window: 1 };
      const id = ids.get(o);
      if (id !== undefined) { units += 12; return { $ref: id }; }
      if (units > budget) return omit(path, 'budget');
      const nid2 = objs.length;
      ids.set(o, nid2); objs.push(null); queue.push([o, nid2, path]); units += 12;
      return { $ref: nid2 };
    }
    function tagOf(o) { try { return Object.prototype.toString.call(o).slice(8, -1); } catch (e) { return '?'; } }
    function isNativeFn(f) {
      if (typeof f !== 'function') return false;
      let r = nativeFnCache.get(f);
      if (r === undefined) { try { r = /\{\s*\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(f)); } catch (e) { r = true; } nativeFnCache.set(f, r); }
      return r;
    }
    // 瀏覽器內建原型的集合：從原生建立的元素往上走原型鏈取得，不依賴可能被網站替換的全域名稱
    let nativeSet = null;
    function nativeProtos() {
      if (nativeSet) return nativeSet;
      nativeSet = new Set();
      const add = (o) => { let p = o; while (p) { nativeSet.add(p); try { p = Object.getPrototypeOf(p); } catch (e) { break; } } };
      safe('nativeProtos', () => {
        add(Object.getPrototypeOf(document.createElement('div')));
        add(Object.getPrototypeOf(document.createElementNS('http://www.w3.org/2000/svg', 'g')));
        add(Object.getPrototypeOf(document));
      });
      return nativeSet;
    }
    // 自訂類別（非瀏覽器內建）在原型鏈上定義的 getter／欄位：Lit 的 reactive property、自訂元素的 data getter 都在這裡
    function classDefined(o) {
      const out = [];
      let p;
      try { p = Object.getPrototypeOf(o); } catch (e) { return out; }
      const natives = nativeProtos();
      while (p && p !== Object.prototype && !natives.has(p)) {
        let ctor;
        try { ctor = p.constructor; } catch (e) { break; }
        // 到了瀏覽器內建的原型就停。只看建構子是不是原生函式不夠：YouTube 會替換全域 HTMLElement，
        // 那時建構子不是原生，判斷失效，曾一路讀進 HTMLElement.prototype，title／lang／hidden 各混進 333 筆（v1.0.0 開發時）
        if (isNativeFn(ctor)) break;
        let names;
        try { names = Object.getOwnPropertyNames(p); } catch (e) { break; }
        for (const k of names) {
          if (k === 'constructor') continue;
          let d;
          try { d = Object.getOwnPropertyDescriptor(p, k); } catch (e) { continue; }
          if (d && d.get) out.push([k, d.get]);
        }
        try { p = Object.getPrototypeOf(p); } catch (e) { break; }
      }
      return out;
    }
    function props(o, path, entry, skipOwnIndex) {
      let names;
      try { names = Object.getOwnPropertyNames(o); } catch (e) { entry.err = String(e); return; }
      const p = {};
      let getters = null;
      for (const k of names) {
        if (skipOwnIndex && /^\d+$/.test(k)) continue;
        if (skipOwnIndex && k === 'length') continue;
        let d;
        try { d = Object.getOwnPropertyDescriptor(o, k); } catch (e) { p[k] = { $error: String(e) }; continue; }
        if (!d) continue;
        if ('value' in d) p[k] = v(d.value, path + '.' + k);
        else if (d.get) {
          try { p[k] = v(d.get.call(o), path + '.' + k); } catch (e) { p[k] = { $getterError: String((e && e.message) || e) }; }
          (getters || (getters = [])).push(k);
        }
      }
      for (const [k, g] of classDefined(o)) {
        if (k in p) continue;
        try { p[k] = v(g.call(o), path + '.' + k); } catch (e) { p[k] = { $getterError: String((e && e.message) || e) }; }
        (getters || (getters = [])).push(k);
      }
      try {
        const syms = Object.getOwnPropertySymbols(o);
        if (syms.length) {
          entry.sym = syms.map((s) => { let val; try { val = v(o[s], path + '[' + String(s) + ']'); } catch (e) { val = { $error: String(e) }; } return [String(s), val]; });
        }
      } catch (e) { /* 取不到 symbol 屬性就略過 */ }
      entry.p = p;
      if (getters) entry.g = getters;
    }
    function expand(o, path) {
      if (typeof o === 'function') {
        let src = '';
        try { src = Function.prototype.toString.call(o); } catch (e) { src = '$error ' + e; }
        units += Math.min(src.length, 1000);
        const e = { c: 'Function', name: safeGet(o, 'name'), len: src.length, src: src.length > 1000 ? src.slice(0, 1000) : src };
        if (src.length > 1000) e.srcCut = true; // 函式原始碼只留前 1000 字：完整原始碼在網站的 .js 檔裡，看 src 開頭就能定位
        return e;
      }
      const tag = tagOf(o);
      if (isNodeLike(o)) return { c: 'DetachedNode', d: nodeDesc(o) }; // 不在封存的樹裡（已移除或在 iframe 等處）
      if (Array.isArray(o)) {
        const a = new Array(o.length);
        for (let i = 0; i < o.length; i++) { try { a[i] = v(o[i], path + '[' + i + ']'); } catch (e) { a[i] = { $error: String(e) }; } }
        const entry = { c: 'Array', a };
        return entry;
      }
      switch (tag) {
        case 'Map': { const e = []; o.forEach((val, k) => e.push([v(k, path + '.key'), v(val, path + '.get(' + String(k).slice(0, 40) + ')')])); return { c: 'Map', e }; }
        case 'Set': { const e = []; o.forEach((val) => e.push(v(val, path + '.item'))); return { c: 'Set', e }; }
        case 'Date': return { c: 'Date', v: isNaN(o) ? 'Invalid Date' : o.toISOString() };
        case 'RegExp': return { c: 'RegExp', v: String(o) };
        case 'Error': case 'DOMException': return { c: tag, name: safeGet(o, 'name'), message: safeGet(o, 'message'), stack: safeGet(o, 'stack') };
        case 'Promise': case 'WeakMap': case 'WeakSet': case 'WeakRef': return { c: tag, opaque: true };
        case 'ArrayBuffer': return { c: tag, bytes: o.byteLength };
        case 'Blob': case 'File': return { c: tag, size: o.size, type: o.type, name: o.name };
        case 'Location': return { c: tag, href: String(o.href) };
        case 'CSSStyleDeclaration': return { c: tag, cssText: str(o.cssText) };
        case 'Storage': return { c: tag, length: o.length };
        default:
          if (ArrayBuffer.isView && ArrayBuffer.isView(o)) return { c: tag, bytes: o.byteLength, length: o.length };
      }
      let ctorName = tag;
      try { const p = Object.getPrototypeOf(o); if (p && p.constructor && p.constructor.name) ctorName = p.constructor.name; } catch (e) { /* 取不到建構子名稱就用 toString tag */ }
      const entry = { c: ctorName };
      props(o, path, entry, false);
      return entry;
    }
    function safeGet(o, k) { try { const x = o[k]; return x == null ? x : String(x); } catch (e) { return '$error'; } }
    function drain() {
      while (qi < queue.length) {
        const item = queue[qi]; queue[qi++] = null;
        try { objs[item[1]] = expand(item[0], item[2]); } catch (e) { objs[item[1]] = { $error: String((e && e.message) || e), path: item[2] }; }
      }
    }
    return {
      v, str, drain, props, classDefined,
      get objs() { return objs; },
      get omissions() { return omissions; },
      get omissionCount() { return omissionCount; },
      get units() { return units; },
    };
  }

  // ── 第 1 級：DOM 樹（扁平、穩定 id、父子明確） ──
  function walkDom() {
    const nodes = [];
    const nodeIds = new Map();
    const stack = [[document, -1, 0, null]];
    while (stack.length) {
      const [node, parent, k, via] = stack.pop();
      const id = nodes.length;
      nodeIds.set(node, id);
      const e = { id, p: parent, k, t: node.nodeType };
      if (via) e.via = via; // shadow-open / shadow-closed / template
      nodes.push(e);
      try { describeNode(node, e); } catch (err) { e.err = String(err); }
      const kids = [];
      try {
        if (node.nodeType === 1) {
          const sr = node.shadowRoot || shadowRoots.get(node) || null;
          if (sr) kids.push([sr, sr.mode === 'closed' ? 'shadow-closed' : 'shadow-open']);
          if (node.localName === 'template' && node.content) kids.push([node.content, 'template']);
        }
        const cn = node.childNodes;
        for (let i = 0; i < cn.length; i++) kids.push([cn[i], null]);
      } catch (err) { e.kidsErr = String(err); }
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i][0], id, i, kids[i][1]]);
    }
    return { nodes, nodeIds };
  }
  function describeNode(n, e) {
    switch (n.nodeType) {
      case 1: {
        e.n = n.localName;
        if (n.namespaceURI && n.namespaceURI !== 'http://www.w3.org/1999/xhtml') e.ns = n.namespaceURI;
        if (n.attributes.length) {
          e.a = [];
          for (const at of n.attributes) e.a.push([at.name, at.value]); // 值的 data: 分類在 finalize 時做（共用序列化器）
        }
        const st = n.style;
        if (st && st.length) {
          e.st = [];
          for (let i = 0; i < st.length; i++) { const k = st[i]; e.st.push([k, st.getPropertyValue(k), st.getPropertyPriority(k)]); }
        }
        if (n.localName.indexOf('-') !== -1) e.ce = { defined: !!W.customElements.get(n.localName) };
        break;
      }
      case 3: case 4: case 8: e.v = n.data; break;
      case 7: e.n = n.target; e.v = n.data; break;
      case 9: e.n = '#document'; e.url = n.URL; e.mode = n.compatMode; break;
      case 10: e.n = n.name; break;
      case 11: if (n.mode) e.mode = n.mode; break;
    }
  }

  // 元素身上框架掛的資料：自有屬性（Polymer __data、React __reactFiber$…、Vue __vue__）＋自訂類別的 getter（data、rawProps…）
  function collectInternals(nodes, nodeRefs, ser) {
    let count = 0;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodeRefs[i];
      if (!n || n.nodeType !== 1) continue;
      try {
        let own;
        try { own = Object.getOwnPropertyNames(n); } catch (e) { own = []; }
        const cls = n.localName.indexOf('-') !== -1 ? ser.classDefined(n) : [];
        if (!own.length && !cls.length) continue;
        const entry = {};
        ser.props(n, 'nodes[' + i + ']', entry, false);
        nodes[i].x = entry.p;
        if (entry.g) nodes[i].xg = entry.g;
        if (entry.sym) nodes[i].xsym = entry.sym;
        count++;
      } catch (e) { nodes[i].xErr = String((e && e.message) || e); }
    }
    return count;
  }

  // 監聽器：addEventListener 登記的（含錄製時的註冊堆疊）＋ on* 屬性
  let ON_PROPS = null;
  function onProps() {
    if (ON_PROPS) return ON_PROPS;
    const set = new Set();
    for (const proto of [W.HTMLElement && W.HTMLElement.prototype, W.Element && W.Element.prototype, W.Document && W.Document.prototype]) {
      if (!proto) continue;
      try { for (const k of Object.getOwnPropertyNames(proto)) if (k.slice(0, 2) === 'on') set.add(k); } catch (e) { /* 取不到就少幾個 */ }
    }
    ON_PROPS = Array.from(set);
    return ON_PROPS;
  }
  function listenerEntries(target, ser, path) {
    const out = [];
    const list = listenerReg.get(target);
    if (list) {
      for (const r of list) {
        let aborted = false;
        try { aborted = !!(r.signal && r.signal.aborted); } catch (e) { /* 讀不到就當沒中止 */ }
        out.push({
          type: r.type, capture: r.capture, once: r.once, passive: r.passive, aborted, seq: r.seq, t: r.t,
          fn: ser.v(r.fn, path + '.listener'),
          stack: r.stack ? stackStr(r.stack) : null,
        });
      }
    }
    for (const k of onProps()) {
      let f;
      try { f = target[k]; } catch (e) { continue; }
      if (typeof f === 'function') out.push({ type: k.slice(2), via: 'property', fn: ser.v(f, path + '.' + k) });
    }
    return out;
  }
  function stackStr(err) { try { return String(err.stack); } catch (e) { return '$error ' + e; } }

  // ── 第 2 級：computed style（同一組值只存一份）、偽元素、位置 ──
  function collectStyles(nodes, nodeRefs) {
    const table = [];
    const index = new Map();
    const intern = (cs) => {
      const vals = new Array(cs.length);
      for (let i = 0; i < cs.length; i++) { const k = cs[i]; vals[i] = k + ':' + cs.getPropertyValue(k); }
      const key = vals.join('\n');
      let id = index.get(key);
      if (id === undefined) { id = table.length; index.set(key, id); table.push(vals); }
      return id;
    };
    for (let i = 0; i < nodes.length; i++) {
      const n = nodeRefs[i];
      if (!n || n.nodeType !== 1) continue;
      try {
        nodes[i].cs = intern(W.getComputedStyle(n));
        for (const pe of ['::before', '::after']) {
          const ps = W.getComputedStyle(n, pe);
          const c = ps.getPropertyValue('content');
          if (c && c !== 'none' && c !== 'normal') (nodes[i].pseudo || (nodes[i].pseudo = {}))[pe] = { content: c, cs: intern(ps) };
        }
        const r = n.getBoundingClientRect();
        nodes[i].box = [round2(r.x), round2(r.y), round2(r.width), round2(r.height)];
      } catch (e) { nodes[i].csErr = String((e && e.message) || e); }
    }
    return table;
  }
  const round2 = (x) => Math.round(x * 100) / 100;

  // ── 環境 ─────────────────────────────────────────────
  function taipeiTime() {
    try { return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }) + ' +08:00'; } catch (e) { return new Date().toISOString(); }
  }
  function envInfo(tier) {
    const d = document.documentElement;
    return {
      tool: 'page-state-recorder', schema: 1, version: VERSION, instanceId, tier,
      time: taipeiTime(), timeUTC: new Date().toISOString(), perfNow: perfNow(),
      url: location.href, title: document.title, referrer: document.referrer, readyState: document.readyState,
      userAgent: navigator.userAgent, language: navigator.language,
      viewport: { w: W.innerWidth, h: W.innerHeight }, dpr: W.devicePixelRatio,
      scroll: { x: W.scrollX, y: W.scrollY },
      docSize: d ? { w: d.scrollWidth, h: d.scrollHeight } : null,
      excluded, hooksInstalled: hooksInstalled.slice(),
      context: W === window ? 'page' : 'isolated',
      settings,
      recording: {
        on: REC.on, since: REC.since,
        sizes: mapObj(REC.buf, (r) => r.size), caps: mapObj(REC.buf, (r) => r.cap), dropped: mapObj(REC.buf, (r) => r.dropped),
      },
      hookErrorCount, hookErrors: hookErrors.slice(),
    };
  }
  function mapObj(o, f) { const r = {}; for (const k of Object.keys(o)) r[k] = f(o[k]); return r; }

  // 讀這份檔案的人必須能分辨「它不存在」與「它沒被抓進來」：工具已知看不到的範圍一律寫明
  function notCaptured(tier) {
    const list = [
      'iframe 內部文件（@noframes；iframe 本身列在 frames）',
      '跨網域樣式表的規則內容（瀏覽器禁止讀取；列在 stylesheets.rulesError）',
      '函式原始碼超過 1000 字的部分（各函式以 srcCut 標示）',
      '「是誰改了屬性／樣式」的呼叫堆疊（第 4 檔，尚未實作）',
      'WebSocket、EventSource、navigator.sendBeacon、Service Worker 內的請求',
    ];
    if (excluded) list.push('本網站在排除名單：第 3 級包裝沒有安裝，監聽器、網路、console、closed shadow root、變更歷程全部沒有');
    else {
      list.push('包裝裝好之前（腳本注入前）就註冊的監聽器、建立的 closed shadow root');
      if (!REC.since) list.push('錄製從未打開：網路、console、錯誤、變更歷程沒有任何紀錄；監聽器沒有註冊堆疊');
      else list.push('錄製打開之前的網路、console、錯誤、變更；錄製前註冊的監聽器沒有註冊堆疊');
    }
    if (tier < 2) list.push('computed style、偽元素、bounding box（第 2 級才有）');
    return list;
  }

  // ── 封存主流程 ───────────────────────────────────────
  function dump(tier) {
    const t0 = perfNow();
    const stats = {};
    const { nodes, nodeIds } = walkDom();
    const nodeRefs = new Array(nodes.length);
    nodeIds.forEach((id, n) => { nodeRefs[id] = n; });
    stats.nodes = nodes.length;
    stats.walkMs = round2(perfNow() - t0);

    const ser = createSerializer(nodeIds, settings.budgetUnits);
    // 屬性值走共用的字串分類（大塊二進位 data: 換成描述）
    for (const e of nodes) if (e.a) for (const pair of e.a) pair[1] = ser.str(pair[1]);
    for (const e of nodes) if (e.t === 3 || e.t === 4 || e.t === 8) e.v = ser.str(e.v);

    const t1 = perfNow();
    stats.elementsWithInternals = collectInternals(nodes, nodeRefs, ser);

    const listeners = [];
    let listenerCount = 0;
    if (!excluded) {
      const pushL = (target, key) => {
        const l = listenerEntries(target, ser, key);
        if (l.length) { listeners.push({ target: key, list: l }); listenerCount += l.length; }
      };
      pushL(W, 'window');
      for (let i = 0; i < nodeRefs.length; i++) {
        const n = nodeRefs[i];
        if (n && (n.nodeType === 1 || n.nodeType === 9)) {
          const l = listenerEntries(n, ser, 'nodes[' + i + ']');
          if (l.length) { listeners.push({ node: i, list: l }); listenerCount += l.length; }
        }
      }
      for (const ref of nonNodeTargets) {
        const tg = ref.deref();
        if (!tg) continue;
        const l = listenerEntries(tg, ser, 'nonNode');
        if (l.length) { listeners.push({ target: ser.v(tg, 'nonNodeTarget'), list: l }); listenerCount += l.length; }
      }
    }
    stats.listeners = listenerCount;

    const diag = collectDiag(ser);

    const recOut = {};
    for (const kind of Object.keys(REC.buf)) {
      recOut[kind] = REC.buf[kind].toArray().map((item, i) => {
        const o = {};
        for (const k of Object.keys(item)) {
          const val = item[k];
          if (k === 'stack' && val) o.stack = stackStr(val);
          else o[k] = inlinePlain(val, ser, kind + '[' + i + '].' + k);
        }
        return o;
      });
    }
    ser.drain();
    stats.objects = ser.objs.length;
    stats.serializeMs = round2(perfNow() - t1);
    stats.budgetUnitsUsed = ser.units;

    let styles = null;
    if (tier >= 2) {
      const t2 = perfNow();
      styles = collectStyles(nodes, nodeRefs);
      stats.uniqueStyles = styles.length;
      stats.styleMs = round2(perfNow() - t2);
    }

    const frames = [];
    try {
      for (const f of document.querySelectorAll('iframe, frame')) {
        const r = f.getBoundingClientRect();
        frames.push({ node: nodeIds.get(f), src: f.src || null, w: round2(r.width), h: round2(r.height) });
      }
    } catch (e) { frames.push({ $error: String(e) }); }

    const stylesheets = [];
    try {
      for (const sh of document.styleSheets) {
        const s = { href: sh.href, node: sh.ownerNode ? nodeIds.get(sh.ownerNode) : null, disabled: sh.disabled, media: String(sh.media && sh.media.mediaText || '') };
        try { s.rules = sh.cssRules.length; } catch (e) { s.rulesError = String((e && e.name) || e); }
        stylesheets.push(s);
      }
    } catch (e) { stylesheets.push({ $error: String(e) }); }

    const shadowCount = nodes.filter((e) => e.via === 'shadow-open' || e.via === 'shadow-closed').length;
    stats.shadowRoots = shadowCount;
    stats.closedShadowRoots = nodes.filter((e) => e.via === 'shadow-closed').length;
    stats.totalMs = round2(perfNow() - t0);

    const out = {
      env: envInfo(tier),
      notCaptured: notCaptured(tier),
      stats,
      omissions: { count: ser.omissionCount, listed: ser.omissions.length, items: ser.omissions },
      diag,
      frames,
      stylesheets,
      nodes,
      objs: ser.objs,
      styles,
      listeners,
      network: recOut.network,
      console: recOut.console,
      errors: recOut.errors,
      mutations: recOut.mutations,
    };
    return toJsonParts(out);
  }

  // 錄製項目裡由封存器自己組出來的單純陣列／物件（標頭、請求描述）直接內嵌，查詢時不用多跳一層 $ref；
  // 節點與網頁的物件才交給序列化器（節點會變成 $node）
  function inlinePlain(val, ser, path) {
    if (val === null || typeof val !== 'object') return ser.v(val, path);
    if (Array.isArray(val)) return val.map((x, i) => inlinePlain(x, ser, path + '[' + i + ']'));
    let proto;
    try { proto = Object.getPrototypeOf(val); } catch (e) { return ser.v(val, path); }
    if (proto !== Object.prototype && proto !== null) return ser.v(val, path);
    const o = {};
    for (const k of Object.keys(val)) o[k] = inlinePlain(val[k], ser, path + '.' + k);
    return o;
  }

  // 分段 stringify：整份一次 JSON.stringify 遇到上百 MB 會撞到字串長度上限
  function toJsonParts(out) {
    const parts = ['{'];
    let first = true;
    for (const k of Object.keys(out)) {
      parts.push((first ? '' : ',') + JSON.stringify(k) + ':');
      first = false;
      const val = out[k];
      if (Array.isArray(val) && val.length > 200) {
        parts.push('[');
        for (let i = 0; i < val.length; i++) parts.push((i ? ',' : '') + JSON.stringify(val[i] === undefined ? null : val[i]));
        parts.push(']');
      } else parts.push(JSON.stringify(val === undefined ? null : val));
    }
    parts.push('}');
    return parts;
  }

  function fileName() {
    const ts = taipeiTime().slice(0, 19).replace(/[-:]/g, '').replace(' ', '-');
    const host = (HOST || 'local').replace(/[^a-z0-9.-]/gi, '_');
    return 'page-state_' + host + '_' + ts + '.json';
  }
  function download(parts, name) {
    const blob = new Blob(parts, { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return blob.size;
  }

  // ── 提示（最小 16px；層級只用字級與顏色區分） ──
  let toastEl = null, toastTimer = 0;
  function toast(msg, sub, ms) {
    try {
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.setAttribute('data-psr-toast', '');
        toastEl.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;max-width:420px;padding:12px 16px;' +
          'border-radius:8px;background:#1f2328;color:#f0f3f6;font:16px/1.5 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3);white-space:pre-line';
      }
      toastEl.textContent = '';
      const a = document.createElement('div'); a.textContent = msg; toastEl.appendChild(a);
      if (sub) { const b = document.createElement('div'); b.textContent = sub; b.style.cssText = 'font-size:16px;color:#9da7b3;margin-top:4px'; toastEl.appendChild(b); }
      (document.body || document.documentElement).appendChild(toastEl);
      clearTimeout(toastTimer);
      if (ms) toastTimer = setTimeout(() => { if (toastEl) toastEl.remove(); }, ms);
    } catch (e) { hookErr('toast', e); }
  }

  function runDump(tier) {
    toast('封存中（第 ' + tier + ' 級）…', '頁面可能短暫卡住', 0);
    // 等提示先畫出來，再開始同步的重工作
    setTimeout(() => {
      try {
        const t0 = perfNow();
        const parts = dump(tier);
        if (toastEl) toastEl.remove(); // 提示框本身不該留在下一次的封存裡
        const size = download(parts, fileName());
        toast('封存完成', (size / 1048576).toFixed(1) + ' MB，' + Math.round(perfNow() - t0) + ' ms', 4000);
      } catch (e) {
        hookErr('dump', e);
        toast('封存失敗', String((e && e.message) || e), 8000);
      }
    }, 50);
  }

  // ── 選單 ─────────────────────────────────────────────
  let menuIds = [];
  function buildMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    if (typeof GM_unregisterMenuCommand === 'function') for (const id of menuIds) { try { GM_unregisterMenuCommand(id); } catch (e) { /* 舊版沒有就重複註冊 */ } }
    menuIds = [];
    const add = (label, fn) => { try { menuIds.push(GM_registerMenuCommand(label, fn)); } catch (e) { hookErr('menu', e); } };
    add('封存：第 1 級（DOM＋內部資料）', () => runDump(1));
    add('封存：第 1＋2 級（加 computed style、位置）', () => runDump(2));
    if (!excluded) {
      if (REC.on) {
        const n = Object.keys(REC.buf).reduce((s, k) => s + REC.buf[k].size, 0);
        add('■ 停止錄製（已錄 ' + n + ' 筆）', () => { setRecording(false); buildMenu(); toast('已停止錄製', '已錄的內容保留到下一次封存', 3000); });
      } else {
        add('● 開始錄製（第 3 級：網路、console、變更）', () => { setRecording(true); buildMenu(); toast('開始錄製', '這個分頁重新整理後會繼續錄', 3000); });
      }
      add('清空錄製內容', () => { for (const k of Object.keys(REC.buf)) REC.buf[k].clear(); buildMenu(); toast('已清空錄製內容', '', 2000); });
    }
    if (excluded) {
      add('把 ' + HOST + ' 移出排除名單（重新整理後生效）', () => {
        settings = loadSettings(); settings.exclude = settings.exclude.filter((h) => h !== HOST); saveSettings(settings);
        toast('已移出排除名單', '重新整理後安裝第 3 級包裝', 4000);
      });
    } else {
      add('把 ' + HOST + ' 加入排除名單（網站被弄壞時用）', () => {
        settings = loadSettings(); if (settings.exclude.indexOf(HOST) === -1) settings.exclude.push(HOST); saveSettings(settings);
        setRecording(false);
        toast('已加入排除名單', '重新整理後這個網站不再安裝包裝', 4000);
      });
    }
  }
  safe('menu', buildMenu);

  // 測試用：無頭瀏覽器沒有選單，測試腳本透過這個入口直接呼叫（不改變任何行為）
  try {
    const api = { dumpParts: (tier) => dump(tier || 1), setRecording: (on) => setRecording(!!on), version: VERSION };
    Object.defineProperty(W, '__psrTest', { value: typeof cloneInto === 'function' && W !== window ? cloneInto(api, W, { cloneFunctions: true }) : api, configurable: true });
  } catch (e) { hookErr('test api', e); }
})();
