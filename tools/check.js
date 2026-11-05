// 推送前的固定檢查（01 第⑤條）：語法、同作用域重複宣告、未定義識別字＋作用域解析。
// 用法：NODE_PATH=<含 acorn 與 playwright 的 node_modules> node tools/check.js [檔案]
// 全域名稱清單不手寫：直接從無頭 Chromium 的 window 取得，再加上 Tampermonkey 提供的名稱。
// 判斷用 AST 不用 grep：grep 會把註解裡的舊碼算進去，也分不出作用域（01 已知失敗案例）。
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const file = process.argv[2] || path.join(__dirname, '..', 'page-state-recorder.user.js');
const src = fs.readFileSync(file, 'utf8');
const GM_GLOBALS = ['unsafeWindow', 'GM_info', 'GM_getValue', 'GM_setValue', 'GM_registerMenuCommand', 'GM_unregisterMenuCommand', 'exportFunction', 'cloneInto', 'createObjectIn', 'GM_xmlhttpRequest', 'GM_addStyle', 'GM_deleteValue', 'GM_listValues', 'GM_download', 'GM_openInTab', 'GM_setClipboard', 'GM_notification', 'GM'];

let failed = false;
const report = (name, ok, detail) => { console.log((ok ? 'OK   ' : 'FAIL ') + name + (detail ? '  ' + detail : '')); if (!ok) failed = true; };

// ① 語法
let ast;
try { ast = acorn.parse(src, { ecmaVersion: 2022, sourceType: 'script', locations: true }); report('語法（acorn）', true); }
catch (e) { report('語法（acorn）', false, 'line ' + (e.loc && e.loc.line) + ': ' + e.message); process.exit(1); }

// ② ③ 作用域樹：先收集每個作用域的宣告，再逐一解析參照
class Scope {
  constructor(parent, isFn) { this.parent = parent; this.isFn = isFn; this.names = new Map(); }
  fnScope() { let s = this; while (!s.isFn) s = s.parent; return s; }
  declare(name, kind, node, dups) {
    const prev = this.names.get(name);
    if (prev && !(prev === 'var' && kind === 'var')) dups.push(name + '（第 ' + node.loc.start.line + ' 行，與先前的 ' + prev + ' 撞名）');
    this.names.set(name, kind);
  }
  resolve(name) { for (let s = this; s; s = s.parent) if (s.names.has(name)) return true; return false; }
}
const dups = [];
const refs = []; // [scope, name, line]

function patternNames(p, out) {
  if (!p) return out;
  switch (p.type) {
    case 'Identifier': out.push(p); break;
    case 'ObjectPattern': for (const pr of p.properties) patternNames(pr.type === 'RestElement' ? pr.argument : pr.value, out); break;
    case 'ArrayPattern': for (const el of p.elements) patternNames(el, out); break;
    case 'RestElement': patternNames(p.argument, out); break;
    case 'AssignmentPattern': patternNames(p.left, out); break;
  }
  return out;
}
// 宣告收集：var 提升到函式作用域；let／const／class／function（strict 模式）屬於所在區塊
function hoist(body, scope) {
  for (const st of body) declareStmt(st, scope);
}
function declareStmt(st, scope) {
  if (!st) return;
  if (st.type === 'VariableDeclaration') {
    const target = st.kind === 'var' ? scope.fnScope() : scope;
    for (const d of st.declarations) for (const id of patternNames(d.id, [])) target.declare(id.name, st.kind, id, dups);
  } else if (st.type === 'FunctionDeclaration') scope.declare(st.id.name, 'function', st.id, dups);
  else if (st.type === 'ClassDeclaration') scope.declare(st.id.name, 'class', st.id, dups);
  else if (st.type === 'ExportNamedDeclaration' && st.declaration) declareStmt(st.declaration, scope);
}

function visit(node, scope) {
  if (!node || typeof node.type !== 'string') return;
  switch (node.type) {
    case 'Program': { const s = new Scope(null, true); hoist(node.body, s); for (const c of node.body) visit(c, s); return; }
    case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': {
      const s = new Scope(scope, true);
      if (node.type === 'FunctionExpression' && node.id) s.declare(node.id.name, 'fnname', node.id, []);
      if (node.type !== 'ArrowFunctionExpression') s.names.set('arguments', 'implicit');
      for (const p of node.params) { for (const id of patternNames(p, [])) s.declare(id.name, 'param', id, dups); visitPatternDefaults(p, s); }
      if (node.body.type === 'BlockStatement') { hoist(node.body.body, s); for (const c of node.body.body) visit(c, s); }
      else visit(node.body, s);
      return;
    }
    case 'BlockStatement': case 'StaticBlock': { const s = new Scope(scope, false); hoist(node.body, s); for (const c of node.body) visit(c, s); return; }
    case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': {
      const s = new Scope(scope, false);
      const init = node.init || node.left;
      if (init && init.type === 'VariableDeclaration') declareStmt(init, s);
      for (const k of ['init', 'left', 'test', 'update', 'right', 'body']) visit(node[k], s);
      return;
    }
    case 'CatchClause': { const s = new Scope(scope, false); if (node.param) for (const id of patternNames(node.param, [])) s.declare(id.name, 'catch', id, dups); visit(node.body, s); return; }
    case 'ClassDeclaration': case 'ClassExpression': {
      const s = new Scope(scope, false);
      if (node.id) s.names.set(node.id.name, 'class');
      visit(node.superClass, s); visit(node.body, s); return;
    }
    case 'VariableDeclaration': for (const d of node.declarations) { visitPatternDefaults(d.id, scope); visit(d.init, scope); } return;
    case 'Identifier': refs.push([scope, node.name, node.loc.start.line]); return;
    case 'MemberExpression': visit(node.object, scope); if (node.computed) visit(node.property, scope); return;
    case 'Property': case 'PropertyDefinition': case 'MethodDefinition':
      if (node.computed) visit(node.key, scope);
      visit(node.value, scope); return;
    case 'LabeledStatement': visit(node.body, scope); return;
    case 'BreakStatement': case 'ContinueStatement': return;
  }
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end') continue;
    const v = node[k];
    if (Array.isArray(v)) for (const c of v) visit(c, scope);
    else if (v && typeof v.type === 'string') visit(v, scope);
  }
}
// 解構預設值、物件模式裡的計算鍵屬於參照，不是宣告
function visitPatternDefaults(p, scope) {
  if (!p) return;
  if (p.type === 'AssignmentPattern') { visit(p.right, scope); visitPatternDefaults(p.left, scope); }
  else if (p.type === 'ObjectPattern') for (const pr of p.properties) { if (pr.computed) visit(pr.key, scope); visitPatternDefaults(pr.type === 'RestElement' ? pr.argument : pr.value, scope); }
  else if (p.type === 'ArrayPattern') for (const el of p.elements) visitPatternDefaults(el, scope);
}

visit(ast, null);
report('同作用域重複宣告（AST）', dups.length === 0, dups.join('；'));

(async () => {
  let browserGlobals;
  try {
    const { chromium } = require('playwright');
    const b = await chromium.launch();
    const p = await b.newPage();
    browserGlobals = await p.evaluate(() => { const s = new Set(); for (let o = window; o; o = Object.getPrototypeOf(o)) for (const k of Object.getOwnPropertyNames(o)) s.add(k); return [...s]; });
    await b.close();
  } catch (e) { report('取得瀏覽器全域名稱', false, String(e)); process.exit(1); }
  const globals = new Set(browserGlobals.concat(GM_GLOBALS, ['undefined', 'NaN', 'Infinity', 'globalThis']));
  const missing = [];
  for (const [scope, name, line] of refs) if (!scope.resolve(name) && !globals.has(name)) missing.push(name + '（第 ' + line + ' 行）');
  report('未定義識別字＋作用域解析（每個參照沿作用域鏈找得到宣告）', missing.length === 0, [...new Set(missing)].join('；'));
  process.exit(failed ? 1 : 0);
})();
