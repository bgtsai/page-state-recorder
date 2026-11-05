[切換中文](README.zh-TW.md)

# Page State Recorder

One click exports the complete state of the current page as a **single JSON file**: the DOM (including open and closed Shadow DOM), custom elements' internal data, styles, event listeners, network requests, console output, errors and element mutation history.

It is a debugging tool. The goal: once you have an export, any question you think of afterwards can be **answered by querying the file with code**, without asking someone to open DevTools, run commands and copy-paste results.

## Install

Requires Tampermonkey (Chrome, Edge, Firefox).

[Install page-state-recorder.user.js](https://raw.githubusercontent.com/bgtsai/page-state-recorder/main/page-state-recorder.user.js)

The script loads on every site. It does nothing until you use one of its commands in the Tampermonkey menu.

## Usage

From the Tampermonkey menu:

| Command | What it does |
|---|---|
| 封存：第 1 級 (Dump: tier 1) | Downloads the export. Measured on a signed-in YouTube home page: about 13 s and 75 MB (about 15,000 nodes); the page freezes meanwhile |
| 封存：第 1＋2 級 (Dump: tiers 1+2) | Adds every element's computed style, `::before`/`::after` and box. Much slower than tier 1 (a signed-out YouTube home page with about 4,000 nodes already takes 15–20 s and over 100 MB) |
| ● 開始錄製 / ■ 停止錄製 (Start / stop recording) | Tier 3: records network, console, errors and mutations; listeners registered while recording carry their registration call stack. Survives reloads in the same tab |
| 清空錄製內容 (Clear recording) | Discards recorded entries |
| Add / remove this site to the exclude list | Use when the recorder breaks a site. Excluded sites get no hooks at all (tiers 1 and 2 still work); takes effect after reload |

## Three tiers

| Tier | Contents | Needs preparation? |
|---|---|---|
| 1 | Full DOM, attributes, inline style (with `!important`), custom element internals (framework data attached to elements and getters defined by custom classes), script state handed over via `__diagQueue` | No |
| 2 | + computed style (each distinct set stored once), pseudo-elements, bounding boxes | No |
| 3 | + listeners, closed shadow roots, network, console, errors, mutations | Yes. Hooks are installed before the page's own code; network, console, errors and mutations are only recorded **while recording is on** |

### Idle cost

Hooks are always installed; recording is switched on and off. Measured on the YouTube home page in Chrome (2026-11-06): with hooks installed and recording off, long-task time and memory were **indistinguishable** from no script. While recording, memory growth is capped (ring buffers; response bodies are not kept by default).

## Letting your scripts hand over their internal state: `__diagQueue`

The recorder cannot see settings or decisions inside other scripts' closures. Add these lines to your script and the state is included in every export:

```js
const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
(w.__diagQueue = w.__diagQueue || []).push(['My script', () => ({
  settings,             // full settings
  state,                // lists, caches…
  verdicts,             // which rule handled each element
})]);
```

Load order does not matter: the function is only called at dump time. If it throws, the export records the error and the dump continues.

## Export format

| Field | Contents |
|---|---|
| `env` | Time (Taipei), URL, scroll position, viewport, script version, settings, recording state, installed hooks, the recorder's own errors |
| `notCaptured` | **What this file does not contain.** Read it first: it is how you tell "does not exist" from "was not captured" |
| `stats`, `omissions` | Counts and timings; anything dropped by the size budget (path and reason). Zero when nothing was dropped |
| `nodes` | Flat array where `id` equals the index; `p` parent, `k` position within the parent, `via` marks `shadow-open` / `shadow-closed` / `template` |
| `objs` | Object table. Referenced elsewhere as `{"$ref": n}`; references to DOM nodes are `{"$node": id}` |
| `styles` | Tier 2 computed style table; a node's `cs` indexes into it |
| `listeners` | Listeners per node (`node`) or on `window` |
| `network`, `console`, `errors`, `mutations` | Tier 3 recordings |
| `diag` | State handed over via `__diagQueue` |
| `frames`, `stylesheets` | Iframes; stylesheets (`rulesError` when cross-origin rules cannot be read) |

Special values: `{"$undef":1}` (the value is undefined), `{"$binary":mime,"len":n,"hash":h}` (large binary `data:` URIs replaced by a description; SVG and text types are always kept verbatim), `{"$getterError":...}` (a getter threw), `{"$omitted":reason}` (dropped; also listed in `omissions`).

Serialization has **no depth limit**; cycles resolve to `$ref`. The only limit is a total size budget, and anything it drops is recorded.

## Known blind spots

- Documents inside iframes
- Rules of cross-origin stylesheets
- Function source beyond the first 1000 characters (marked `srcCut`)
- Call stacks for "who changed this attribute or style" (tier 4, not implemented yet)
- WebSocket, EventSource, `sendBeacon`
- Listeners and closed shadow roots created before the script was injected; events that happened before recording was switched on

## Browsers

Written for both Chrome and Firefox; automated tests run on Chromium only. When a site's CSP blocks page-context injection and Tampermonkey falls back to an isolated sandbox (the export's `env.context` is `isolated`), Firefox hooks go through `exportFunction`. That path has been run once on a real Firefox 153 on the YouTube home page: listeners and closed shadow roots were captured and the recorder reported no errors of its own (2026-11-06).

## Development

```
NODE_PATH=<node_modules with playwright and acorn> node tests/run-tests.js   # regression tests
NODE_PATH=... node tools/check.js                                            # syntax, duplicates, undefined identifiers + scope
NODE_PATH=... node tests/real-site.js https://www.youtube.com/                # real-site smoke test
```
