// 真實網站冒煙測試：載入網站、開錄製、封存兩個級別，回報網頁錯誤、封存耗時與大小。
// 用法：NODE_PATH=... node tests/real-site.js https://www.youtube.com/
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'page-state-recorder.user.js'), 'utf8');
const url = process.argv[2] || 'https://www.youtube.com/';

(async () => {
  const browser = await chromium.launch();
  const out = {};
  for (const withScript of [false, true]) {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'zh-TW' });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
    await page.addInitScript(`window.GM_getValue=(k,d)=>d;window.GM_setValue=()=>{};window.GM_registerMenuCommand=()=>0;window.GM_info={script:{version:'test'}};
      try { sessionStorage.setItem('psr-recording','1'); } catch (e) {}`);
    if (withScript) await page.addInitScript(SCRIPT);
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(4000);
    const r = { pageErrors: errs };
    if (withScript) {
      for (const tier of [1, 2]) {
        const t0 = Date.now();
        const s = await page.evaluate((t) => window.__psrTest.dumpParts(t).join(''), tier);
        const ms = Date.now() - t0;
        const d = JSON.parse(s);
        fs.writeFileSync(path.join(__dirname, `out-real-tier${tier}.json`), s);
        r['tier' + tier] = { ms, MB: +(s.length / 1048576).toFixed(1), stats: d.stats, omissions: d.omissions.count,
          hookErrors: d.env.hookErrorCount, hookErrorSample: d.env.hookErrors.slice(0, 3), rec: d.env.recording.sizes,
          context: d.env.context, notCaptured: d.notCaptured.length };
      }
    }
    out[withScript ? 'withRecorder' : 'baseline'] = r;
    await ctx.close();
  }
  await browser.close();
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(2); });
