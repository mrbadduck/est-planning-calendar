# In-App Help Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give program leads a Help drawer in the plan app — a first-sign-in Welcome, 13 task-based guides and a What's new feed — plus a guard, a blocking Claude Code hook and a GitHub check that keep the guides in step with the app.

**Architecture:** Guides are Markdown in `web/help/`, parsed and rendered by one pure, dependency-free script (`web/help/help-lib.js`) that the browser, the node tests and the guard all load. `web/app.js` gains a self-contained HELP block (drawer, entry points, Welcome, What's-new dot, `?help=` links). `scripts/check-help.mjs` checks that every `[[label]]` in the guides still appears on screen, that every help link resolves, and that a branch changing the screens also changes the help (or says `Help: none — <reason>`); it runs as a PreToolUse hook before merges into `main` / PR creation, and as a GitHub workflow.

**Tech Stack:** Vanilla JS (buildless; classic scripts sharing globals), plain CSS on the existing tokens, Node 20+ (`node:test`, `node:child_process`), Claude Code hooks, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-29-in-app-help-design.md`

---

## Before you start (read once)

- Work on branch **`feat/help-guide`** (it already holds the spec commit): `git branch --show-current` must print `feat/help-guide`.
- The app is buildless. `web/index.html` loads classic scripts that share globals — `esc`, `state`, `PROGRAMS`, `REF_LAYERS`, `SECTIONS`, `activeSection`, `toast`, `cacheGet`, `SUPPORT_EMAIL` are all top-level in `web/app.js`. No bundler, no npm in `web/`.
- After ANY edit to a `.js` file under `web/`, run `node --check <file>` (CLAUDE.md rule).
- Unit tests use Node's built-in runner. From the repo root: `node --test proxy/test/<name>.test.js`; everything: `cd proxy && npm test`. Tests live in `proxy/test/` and are ESM (`proxy/package.json` has `"type":"module"`). `proxy/test/roster-lib.test.js` is the pattern: it imports a plain browser script for its side effect, then reads the global it attached.
- Local preview: `preview_start {name:"web"}` (config in `.claude/launch.json` → `live-server web --port=8080`). Reads work locally against the live proxy. **Sign-in usually does not** (Firebase authorized domains), so the checks below *simulate* a signed-in viewer from the browser console — inspection only, never committed, and never with write access on an existing event. **Deploy nothing.**
- The guide text (Task 6) was written from the code as of 2026-09-29. Role facts come from `openEditor` (`locked = cancelled || (approved && !canApprove)`), `footerActionsHTML`, `publishPanelHTML(ev, canEdit && !locked)` (so **only Tribal Council can publish**), `renderNotes(ev, canEdit && !locked)` and `renderSlots(ev, canEdit)`. If you find the app disagrees with a guide, **fix the guide**, never the app.

## File structure

| File | Status | Responsibility |
|---|---|---|
| `web/help/help-lib.js` | create | Pure parser/renderer for `guide.md` + `whats-new.md` (browser + node) |
| `web/help/guide.md` | create | The 13 guides, with the writing guide as a comment at the top |
| `web/help/whats-new.md` | create | Dated change notes, newest first |
| `proxy/test/help-lib.test.js` | create | Unit tests for help-lib |
| `scripts/check-help.mjs` | create | The guard: exported pure helpers + CLI + hook mode |
| `proxy/test/check-help.test.js` | create | Unit tests for the guard's pure helpers |
| `web/index.html` | modify | `?` button (replaces `i`), tagline, sign-in "New here?" link, drawer markup, help-lib script tag |
| `web/app.js` | modify | HELP block; `SECTIONS[].help`; editor/create-form `?`; status-badge button; `?help=` + dot in `init`; remove `legendHTML`/`openInfo` |
| `web/styles.css` | modify | `.help-btn` (replaces `.info-btn`), drawer, chips, legend; drop dead legend CSS |
| `.claude/settings.json` | create | PreToolUse hook → `scripts/check-help.mjs --hook` |
| `.github/workflows/check-help.yml` | create | Unit tests + content check on PRs and pushes to `main`; branch check on PRs |
| `CLAUDE.md` | modify | "Help ships with the change" rule, repo-map rows, app-structure bullet |
| `docs/superpowers/specs/2026-09-29-in-app-help-design.md` | modify | Sync the details this plan refined |

---

### Task 1: HelpLib — parse guides

**Files:**
- Create: `web/help/help-lib.js`
- Test: `proxy/test/help-lib.test.js`

- [ ] **Step 1: Write the failing test**

Create `proxy/test/help-lib.test.js`:

```js
// web/help/help-lib.js is a plain browser script that attaches `HelpLib` to
// globalThis — importing it for side effects makes it testable under node too
// (same pattern as roster-lib.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../web/help/help-lib.js';

const H = globalThis.HelpLib;

const GUIDE = [
  '<!-- writing guide: [[Not A Label]] {#nope} -->',
  '# Getting started',
  '',
  '## Welcome {#welcome}',
  '',
  'Hello [[+ New event]].',
  '',
  '## Get around {#getting-around}',
  'Use [[Overview]].',
  '# Help',
  '## Common problems {#troubleshooting}',
  'See [the welcome](#welcome).',
].join('\n');

test('parseGuide: groups, ids, titles, 1-based heading lines; comments stripped', () => {
  const { guides, errors } = H.parseGuide(GUIDE);
  assert.deepEqual(errors, []);
  assert.deepEqual(guides.map((g) => [g.group, g.id, g.title, g.line]), [
    ['Getting started', 'welcome', 'Welcome', 4],
    ['Getting started', 'getting-around', 'Get around', 8],
    ['Help', 'troubleshooting', 'Common problems', 11],
  ]);
  assert.equal(guides[0].body, 'Hello [[+ New event]].');
  assert.equal(guides[2].body, 'See [the welcome](#welcome).');
});

test('parseGuide: reports a missing, malformed, reserved or duplicate id and skips that guide', () => {
  const md = ['# G', '## No id', '## Bad {#Bad_Id}', '## Reserved {#whats-new}', '## A {#a}', '## A again {#a}'].join('\n');
  const { guides, errors } = H.parseGuide(md);
  assert.deepEqual(guides.map((g) => g.id), ['a']);
  assert.deepEqual(errors.map((e) => e.line), [2, 3, 4, 6]);
  assert.match(errors[0].message, /no \{#id\}/);
  assert.match(errors[1].message, /kebab-case/);
  assert.match(errors[2].message, /reserved/);
  assert.match(errors[3].message, /duplicate/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test proxy/test/help-lib.test.js`
Expected: FAIL — `Cannot find module '…/web/help/help-lib.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `web/help/help-lib.js`:

```js
/* HelpLib — pure parse/render for the in-app help: web/help/guide.md (the
   guides) and web/help/whats-new.md. A plain browser script that attaches to
   globalThis (like web/roster-lib.js), so the app, the node tests
   (proxy/test/help-lib.test.js) and the guard (scripts/check-help.mjs) share
   ONE parser. No DOM, no I/O. The content format is documented at the top of
   guide.md; design: docs/superpowers/specs/2026-09-29-in-app-help-design.md. */
(function (root) {
  'use strict';
  const EMBEDS = ['legend'];        // {{name}} blocks the app knows how to draw
  const RESERVED = ['whats-new'];   // guide ids the drawer itself owns
  const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

  // Blank out <!-- … --> comments but keep their newlines, so line numbers hold.
  function stripComments(md) {
    return String(md == null ? '' : md).replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));
  }
  const linesOf = (md) => stripComments(md).split('\n');

  // "# Group" starts a group; "## Title {#id}" starts a guide. Lines are 1-based.
  // A guide with a missing/bad/reserved/duplicate id is reported and skipped.
  function parseGuide(md) {
    const guides = [], errors = [], seen = new Set();
    let group = '', cur = null;
    const close = () => {
      if (cur) { cur.body = cur.lines.join('\n').trim(); delete cur.lines; guides.push(cur); }
      cur = null;
    };
    linesOf(md).forEach((raw, i) => {
      const line = i + 1;
      let m = /^#\s+(.+?)\s*$/.exec(raw);
      if (m) { close(); group = m[1]; return; }
      m = /^##\s+(.+?)\s*$/.exec(raw);
      if (m) {
        close();
        const t = /^(.*?)\s*\{#([^}]*)\}$/.exec(m[1]);
        const title = (t ? t[1] : m[1]).trim(), id = t ? t[2].trim() : '';
        let err = '';
        if (!id) err = `guide "${title}" has no {#id}`;
        else if (!ID_RE.test(id)) err = `guide id "${id}" must be kebab-case (a-z, 0-9, -)`;
        else if (RESERVED.includes(id)) err = `guide id "${id}" is reserved`;
        else if (seen.has(id)) err = `duplicate guide id "${id}"`;
        if (err) { errors.push({ line, message: err }); return; }
        seen.add(id);
        cur = { id, title, group, line, lines: [] };
        return;
      }
      if (cur) cur.lines.push(raw);
    });
    close();
    return { guides, errors };
  }

  root.HelpLib = { EMBEDS, RESERVED, esc, stripComments, parseGuide };
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --test proxy/test/help-lib.test.js && node --check web/help/help-lib.js`
Expected: `# pass 2`, `# fail 0`; `node --check` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add web/help/help-lib.js proxy/test/help-lib.test.js
git commit -m "feat(help): HelpLib guide parser (groups, ids, line numbers)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: HelpLib — render a guide

**Files:**
- Modify: `web/help/help-lib.js` (add functions above the `root.HelpLib = …` line; replace that line)
- Test: `proxy/test/help-lib.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `proxy/test/help-lib.test.js`:

```js
test('renderGuide: paragraphs, steps, bullets, subheads and tips', () => {
  const html = H.renderGuide(['First line', 'continues.', '', '1. One', '2. Two', '', '- A', '- B', '', '### Sub', '> **Tip:** hi'].join('\n'));
  assert.equal(html, [
    '<p>First line continues.</p>',
    '<ol><li>One</li><li>Two</li></ol>',
    '<ul><li>A</li><li>B</li></ul>',
    '<h4>Sub</h4>',
    '<div class="help-tip"><strong>Tip:</strong> hi</div>',
  ].join('\n'));
});

test('renderGuide: chips, bold, italic and links', () => {
  const html = H.renderGuide('Click [[Propose]] **now** or *later*; see [lifecycle](#lifecycle), [site](https://x.org) and [mail](mailto:a@b.org).');
  assert.equal(html, '<p>Click <span class="uichip">Propose</span> <strong>now</strong> or <em>later</em>; see <a href="#" data-help-link="lifecycle">lifecycle</a>, <a href="https://x.org" target="_blank" rel="noopener">site</a> and <a href="mailto:a@b.org" target="_blank" rel="noopener">mail</a>.</p>');
});

test('renderGuide: escapes HTML and refuses other link schemes', () => {
  assert.equal(H.renderGuide('<b>x</b> & [[<i>]] [bad](javascript:void0)'), '<p>&lt;b&gt;x&lt;/b&gt; &amp; <span class="uichip">&lt;i&gt;</span> bad</p>');
});

test('renderGuide: {{embed}} on its own line calls opts.embed; none given → nothing', () => {
  const embed = (n) => `<div data-embed="${n}"></div>`;
  assert.equal(H.renderGuide('Key:\n\n{{legend}}\n\nEnd', { embed }), '<p>Key:</p>\n<div data-embed="legend"></div>\n<p>End</p>');
  assert.equal(H.renderGuide('{{legend}}'), '');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test proxy/test/help-lib.test.js`
Expected: FAIL — `H.renderGuide is not a function`.

- [ ] **Step 3: Implement**

In `web/help/help-lib.js`, insert above the line `  root.HelpLib = { EMBEDS, RESERVED, esc, stripComments, parseGuide };`:

```js
  // Inline markup: [[Label]] chip, **bold**, *italic*, [text](url). Everything
  // else is escaped. A fresh RegExp per call, so recursion can't share lastIndex.
  const INLINE = String.raw`\[\[([^\]\n]+)\]\]|\*\*([^*\n]+)\*\*|\*([^*\s][^*\n]*)\*|\[([^\]\n]+)\]\(([^)\s]+)\)`;
  function inline(text) {
    const s = String(text == null ? '' : text);
    let out = '', last = 0;
    for (const m of s.matchAll(new RegExp(INLINE, 'g'))) {
      out += esc(s.slice(last, m.index));
      if (m[1] !== undefined) out += `<span class="uichip">${esc(m[1].trim())}</span>`;
      else if (m[2] !== undefined) out += `<strong>${inline(m[2])}</strong>`;
      else if (m[3] !== undefined) out += `<em>${inline(m[3])}</em>`;
      else out += link(m[4], m[5]);
      last = m.index + m[0].length;
    }
    return out + esc(s.slice(last));
  }
  // #id → another guide (the drawer handles data-help-link clicks); http(s) and
  // mailto → new tab; any other scheme (javascript:, data:) renders as plain text.
  function link(label, url) {
    if (url.startsWith('#')) return `<a href="#" data-help-link="${esc(url.slice(1))}">${inline(label)}</a>`;
    if (/^(?:https?:|mailto:)/i.test(url)) return `<a href="${esc(url)}" target="_blank" rel="noopener">${inline(label)}</a>`;
    return inline(label);
  }

  // Block markup for one guide body: paragraphs, "### " subheads, "- " / "1. "
  // lists (one level), "> " tips, and {{embed}} on its own line (via opts.embed).
  function renderGuide(body, opts) {
    const embed = (opts && opts.embed) || (() => '');
    const out = [];
    let para = [], list = null, tip = null;
    const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); para = []; };
    const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((it) => `<li>${inline(it)}</li>`).join('')}</${list.tag}>`); list = null; };
    const flushTip = () => { if (tip) out.push(`<div class="help-tip">${inline(tip.join(' '))}</div>`); tip = null; };
    const flush = () => { flushPara(); flushList(); flushTip(); };
    for (const raw of stripComments(body).split('\n')) {
      const line = raw.trim();
      let m;
      if (!line) { flush(); continue; }
      if ((m = /^\{\{([a-z][a-z0-9-]*)\}\}$/.exec(line))) { flush(); out.push(embed(m[1]) || ''); continue; }
      if ((m = /^###\s+(.+)$/.exec(line))) { flush(); out.push(`<h4>${inline(m[1])}</h4>`); continue; }
      if ((m = /^>\s?(.*)$/.exec(line))) { flushPara(); flushList(); (tip = tip || []).push(m[1]); continue; }
      const item = /^-\s+(.+)$/.exec(line) || /^\d+\.\s+(.+)$/.exec(line);
      if (item) {
        const tag = line.startsWith('-') ? 'ul' : 'ol';
        flushPara(); flushTip();
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push(item[1]);
        continue;
      }
      if (list) { list.items[list.items.length - 1] += ' ' + line; continue; }   // wrapped list item
      flushTip();
      para.push(line);
    }
    flush();
    return out.join('\n');
  }

```

Then replace the export line with:

```js
  root.HelpLib = { EMBEDS, RESERVED, esc, stripComments, parseGuide, renderGuide, renderInline: inline };
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --test proxy/test/help-lib.test.js && node --check web/help/help-lib.js`
Expected: `# pass 6`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add web/help/help-lib.js proxy/test/help-lib.test.js
git commit -m "feat(help): HelpLib renderer — safe Markdown subset with [[chip]] labels" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: HelpLib — labels, links, embeds, What's new, search

**Files:**
- Modify: `web/help/help-lib.js`
- Test: `proxy/test/help-lib.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `proxy/test/help-lib.test.js`:

```js
test('uiLabels / guideLinks / embeds: report line numbers and ignore comments', () => {
  const md = ['<!-- [[Ghost]] [x](#ghost) {{ghost}} -->', 'Click [[Propose]] then [[ Approve ]].', 'See [x](#lifecycle).', '{{legend}}', 'Inline {{legend}} here'].join('\n');
  assert.deepEqual(H.uiLabels(md), [{ label: 'Propose', line: 2 }, { label: 'Approve', line: 2 }]);
  assert.deepEqual(H.guideLinks(md), [{ id: 'lifecycle', line: 3 }]);
  assert.deepEqual(H.embeds(md), [{ name: 'legend', line: 4, ownLine: true }, { name: 'legend', line: 5, ownLine: false }]);
});

test('parseWhatsNew: dated entries newest-first, with wrapped bullets', () => {
  const md = ["# What's new", '## 2026-09-29', '- **Help.** Click ?', '  for guides.', '## 2026-09-16', '- **Attendees.**'].join('\n');
  const { entries, errors } = H.parseWhatsNew(md);
  assert.deepEqual(errors, []);
  assert.deepEqual(entries.map((e) => [e.date, e.items]), [['2026-09-29', ['**Help.** Click ? for guides.']], ['2026-09-16', ['**Attendees.**']]]);
});

test('parseWhatsNew: flags a bad date, an empty entry and out-of-order dates', () => {
  const { errors } = H.parseWhatsNew(['## Sept 1', '- x', '## 2026-09-01', '## 2026-09-10', '- y'].join('\n'));
  assert.deepEqual(errors.map((e) => e.line), [1, 3, 4]);
  assert.match(errors[0].message, /must be a date/);
  assert.match(errors[1].message, /no bullet points/);
  assert.match(errors[2].message, /out of order/);
});

test('renderWhatsNew: formats dates and renders inline markup', () => {
  assert.equal(H.renderWhatsNew([{ date: '2026-09-19', items: ['**Moved.** See [[Details]].'] }]), '<h4>September 19, 2026</h4><ul><li><strong>Moved.</strong> See <span class="uichip">Details</span>.</li></ul>');
  assert.equal(H.renderWhatsNew([]), '<p class="help-empty">Nothing new yet.</p>');
  assert.equal(H.renderWhatsNew(null), '<p class="help-empty">Nothing new yet.</p>');
});

test('searchGuides: every word must appear in the title or body, case-insensitive', () => {
  const guides = [{ id: 'a', title: 'Add an event', body: 'Click [[+ New event]].' }, { id: 'b', title: 'Publish', body: 'Eventbrite listing' }];
  assert.deepEqual(H.searchGuides(guides, 'NEW event').map((g) => g.id), ['a']);
  assert.deepEqual(H.searchGuides(guides, 'eventbrite').map((g) => g.id), ['b']);
  assert.deepEqual(H.searchGuides(guides, '  '), []);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test proxy/test/help-lib.test.js`
Expected: FAIL — `H.uiLabels is not a function` (and the others).

- [ ] **Step 3: Implement**

In `web/help/help-lib.js`, insert above the `root.HelpLib = …` line:

```js
  // Every `re` match on each (comment-stripped) line, mapped with its 1-based line.
  function scan(md, re, map) {
    const out = [];
    linesOf(md).forEach((raw, i) => { for (const m of raw.matchAll(re)) out.push(map(m, i + 1, raw)); });
    return out;
  }
  const uiLabels = (md) => scan(md, /\[\[([^\]\n]+)\]\]/g, (m, line) => ({ label: m[1].trim(), line }));
  const guideLinks = (md) => scan(md, /\]\(#([^)\s]*)\)/g, (m, line) => ({ id: m[1], line }));
  const embeds = (md) => scan(md, /\{\{([^}\n]*)\}\}/g, (m, line, raw) => ({ name: m[1].trim(), line, ownLine: raw.trim() === m[0] }));

  // whats-new.md: "## YYYY-MM-DD" headings, newest first, each with "- " bullets.
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function parseWhatsNew(md) {
    const entries = [], errors = [];
    let cur = null;
    linesOf(md).forEach((raw, i) => {
      const line = i + 1, t = raw.trim();
      let m = /^##\s+(.+?)\s*$/.exec(raw);
      if (m) {
        if (!DATE_RE.test(m[1])) errors.push({ line, message: `heading "${m[1]}" must be a date like 2026-09-29` });
        cur = { date: m[1], line, items: [] };
        entries.push(cur);
        return;
      }
      m = /^-\s+(.+)$/.exec(t);
      if (m) {
        if (cur) cur.items.push(m[1]);
        else errors.push({ line, message: 'bullet before the first date heading' });
        return;
      }
      if (t && !t.startsWith('#') && cur && cur.items.length) cur.items[cur.items.length - 1] += ' ' + t;   // wrapped bullet
    });
    entries.forEach((e, k) => {
      if (!e.items.length) errors.push({ line: e.line, message: `${e.date} has no bullet points` });
      const prev = entries[k - 1];
      if (prev && DATE_RE.test(e.date) && DATE_RE.test(prev.date) && e.date >= prev.date) errors.push({ line: e.line, message: `${e.date} is out of order — newest first` });
    });
    return { entries, errors };
  }
  function fmtDate(d) {
    const p = DATE_RE.test(d) ? d.split('-').map(Number) : null;
    return p && MONTHS[p[1] - 1] ? `${MONTHS[p[1] - 1]} ${p[2]}, ${p[0]}` : String(d);
  }
  function renderWhatsNew(entries) {
    if (!entries || !entries.length) return '<p class="help-empty">Nothing new yet.</p>';
    return entries.map((e) => `<h4>${esc(fmtDate(e.date))}</h4><ul>${e.items.map((it) => `<li>${inline(it)}</li>`).join('')}</ul>`).join('');
  }

  // Search: every word must appear in the guide's title or body (case-insensitive).
  function searchGuides(guides, query) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return (guides || []).filter((g) => { const hay = `${g.title}\n${g.body}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
  }

```

Then replace the export line with the final one:

```js
  root.HelpLib = { EMBEDS, RESERVED, esc, stripComments, parseGuide, renderGuide, renderInline: inline, uiLabels, guideLinks, embeds, parseWhatsNew, renderWhatsNew, searchGuides };
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --test proxy/test/help-lib.test.js && node --check web/help/help-lib.js`
Expected: `# pass 11`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add web/help/help-lib.js proxy/test/help-lib.test.js
git commit -m "feat(help): HelpLib labels/links/embeds, What's new parse+render, search" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

> **Review follow-up (landed as commit `2b7e075`, after Tasks 1–3):** the code review's fixes changed HelpLib beyond the code above. `parseGuide` also reports an unclosed `[[` on a line, a heading with no space after `#`, a guide before the first `# Group`, an empty title and an unterminated `<!--`; `{{ legend }}` may have inner spaces; an `<ol>` keeps its first number (`start="N"`); `###` subheads and What's-new dates render as `<h3>`; `mailto:` links get no `target`. `proxy/test/help-lib.test.js` has 17 tests. The code in the repo is the source of truth.

---

### Task 4: Guard — pure helpers

**Files:**
- Create: `scripts/check-help.mjs`
- Test: `proxy/test/check-help.test.js`

- [ ] **Step 1: Write the failing tests**

Create `proxy/test/check-help.test.js`:

```js
// Pure helpers of the help guard (scripts/check-help.mjs). Its git plumbing,
// CLI and hook mode are exercised by hand (plan Tasks 5 and 10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isScreensFile, isHelpFile, normText, stripCodeComments, screenTexts,
  labelProblems, refProblems, mergeIntoMainTarget, prCreateBase, hasHelpNone, branchVerdict,
} from '../../scripts/check-help.mjs';

test('isScreensFile / isHelpFile', () => {
  assert.ok(isScreensFile('web/app.js'));
  assert.ok(isScreensFile('web/index.html'));
  assert.ok(isScreensFile('web/roster-lib.js'));
  assert.ok(!isScreensFile('web/styles.css'));
  assert.ok(!isScreensFile('web/help/help-lib.js'));
  assert.ok(!isScreensFile('web/embed-test/index.html'));
  assert.ok(!isScreensFile('gather/app.js'));
  assert.ok(isHelpFile('web/help/guide.md'));
  assert.ok(!isHelpFile('web/app.js'));
});

test('normText: decodes &amp;, drops icons/ellipses/dashes, collapses space', () => {
  assert.equal(normText('Refresh roles &amp; people'), 'Refresh roles & people');
  assert.equal(normText('Edit in Google Docs ↗'), 'Edit in Google Docs');
  assert.equal(normText('↻ Refresh'), 'Refresh');
  assert.equal(normText('Saving…'), 'Saving');
  assert.equal(normText('Save failed — retry'), 'Save failed retry');
  assert.equal(normText('+ New event'), '+ New event');
  assert.equal(normText('?'), '?');
  assert.equal(normText('↻'), '');
});

test('stripCodeComments: removes JS/HTML comments, keeps URLs and the line count', () => {
  const src = "a = 'https://x.org'; // Propose\n/* Approve\n */ b = 1;\n<!-- Delete -->";
  const out = stripCodeComments(src);
  assert.ok(out.includes("'https://x.org'"));
  assert.ok(!out.includes('Propose') && !out.includes('Approve') && !out.includes('Delete'));
  assert.equal(out.split('\n').length, src.split('\n').length);
});

test('screenTexts: text between tags and whole quoted strings count; comments do not', () => {
  const src = [
    'b.push(`<button data-act="propose">Propose</button>`);',
    "const S = [{ label:'Potluck & Volunteers' }];",
    "el.textContent = s==='saving' ? 'Saving…' : 'Saved';",
    '// Approve lives in the footer',
    '<a class="reflink" href="#">Open in Eventbrite ↗</a>',
  ].join('\n');
  const t = screenTexts([src]);
  for (const s of ['Propose', 'Potluck & Volunteers', 'Saving', 'Saved', 'Open in Eventbrite']) assert.ok(t.has(s), s);
  assert.ok(!t.has('Approve'));
});

test('labelProblems: labels missing from screen, and icon-only labels', () => {
  const guide = ['## A {#a}', 'Click [[Propose]], then [[Approve]].', 'Or [[↻]].'].join('\n');
  const probs = labelProblems(guide, [{ file: 'web/app.js', src: '<b>Propose</b> // Approve' }]);
  assert.equal(probs.length, 2);
  assert.match(probs[0], /guide\.md:2 \[\[Approve\]\] no longer appears on screen/);
  assert.match(probs[1], /guide\.md:3 \[\[↻\]\] has no words to check/);
});

test("refProblems: dead links, unknown embeds, bad app references, What's new errors", () => {
  const guide = ['# G', '## A {#a}', 'See [b](#b) and [news](#whats-new).', '{{legend}}', '{{chart}}'].join('\n');
  const news = ['## 2026-09-01', '- ok', '## 2026-09-10', '- out of order'].join('\n');
  const sources = [
    { file: 'web/app.js', src: "openHelp('a'); openHelp('zzz');\nconst S=[{ help:'nope' }];\n// openHelp('ignored')" },
    { file: 'web/index.html', src: '<button data-help="">?</button><a data-help="gone">x</a>' },
  ];
  assert.deepEqual(refProblems(guide, news, sources), [
    'web/help/guide.md:3 link to #b — no guide has that id',
    'web/help/guide.md:5 unknown embed {{chart}} (known: legend)',
    'web/app.js:1 help link "zzz" — no guide has that id',
    'web/app.js:2 help link "nope" — no guide has that id',
    'web/index.html:1 help link "gone" — no guide has that id',
    'web/help/whats-new.md:3 2026-09-10 is out of order — newest first',
  ]);
  assert.deepEqual(refProblems(null, news, sources), ['web/help/guide.md is missing']);
});

test('mergeIntoMainTarget: only merges into main; skips options and their values', () => {
  assert.equal(mergeIntoMainTarget('git merge feat/x', 'main'), 'feat/x');
  assert.equal(mergeIntoMainTarget('git merge feat/x', 'feat/y'), null);
  assert.equal(mergeIntoMainTarget('git checkout main && git merge --no-ff feat/x -m "Merge: x"', 'feat/x'), 'feat/x');
  assert.equal(mergeIntoMainTarget('git switch main; git merge -m "Merge: x" --no-ff feat/x', 'feat/x'), 'feat/x');
  assert.equal(mergeIntoMainTarget("git merge --no-ff -q feat/x -m \"$(cat <<'EOF'\nMerge: x\n\nBody\nEOF\n)\"", 'main'), 'feat/x');
  assert.equal(mergeIntoMainTarget('git merge --abort', 'main'), null);
  assert.equal(mergeIntoMainTarget('git log --grep "git merge feat/x"', 'main'), null);
  assert.equal(mergeIntoMainTarget('git merge main', 'feat/x'), null);
});

test('prCreateBase: null unless the command runs gh pr create; base defaults to main', () => {
  assert.equal(prCreateBase('gh pr list'), null);
  assert.equal(prCreateBase('gh pr create --fill'), 'main');
  assert.equal(prCreateBase('git push -u origin HEAD && gh pr create --base develop --title x'), 'develop');
  assert.equal(prCreateBase('gh pr create -B release'), 'release');
  assert.equal(prCreateBase('gh pr create --base=staging'), 'staging');
});

test('hasHelpNone: needs "Help: none" plus a reason', () => {
  assert.ok(hasHelpNone('fix: x\n\nHelp: none — internal refactor'));
  assert.ok(hasHelpNone('help: none - typo'));
  assert.ok(hasHelpNone('Help: none: css only'));
  assert.ok(!hasHelpNone('Help: none'));
  assert.ok(!hasHelpNone('Help: none —   '));
  assert.ok(!hasHelpNone('Help: none —\nCo-Authored-By: x'));
  assert.ok(!hasHelpNone('Helpful: none - x'));
});

test('branchVerdict: screens changed without help → a problem, unless help changed or Help: none', () => {
  assert.match(branchVerdict(['web/app.js', 'web/styles.css'], 'feat: x'), /changes the app's screens \(web\/app\.js\) but not web\/help\//);
  assert.equal(branchVerdict(['web/app.js', 'web/help/guide.md'], 'feat: x'), null);
  assert.equal(branchVerdict(['web/app.js'], 'refactor\n\nHelp: none — no visible change'), null);
  assert.equal(branchVerdict(['proxy/src/worker.js', 'web/styles.css'], 'feat: y'), null);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test proxy/test/check-help.test.js`
Expected: FAIL — `Cannot find module '…/scripts/check-help.mjs'`.

- [ ] **Step 3: Implement the pure helpers**

Create `scripts/check-help.mjs` (Task 5 appends the git plumbing and entry points):

```js
#!/usr/bin/env node
// Help guard — keeps the in-app help (web/help/) in step with the app.
// Design: docs/superpowers/specs/2026-09-29-in-app-help-design.md (§7–8).
//
//   node scripts/check-help.mjs                               content checks (working tree)
//   node scripts/check-help.mjs --branch <ref> [--base main]  + branch check, reading <ref>'s commits
//   node scripts/check-help.mjs --hook                        Claude Code PreToolUse hook (stdin = tool-call JSON)
//
// Content: every [[label]] in guide.md still appears on screen; guide ids, links
// and embeds are valid; the app's openHelp('id') / help:'id' / data-help="id"
// name real guides; whats-new.md is dated, newest first.
// Branch: a branch that changes the screens (top-level web/*.js|html) must also
// change web/help/ — or carry a commit-message line "Help: none — <reason>".
// Exit codes — CLI: 0 ok, 1 problems/error. Hook: 0 allow, 2 block, 1 guard error (never blocks).
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import '../web/help/help-lib.js';

const H = globalThis.HelpLib;

/* ---- pure helpers (unit-tested in proxy/test/check-help.test.js) ---------- */
export const isScreensFile = (p) => /^web\/[^/]+\.(?:js|html)$/.test(p);
export const isHelpFile = (p) => p.startsWith('web/help/');

// On-screen text, normalized for comparison: decode the entities we use, drop
// icons/arrows/ellipses/dashes, collapse whitespace.
export function normText(s) {
  return String(s == null ? '' : s)
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#?\w+;/g, ' ')
    .replace(/[^\p{L}\p{N} +&'’/.,?!:()-]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Blank out HTML comments and JS block/line comments, keeping newlines so line
// numbers survive. `//` starts a comment only at line start or after whitespace
// or punctuation — never after `:` — so 'https://…' strings survive.
export function stripCodeComments(src) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return String(src == null ? '' : src)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[\s;{}(),])\/\/[^\n]*/g, '$1');
}

// Candidate on-screen text in the screens code: text between tags (>Label<)
// and whole string literals ('…', "…", and `…` without ${}).
export function screenTexts(sources) {
  const out = new Set();
  const add = (t) => { const n = normText(t); if (n) out.add(n); };
  for (const src of sources) {
    const s = stripCodeComments(src);
    for (const m of s.matchAll(/>([^<>]*)</g)) add(m[1]);
    for (const m of s.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\$]*)`/g)) add(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

export function labelProblems(guideMd, sources) {
  const texts = screenTexts(sources.map((s) => s.src));
  const out = [];
  for (const { label, line } of H.uiLabels(guideMd)) {
    const n = normText(label);
    if (!n) out.push(`web/help/guide.md:${line} [[${label}]] has no words to check — write it in **bold** instead`);
    else if (!texts.has(n)) out.push(`web/help/guide.md:${line} [[${label}]] no longer appears on screen — update the guide to match the app`);
  }
  return out;
}

const APP_REF_RES = [/openHelp\(\s*['"]([^'"]*)['"]/g, /\bhelp\s*:\s*['"]([^'"]*)['"]/g, /data-help="([^"]*)"/g];
const lineAt = (s, i) => s.slice(0, i).split('\n').length;

export function refProblems(guideMd, newsMd, sources) {
  if (guideMd == null) return ['web/help/guide.md is missing'];
  const out = [];
  const { guides, errors } = H.parseGuide(guideMd);
  for (const e of errors) out.push(`web/help/guide.md:${e.line} ${e.message}`);
  const ids = new Set([...guides.map((g) => g.id), ...H.RESERVED]);
  for (const l of H.guideLinks(guideMd)) if (!ids.has(l.id)) out.push(`web/help/guide.md:${l.line} link to #${l.id} — no guide has that id`);
  for (const e of H.embeds(guideMd)) {
    if (!H.EMBEDS.includes(e.name)) out.push(`web/help/guide.md:${e.line} unknown embed {{${e.name}}} (known: ${H.EMBEDS.join(', ')})`);
    else if (!e.ownLine) out.push(`web/help/guide.md:${e.line} {{${e.name}}} must be on a line of its own`);
  }
  for (const { file, src } of sources) {
    const code = stripCodeComments(src);
    for (const re of APP_REF_RES) {
      for (const m of code.matchAll(re)) {
        if (m[1] && !ids.has(m[1])) out.push(`${file}:${lineAt(code, m.index)} help link "${m[1]}" — no guide has that id`);
      }
    }
  }
  if (newsMd == null) out.push('web/help/whats-new.md is missing');
  else for (const e of H.parseWhatsNew(newsMd).errors) out.push(`web/help/whats-new.md:${e.line} ${e.message}`);
  return out;
}

const CMD = String.raw`(?:^|&&|\|\||;|\||\(|\n)\s*`;   // a command position in a shell line
const MERGE_RE = new RegExp(CMD + String.raw`git\s+merge\b`);
const TO_MAIN_RE = new RegExp(CMD + String.raw`git\s+(?:checkout|switch)\s+main\b`);
const PR_RE = new RegExp(CMD + String.raw`gh\s+pr\s+create\b`);
const SEPARATORS = new Set(['&&', '||', ';', '|']);
const VALUE_OPTS = new Set(['-m', '--message', '-F', '--file', '-s', '--strategy', '-X', '--strategy-option', '--cleanup', '--into-name']);

// Quote-aware shell words ("…" may span lines, e.g. a heredoc commit message).
function shellWords(s) {
  return [...s.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(&&|\|\||[;|])|([^\s;|&"']+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
}

// The branch a command merges INTO main — when main is checked out, or when the
// same command switches to it first (`git checkout main && git merge <ref>`).
export function mergeIntoMainTarget(command, currentBranch) {
  const cmd = String(command || '');
  const m = MERGE_RE.exec(cmd);
  if (!m) return null;
  const end = m.index + m[0].length;
  if (currentBranch !== 'main' && !TO_MAIN_RE.test(cmd.slice(0, end))) return null;
  const words = shellWords(cmd.slice(end));
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (SEPARATORS.has(w)) break;
    if (['--abort', '--continue', '--quit', '--skip'].includes(w)) return null;
    if (VALUE_OPTS.has(w)) { i++; continue; }
    if (w.startsWith('-')) continue;
    return w;
  }
  return null;
}

// The base of a `gh pr create` (default main), or null when the command doesn't create a PR.
export function prCreateBase(command) {
  const cmd = String(command || '');
  const m = PR_RE.exec(cmd);
  if (!m) return null;
  const words = shellWords(cmd.slice(m.index + m[0].length));
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (SEPARATORS.has(w)) break;
    if (w === '--base' || w === '-B') return words[i + 1] || 'main';
    if (w.startsWith('--base=')) return w.slice(7) || 'main';
  }
  return 'main';
}

export const hasHelpNone = (messages) => /^[ \t]*help:[ \t]*none[ \t]*[—–:-]+[ \t]*\S/im.test(String(messages || ''));

export function branchVerdict(files, messages) {
  const screens = files.filter(isScreensFile);
  if (!screens.length || files.some(isHelpFile) || hasHelpNone(messages)) return null;
  return `this branch changes the app's screens (${screens.join(', ')}) but not web/help/`;
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --test proxy/test/check-help.test.js`
Expected: `# pass 10`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-help.mjs proxy/test/check-help.test.js
git commit -m "feat(help): guard helpers — on-screen label check, link/id checks, merge/PR parsing" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Guard — git plumbing, CLI and hook mode

**Files:**
- Modify: `scripts/check-help.mjs` (append at the end)

- [ ] **Step 1: Append the plumbing and entry points**

Append to the end of `scripts/check-help.mjs`:

```js

/* ---- git plumbing + entry points ------------------------------------------ */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let CWD = ROOT;   // repo toplevel the git commands run in (hook mode: the session's cwd)
const git = (args) => execFileSync('git', args, { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

function readAt(ref, path) {   // a file from <ref>'s commit, or from the working tree when ref is empty
  try { return ref ? git(['show', `${ref}:${path}`]) : readFileSync(join(CWD, path), 'utf8'); } catch { return null; }
}
function screensSourcesAt(ref) {
  const names = ref ? git(['ls-tree', '--name-only', ref, 'web/']).split('\n') : readdirSync(join(CWD, 'web')).map((f) => `web/${f}`);
  return names.filter(isScreensFile).map((file) => ({ file, src: readAt(ref, file) || '' }));
}
function contentProblems(ref) {
  const sources = screensSourcesAt(ref);
  const guideMd = readAt(ref, 'web/help/guide.md');
  const newsMd = readAt(ref, 'web/help/whats-new.md');
  return [...refProblems(guideMd, newsMd, sources), ...(guideMd == null ? [] : labelProblems(guideMd, sources))];
}
function existingRef(name) {   // `main`, else `origin/main` (a fresh clone may only have the remote one)
  for (const cand of [name, `origin/${name}`]) {
    try { git(['rev-parse', '--verify', '--quiet', `${cand}^{commit}`]); return cand; } catch { /* try the next */ }
  }
  return name;
}
function branchProblems(base, ref) {
  const b = existingRef(base);
  const files = git(['diff', '--name-only', `${b}...${ref}`]).split('\n').filter(Boolean);
  const verdict = branchVerdict(files, git(['log', '--format=%B', `${b}..${ref}`]));
  return verdict ? [`${verdict} (${ref} vs ${b})`] : [];
}

const FIX = 'Fix: update web/help/guide.md (and add a dated line to web/help/whats-new.md). If a program lead would notice nothing, add a commit whose message has a line "Help: none — <reason>" instead. Rules: CLAUDE.md → Conventions → "Help ships with the change".';
const listOf = (problems) => problems.map((p) => `  - ${p}`).join('\n');

function cli(args) {
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const ref = opt('--branch'), base = opt('--base') || 'main';
  try {
    const problems = [...contentProblems(ref), ...(ref ? branchProblems(base, ref) : [])];
    if (!problems.length) { console.log(`check-help: OK${ref ? ` (${ref} vs ${base})` : ''}`); return 0; }
    console.error(`check-help: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n${listOf(problems)}\n${FIX}`);
    return 1;
  } catch (err) {
    console.error(`check-help: could not run — ${err.message}`);
    return 1;
  }
}

async function hook() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { return 0; }
  const command = (input.tool_input && input.tool_input.command) || '';
  if (input.tool_name !== 'Bash' || !/\bgit\s+merge\b|\bgh\s+pr\s+create\b/.test(command)) return 0;   // fast path: not ours
  try {
    CWD = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: input.cwd || process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const mergeRef = mergeIntoMainTarget(command, git(['rev-parse', '--abbrev-ref', 'HEAD']).trim());
    const prBase = mergeRef ? null : prCreateBase(command);
    if (!mergeRef && !prBase) return 0;
    const [ref, base] = mergeRef ? [mergeRef, 'main'] : ['HEAD', prBase];
    const problems = [...contentProblems(ref), ...branchProblems(base, ref)];
    if (!problems.length) return 0;
    process.stderr.write(`Help guard blocked this ${mergeRef ? `merge of ${ref} into main` : 'pull request'} — the in-app help is out of step with the app:\n${listOf(problems)}\n${FIX}\nThen run the command again.\n`);
    return 2;
  } catch (err) {
    process.stderr.write(`check-help hook skipped (guard error, not blocking): ${err.message}\n`);
    return 1;
  }
}

// Run only when executed directly (the unit tests import the helpers above).
// process.exitCode (not process.exit) so stderr to a pipe is flushed first.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  process.exitCode = args.includes('--hook') ? await hook() : cli(args);
}
```

- [ ] **Step 2: Content check against the repo — expect "guide.md is missing"**

Run: `node scripts/check-help.mjs; echo "exit=$?"`
Expected (stderr), exit 1:
```
check-help: 1 problem
  - web/help/guide.md is missing
Fix: update web/help/guide.md …
exit=1
```

- [ ] **Step 3: Hook mode ignores unrelated commands**

Run: `printf '%s' '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}' | node scripts/check-help.mjs --hook; echo "exit=$?"`
Expected: no output, `exit=0`.

- [ ] **Step 4: Hook mode ignores a merge that isn't into main**

Run: `printf '%s' "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"git merge feat/x\"},\"cwd\":\"$PWD\"}" | node scripts/check-help.mjs --hook; echo "exit=$?"`
Expected: no output, `exit=0` (the current branch is `feat/help-guide`, not `main`).

- [ ] **Step 5: Hook mode blocks a PR whose help is broken**

Run: `printf '%s' "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"gh pr create --fill\"},\"cwd\":\"$PWD\"}" | node scripts/check-help.mjs --hook; echo "exit=$?"`
Expected (stderr): `Help guard blocked this pull request — the in-app help is out of step with the app:` then `  - web/help/guide.md is missing`, the Fix line, and `exit=2`.

- [ ] **Step 6: Unit tests still pass**

Run: `node --test proxy/test/check-help.test.js`
Expected: `# pass 10`, `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add scripts/check-help.mjs
git commit -m "feat(help): guard CLI + PreToolUse hook mode (content + branch checks)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The content — guides and What's new

**Files:**
- Create: `web/help/guide.md`
- Create: `web/help/whats-new.md`

- [ ] **Step 1: Write `web/help/guide.md`**

Create `web/help/guide.md` with exactly this content:

```markdown
<!--
  EST Planning Calendar — help guides, shown in the app's Help drawer (the ? button).
  Parsed by web/help/help-lib.js and checked by scripts/check-help.mjs.

  WRITING GUIDE — you're writing for a program lead who isn't technical:
  - Say "you". Short sentences. Task-first titles ("Add an event or idea").
  - Numbered steps for anything with more than one action.
  - Put on-screen text in [[double brackets]] — it renders as a button-shaped chip,
    and the guard checks that the exact text still appears in the app. Only bracket
    text that is visibly on screen (not tooltips, not counts or names).
  - Refer to things by name, not by position or color.
  - Keep each paragraph, list item and [[Label]] on one line (don't hard-wrap),
    don't start a line with # unless it's a heading, and don't nest **bold**
    and *italic*.
  - No internal names: Coda, Superhuman Docs, Worker, proxy, row, sync, API.
  - Say who can do role-limited things ("Tribal Council only").
  - About 150 words per guide. Link instead of repeating: [text](#guide-id).
  - These files are public: no member names, emails or private links.

  FORMAT — "# Group" starts a group. "## Title {#id}" starts a guide; ids are
  permanent (they're in shared links). Inside a guide: paragraphs, "### Subhead",
  "- " bullets, "1. " steps, **bold**, *italic*, [text](https://…), [text](#id),
  "> " tip callouts, and {{legend}} (the live color/status key) on its own line.
-->

# Getting started

## Welcome to the Planning Calendar {#welcome}

This is where East Side Tribe leaders plan the whole program year together, before anything goes public.

Every event follows the same path:

1. Add it with [[+ New event]]. It starts as a **Draft**, a working plan. It can be just an idea, without a date.
2. When it's ready, open it and click [[Propose]].
3. Tribal Council reviews it and clicks [[Approve]].
4. Tribal Council publishes it to Eventbrite, and members can register.

**Who can do what**

- Anyone who signs in can look at the calendar.
- **Program Leads** add and edit events, propose them, set up potluck and volunteer sign-ups, and see who's coming.
- **Tribal Council** also approves, publishes, reopens and deletes events.

To check your role, click your picture or initials at the top of the page.

> **Tip:** Click [[?]] at the top anytime to come back to these guides. Inside an event, its [[?]] opens the guide for the tab you're on.

## Get around the calendar {#getting-around}

The calendar shows one **program year**, September through August. Use the arrows beside the year (like '26–'27) to move between years.

There are two views:

- [[Overview]]: the whole year at a glance. Each week is split into weeknights (Monday–Thursday) and weekends (Friday–Sunday). Ideas without a firm date sit at the bottom of their month, under **date TBD**.
- [[Calendar]]: a full grid for each month. Ideas without a firm date sit in the [[Ideas]] column.

**Layers.** Turn calendars on and off with the layer buttons: your planning events, plus reference calendars such as Jewish holidays and partner organizations. Reference events are read-only.

On a phone, the year arrows and the layers are in the **⋯** menu.

Click any event to open it. The calendar refreshes itself every minute; click **↻** to refresh right away.

## Read the calendar {#reading-the-calendar}

**Color** shows the program. **Style** shows where an event is in its life:

{{legend}}

A few more things you'll see:

- In Calendar view, a time before a title is the start time.
- **+1** (or +2…) after a title means the event belongs to more than one program.
- A range like **12–18** means "sometime in that window": the event isn't pinned to a day yet.
- Inside an open event, a **Live** badge means it's published on Eventbrite, and **Past** means its date has gone by.

# Planning an event

## Add an event or idea {#add-event}

Program Leads and Tribal Council can add events.

1. Click [[+ New event]], or click an empty spot on the calendar: a day in Calendar view, or a weeknight or weekend lane in Overview. In Calendar view, the **＋** in a month's [[Ideas]] column adds an idea with no firm date.
2. Give it a [[Title]].
3. Under **When**, pick [[Exact date]], [[Date range]] (sometime in a window) or [[Whole month]].
4. Add what you know: [[Program(s)]], [[Leads]], and under **Where**, a venue. Picking a program adds its leads for you. If a venue isn't listed, type its name and choose **＋ New venue**.
5. Click [[Create]].

The event opens in full as a **Draft**. Nothing is public yet, so keep adding details whenever you like.

> **Tip:** Not sure of the date? Choose [[Whole month]] and pin it to a day later.

## Edit an event {#edit-details}

Click an event to open it. It has these tabs:

- [[Details]]: the plan itself. Title, internal description, programs, leads, when and where. The **Public listing** below it unlocks once the event is approved; see [Publish to Eventbrite](#publish).
- [[Planning Notes]]: a Google Doc for your team's notes.
- [[Potluck & Volunteers]]: sign-up slots for members.
- [[Attendees]]: who's coming.

**Changes save by themselves** when you move out of a field. A small label shows [[Saved]], [[Saving…]] or [[Unsaved changes]]. If it says [[Save failed — retry]], click it to try again.

Close the event with **×** or the Esc key. Your last change is saved on the way out.

Once an event is approved, only Tribal Council can change its details. See [From draft to approved](#lifecycle).

## From draft to approved {#lifecycle}

Every event has a status, and the buttons in an open event change with it:

- **Draft**: being planned. Click [[Propose]] when it's ready for Tribal Council.
- **Proposed**: waiting for review. Tribal Council clicks [[Approve]].
- **Approved** 🔒: confirmed. Program Leads can no longer change the details; Tribal Council still can. Next: [Publish to Eventbrite](#publish).
- **Live**: approved and published on Eventbrite.
- **Cancelled**: not happening. Tribal Council can click [[Reopen]] to make it a Draft again.

**To cancel an event**, click [[Cancel event]]. If it's on Eventbrite, the listing comes down too.

Only Tribal Council sees [[Delete]], which removes an event completely. Program Leads cancel instead.

> **Tip:** Click the status label at the top of an open event to come back to this guide.

## Planning notes {#planning-notes}

Each event can have its own Google Doc for internal notes: agenda, to-dos, contacts. It's never shown publicly.

1. Open the event and go to [[Planning Notes]].
2. Click [[Create notes doc]]. The doc is made from our planning template, which can take up to a minute.
3. When it's ready, a preview appears. Click [[Edit in Google Docs]] to write in it.

The preview only shows if you're signed into Google with access to the doc. Program Leads can create a notes doc until the event is approved.

## Potluck & volunteer sign-ups {#signups}

Ask members to bring a dish or take a volunteer shift. They sign up in **gather**, East Side Tribe's member app.

1. Open the event and go to [[Potluck & Volunteers]].
2. Under **Potluck** or **Volunteer**, type a dish or a role, add how many you need (leave it blank for no limit), and click [[Add]].
3. Use the arrows to reorder slots, or **×** to remove one.

To sign someone up yourself, click [[+ Add sign-up]] under a slot.

**When members see them:** slots show up in gather once the event is published. After approval, Program Leads and Tribal Council can preview them there. The **View in gather** icon at the top of an open event takes you straight there.

# After approval

## Publish to Eventbrite {#publish}

Once an event is approved, Tribal Council publishes it. Program Leads can see the listing but not change it; ask Tribal Council for edits.

1. Open the event. In [[Details]], go down to **Public listing**.
2. Fill in [[Public summary]] (one line), [[Public description]] (or click [[Copy from internal]]), [[Capacity]], and [[Address on listing]]: [[Public]] or [[Registrants only]].
3. Click [[Create Eventbrite draft]], then [[Open in Eventbrite]] to check how it looks.
4. Click [[Publish]]. The event is now **Live**, and members can register.

**To change a live listing,** edit the fields, then click [[Update published event]] when it appears. For a draft, click [[Update draft]]. If someone changed the listing directly on Eventbrite, you'll be asked before your version replaces theirs.

Cancelling an event takes its listing down.

## See who's coming {#attendees}

Program Leads and Tribal Council can open [[Attendees]] in any event. It lists everyone who registered on Eventbrite, plus anyone who signed up for a potluck or volunteer slot.

- Narrow the list with the filters, such as [[Registered]], [[Signed up, not registered]] or [[Members]]. Each sign-up slot gets a filter too.
- **Member** marks an active member. **Not registered** means someone signed up for a slot but hasn't registered on Eventbrite.
- Click [[Refresh]] for the latest registrations.

**To email people:**

1. Check the boxes for the people you want, or the box at the top of the list for everyone in the filter.
2. Click [[Email]] to open your own email app with them in BCC, or [[Copy emails]] to paste the addresses anywhere.

The app never sends email itself. It comes from your own account.

## Share a link {#share-link}

**To an event:** open it and click its link icon (it says *Copy link* when you point at it). The link opens that event, on the same tab, for anyone who's signed in.

**To a guide:** open the guide and copy the address from your browser's address bar. It opens straight to that guide, even for someone who hasn't signed in yet. It's handy for welcoming a new lead.

# Help

## Common problems {#troubleshooting}

**I can't sign in.** Try [[Continue with Google]]. If you use [[Email me a link]], open the email on the same device, and check your spam or junk folder.

**I can see the calendar but can't add or edit.** Your account needs the Program Lead role. Click your picture or initials to see your role, then ask Tribal Council to add you. Reload the page once they have.

**Tribal Council:** after giving someone a role, click [[Refresh roles & people]] in your account menu so it takes effect right away.

**I can't find an event.** Check the program year, make sure its layer is on, and click **↻** to refresh. Undated ideas sit under **date TBD** (Overview) or in the [[Ideas]] column (Calendar).

**My change didn't stick.** Look for [[Saved]] in the open event. If it says [[Save failed — retry]], click it.

**Everything is grayed out.** The event is approved (only Tribal Council can edit it) or cancelled (Tribal Council can reopen it).

## Suggest an improvement {#feedback}

Something confusing, or an idea that would help? Tell us.

1. Click [[Feedback / Ideas]] at the top of the page.
2. Type your idea and click [[Submit]], or click **▲** to add your vote to someone else's.

Each idea shows where it stands: **New**, **Planned**, **Shipped** or **Declined**.

The *coming soon* tabs inside an event have their own idea boards. Tell us what you'd want there.
```

- [ ] **Step 2: Write `web/help/whats-new.md`**

Create `web/help/whats-new.md` with exactly this content:

```markdown
<!--
  What's new — plain-language notes for program leads, newest first.
  Format: "## YYYY-MM-DD", then "- **Short headline.** One or two plain sentences."
  Add an entry in the same branch as any change a lead would notice.
  Not label-checked: history may name things that no longer exist.
-->

## 2026-09-29
- **New: Help.** Click **?** at the top for step-by-step guides. Inside an event, **?** opens the guide for the tab you're on.

## 2026-09-19
- **Publishing moved into Details.** The Eventbrite listing (public summary, description, capacity) now sits at the bottom of an event's **Details** tab, under **Public listing**. The separate Publish tab is gone.
- **Better on phones.** Events open full-screen, and the Attendees list fits a small screen.

## 2026-09-16
- **New: Attendees tab.** See who registered and who signed up for a slot, filter the list, and email everyone from your own account.
```

- [ ] **Step 3: Run the guard — expect only the two `[[?]]` problems**

Run: `node scripts/check-help.mjs; echo "exit=$?"`
Expected: exactly 2 problems, both `web/help/guide.md:<the Welcome tip line> [[?]] no longer appears on screen …`, and `exit=1`. The `?` button arrives in Task 7. If ANY other label is reported, open `web/app.js` / `web/index.html` / `web/roster-lib.js`, find the real on-screen text, and correct the **guide** to match it exactly. Re-run until only the two `[[?]]` lines remain.

- [ ] **Step 4: Commit**

```bash
git add web/help/guide.md web/help/whats-new.md
git commit -m "feat(help): lead-facing guides (13) + What's new" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Drawer shell — markup, styles, retire the Legend & key modal

**Files:**
- Modify: `web/index.html`
- Modify: `web/styles.css`
- Modify: `web/app.js` (delete `legendHTML`, `openInfo` and the `infoBtn` listener)

- [ ] **Step 1: `web/index.html` — drop the "i", fix the tagline**

Replace:
```html
      <div class="brandline">
        <h1>Programming — Planning Calendar</h1>
        <button class="info-btn" id="infoBtn" title="Legend & key" aria-label="Legend and key">i</button>
      </div>
      <span class="sub sub-full">East Side Tribe · draft events, no eventbrite/gCal required</span>
```
with:
```html
      <div class="brandline">
        <h1>Programming — Planning Calendar</h1>
      </div>
      <span class="sub sub-full">East Side Tribe · plan the year's programming together</span>
```

- [ ] **Step 2: `web/index.html` — add the `?` button**

Replace:
```html
    <button class="btn ghost" id="feedbackBtn">Feedback / Ideas</button>
```
with:
```html
    <button class="btn ghost" id="feedbackBtn">Feedback / Ideas</button>
    <button class="help-btn" id="helpBtn" type="button" data-help="" aria-label="Help" title="Help">?</button>
```

- [ ] **Step 3: `web/index.html` — sign-in screen link**

Replace:
```html
    <div class="gate-busy" id="gateBusy"><span class="ndoc-spin"></span> One moment…</div>
```
with:
```html
    <div class="gate-busy" id="gateBusy"><span class="ndoc-spin"></span> One moment…</div>
    <p class="gate-help"><a href="#" data-help="welcome">New here? See how it works</a></p>
```

- [ ] **Step 4: `web/index.html` — drawer markup after the modal**

Replace:
```html
    <div class="mfoot" id="mFoot"></div>
  </div>
</div>
```
with:
```html
    <div class="mfoot" id="mFoot"></div>
  </div>
</div>

<!-- ---- help drawer: guides from help/guide.md, rendered by help/help-lib.js ---- -->
<aside class="help-drawer" id="helpDrawer" role="dialog" aria-modal="false" aria-labelledby="helpTitle" tabindex="-1" hidden>
  <div class="help-head">
    <button class="help-back" id="helpBack" type="button" hidden>← All guides</button>
    <h2 class="help-title" id="helpTitle">Help</h2>
    <button class="mhead-close" id="helpClose" type="button" aria-label="Close help" title="Close">×</button>
  </div>
  <div class="help-body" id="helpBody"></div>
  <div class="help-foot">Still stuck? <a href="mailto:eastsidetribenashville@gmail.com">Email us</a></div>
</aside>
```

- [ ] **Step 5: `web/index.html` — load help-lib before app.js**

Replace:
```html
<script src="roster-lib.js"></script>
```
with:
```html
<script src="roster-lib.js"></script>
<script src="help/help-lib.js"></script>
```

- [ ] **Step 6: `web/styles.css` — `.help-btn` replaces `.info-btn`**

Replace:
```css
  .info-btn{
    width:24px;height:24px;flex:0 0 auto;border-radius:50%;border:1px solid var(--hair-strong);
    background:var(--surface);color:var(--muted);font-family:Fraunces,serif;font-style:italic;font-weight:600;
    font-size:13px;line-height:1;cursor:pointer;transition:.12s;
  }
  .info-btn:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-tint)}
```
with:
```css
  .help-btn{
    position:relative;width:28px;height:28px;flex:0 0 auto;padding:0;border-radius:50%;border:1px solid var(--hair-strong);
    background:var(--surface);color:var(--muted);font:inherit;font-size:14px;font-weight:600;line-height:1;cursor:pointer;transition:.12s;
    display:inline-flex;align-items:center;justify-content:center;
  }
  .help-btn:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-tint)}
  .help-btn.has-news::after{content:"";position:absolute;top:-1px;right:-1px;width:8px;height:8px;border-radius:50%;background:var(--today);border:2px solid var(--paper)}
```

And in the mobile header block, replace:
```css
    .info-btn{width:22px;height:22px;font-size:12px}
```
with:
```css
    .help-btn{width:26px;height:26px;font-size:13px}
```

- [ ] **Step 7: `web/styles.css` — delete the dead legend-modal CSS**

Delete these lines (they only styled `legendHTML()`); keep `.legend` and `.k`, which the Overview footer still uses:
```css
  .infogrid{display:flex;flex-wrap:wrap;gap:6px 14px}
```
```css
  .k .sw{width:22px;height:12px;border-radius:3px;flex:0 0 auto}
  .sw.i{border:1px dashed var(--faint)}
  .sw.d{border:1px dashed var(--faint);background:#EDEDED}
  .sw.c{border:1px solid #bbb;background:#DDD}
  .sw.a{background:var(--faint)}
```

- [ ] **Step 8: `web/styles.css` — drawer styles**

Insert immediately before the line `  @media (prefers-color-scheme:dark){`:

```css
  /* ---- help drawer (web/help/: guide.md + whats-new.md, rendered by HelpLib) ---- */
  :root{--help-w:400px}
  .help-drawer{position:fixed;top:0;right:0;bottom:0;width:min(var(--help-w),100vw);z-index:70;background:var(--surface);border-left:1px solid var(--hair-strong);box-shadow:var(--shadow);display:flex;flex-direction:column}
  .help-drawer[hidden]{display:none}
  .help-drawer:focus{outline:none}
  .help-head{display:flex;align-items:center;gap:8px;padding:14px 14px 12px 18px;border-bottom:1px solid var(--hair);flex-shrink:0}
  .help-title{flex:1;min-width:0;margin:0;font-family:Fraunces,serif;font-weight:600;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .help-back{flex:0 0 auto;border:0;background:transparent;color:var(--accent);font:inherit;font-size:12px;font-weight:600;padding:4px 6px;border-radius:6px;cursor:pointer;white-space:nowrap}
  .help-back:hover{background:var(--accent-tint)}
  .help-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:14px 18px 18px}
  .help-foot{flex-shrink:0;padding:10px 18px calc(12px + env(safe-area-inset-bottom));border-top:1px solid var(--hair);font-size:12px;color:var(--muted)}
  .help-foot a,.help-article a,.help-empty a{color:var(--accent);font-weight:600}
  .help-search{width:100%;font:inherit;font-size:13px;padding:8px 10px;margin:0 0 6px;border:1px solid var(--hair-strong);border-radius:8px;background:var(--surface);color:var(--ink)}
  .help-grouph{margin:14px 0 2px;font-size:10.5px;font-weight:600;letter-spacing:.6px;text-transform:uppercase;color:var(--faint)}
  .help-list{list-style:none;margin:0;padding:0}
  .help-list li{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--hair)}
  .help-list a{color:var(--ink);font-size:13.5px;font-weight:500;text-decoration:none}
  .help-list a:hover{color:var(--accent)}
  .help-news{margin-top:16px}
  .help-grp{font-size:11px;color:var(--faint)}
  .help-dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:var(--today)}
  .help-empty{font-size:13px;color:var(--muted);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .help-article{font-size:13.5px;line-height:1.55;color:var(--ink)}
  .help-article p{margin:0 0 10px}
  .help-article h3{margin:16px 0 6px;font-size:11.5px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted)}
  .help-article h3:first-child{margin-top:0}
  .help-article ol,.help-article ul{margin:0 0 10px;padding-left:20px}
  .help-article li{margin:4px 0}
  .help-tip{margin:0 0 10px;padding:9px 11px;border-radius:8px;background:var(--accent-tint);font-size:13px}
  .uichip{display:inline-block;padding:0 6px;border:1px solid var(--hair-strong);border-radius:5px;background:var(--surface);box-shadow:0 1px 0 var(--hair);color:var(--ink);font-size:12px;font-weight:600;line-height:1.5;white-space:nowrap}
  .help-legend{display:grid;gap:6px;margin:2px 0 10px}
  .help-legend-row{display:flex;align-items:center;gap:10px;font-size:12.5px;color:var(--muted)}
  .help-legend .chip{flex:0 0 120px;cursor:default}
  .help-swatches{display:flex;flex-wrap:wrap;gap:6px 14px;margin:0 0 12px;font-size:12.5px}
  .help-swatch{display:inline-block;width:10px;height:10px;margin-right:6px;border-radius:3px;vertical-align:-1px}
  .mhead-ico.q{font-size:14px;font-weight:700}
  .badge-btn{border:0;font-family:inherit;line-height:inherit;cursor:pointer;appearance:none}
  .badge-btn:hover{filter:brightness(.95)}
  .gate .gate-help{margin:16px 0 0;font-size:12.5px}
  .gate .gate-help a{color:var(--accent);font-weight:600}
  @media (min-width:601px){
    body.help-open .scrim{padding-right:calc(var(--help-w) + 16px)}         /* the open editor sits beside the drawer */
    body.help-open .gate-scrim{padding-right:calc(var(--help-w) + 20px)}
  }
  @media (max-width:600px){
    .help-drawer{width:100%;border-left:0;box-shadow:none}
    body.help-open{overflow:hidden}
  }

```

- [ ] **Step 9: `web/app.js` — delete the Legend & key modal**

Delete the whole `function legendHTML(){ … }` and `function openInfo(){ … }` block. It starts at `function legendHTML(){` (just after `renderLayers()`) and ends with the closing `}` of `openInfo` — the line before the `/* ===… MODAL ===… */` banner. Then delete these two lines further down (plus the blank line after them):
```js
/* legend / info modal */
document.getElementById('infoBtn').addEventListener('click',openInfo);
```

- [ ] **Step 10: Verify**

Run:
```bash
grep -n "legendHTML\|openInfo\|infoBtn\|__info__\|info-btn\|infogrid" web/app.js web/index.html web/styles.css; node --check web/app.js && node scripts/check-help.mjs; echo "exit=$?"
```
Expected: the grep prints nothing; `check-help: OK`; `exit=0` (the `[[?]]` labels now resolve to the new button).

Then in the preview (`preview_start {name:"web"}`), reload and check `read_console_messages {onlyErrors:true}`: no new errors (a Firebase "not signed in" notice is fine). The drawer isn't wired yet — that's Task 8.

- [ ] **Step 11: Commit**

```bash
git add web/index.html web/styles.css web/app.js
git commit -m "feat(help): drawer shell + ? button; retire the stale Legend & key modal" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Drawer behavior — open/close, guides, search, What's new, Welcome, `?help=`

**Files:**
- Modify: `web/app.js` (new HELP block before `/* utils */`; two lines in `init()`)

- [ ] **Step 1: Add the HELP block**

In `web/app.js`, insert immediately before the line `/* utils */`:

```js
/* =========================================================================
   HELP — the Help drawer. Guides live in web/help/guide.md and What's new in
   web/help/whats-new.md; HelpLib (web/help/help-lib.js) parses + renders them.
   Entry points: the header ?, the editor/create-form ?, the status badge, the
   sign-in gate link, ?help=<id>, and a once-per-device Welcome. App code names
   a guide ONLY via openHelp('<id>'), help:'<id>' or data-help="<id>" — the
   forms scripts/check-help.mjs verifies. Design:
   docs/superpowers/specs/2026-09-29-in-app-help-design.md
   ========================================================================= */
const HELP_WELCOMED_KEY='est-help-welcomed';   // set once the Welcome has auto-opened on this device
const HELP_SEEN_KEY='est-help-seen';           // newest What's-new date this device has seen
const HELP_RETURNING=!!cacheGet('rows-raw');   // used the app before? (read before init() refreshes the row cache)
const help={ guides:null, news:null, view:'index', id:'', query:'', opener:null };
let _helpP=null, _newsP=null;

// localStorage for help state: undefined = storage unavailable (so never nag), null = unset.
function helpGet(k){ try{ return localStorage.getItem(k); }catch(_){ return undefined; } }
function helpSet(k,v){ try{ localStorage.setItem(k,v); return true; }catch(_){ return false; } }

async function fetchHelpFile(name){
  const r=await fetch(`help/${name}`, { cache:'no-cache' });   // revalidate: a deploy shows up on the next open
  if(!r.ok) throw new Error(`help/${name}: ${r.status}`);
  return r.text();
}
function loadNews(){
  if(!_newsP) _newsP=fetchHelpFile('whats-new.md')
    .then(md=>{ help.news=HelpLib.parseWhatsNew(md).entries; return help.news; })
    .catch(err=>{ _newsP=null; throw err; });
  return _newsP;
}
function loadHelp(){
  if(!_helpP) _helpP=Promise.all([fetchHelpFile('guide.md'), loadNews().catch(()=>null)])
    .then(([md])=>{ help.guides=HelpLib.parseGuide(md).guides; })
    .catch(err=>{ _helpP=null; throw err; });
  return _helpP;
}

function latestNews(){ return (help.news && help.news[0] && help.news[0].date) || ''; }
function newsUnseen(){ const latest=latestNews(), seen=helpGet(HELP_SEEN_KEY); return !!latest && seen!==undefined && (!seen || latest>seen); }
function markNewsSeen(){ const latest=latestNews(); if(latest) helpSet(HELP_SEEN_KEY, latest); paintHelpDot(); }
function paintHelpDot(){ const b=document.getElementById('helpBtn'); if(b) b.classList.toggle('has-news', newsUnseen()); }

function setHelpUrl(id){
  const u=new URL(location.href);
  if(id) u.searchParams.set('help', id);
  else if(u.searchParams.has('help')) u.searchParams.delete('help');
  else return;
  history.replaceState(null,'',u);
}

// {{legend}} in guide.md: the calendar key, drawn with the calendar's own chip
// classes and the live program list — so it can't drift from what's on screen.
function legendEmbedHTML(){
  const progs=PROGRAMS.filter(p=>p.id!=='oth');
  const hue=(progs[0] && progs[0].color) || 'var(--accent)';
  const row=(cls,label,note)=>`<div class="help-legend-row"><div class="chip ${cls}" style="--c:${esc(hue)}"><span class="t">${label}</span>${cls==='approved'?'<span class="lock">🔒</span>':''}</div><span>${note}</span></div>`;
  const ref=REF_LAYERS[0];
  return `<div class="help-legend">
      ${row('draft','Draft','Being planned')}
      ${row('proposed','Proposed','Waiting for Tribal Council')}
      ${row('approved','Approved','Confirmed and locked')}
      ${row('cancelled','Cancelled','Not happening')}
      <div class="help-legend-row"><div class="chip ref" style="--c:${esc(ref?ref.color:'var(--faint)')}"><span class="t">${esc(ref?ref.name:'Holiday')}</span></div><span>Reference calendar (read-only)</span></div>
    </div>
    <div class="help-swatches">${progs.map(p=>`<span><span class="help-swatch" style="background:${esc(p.color)}"></span>${esc(p.name)}</span>`).join('')}</div>`;
}
function helpEmbed(name){ return name==='legend' ? legendEmbedHTML() : ''; }

function helpResultsHTML(){
  const q=help.query.trim();
  const item=g=>`<li><a href="#" data-help-link="${esc(g.id)}">${esc(g.title)}</a>${q?` <span class="help-grp">${esc(g.group)}</span>`:''}</li>`;
  if(q){
    const hits=HelpLib.searchGuides(help.guides, q);
    return hits.length ? `<ul class="help-list">${hits.map(item).join('')}</ul>`
      : `<p class="help-empty">No guides match — try other words, or <a href="mailto:${SUPPORT_EMAIL}">email us</a>.</p>`;
  }
  const groups=[...new Set(help.guides.map(g=>g.group))];
  return groups.map(gr=>`<div class="help-grouph">${esc(gr)}</div><ul class="help-list">${help.guides.filter(g=>g.group===gr).map(item).join('')}</ul>`).join('')
    + `<ul class="help-list help-news"><li><a href="#" data-help-link="whats-new">What's new</a>${newsUnseen()?'<span class="help-dot" title="New since your last look"></span>':''}</li></ul>`;
}

async function renderHelp(){
  const body=document.getElementById('helpBody'), title=document.getElementById('helpTitle'), back=document.getElementById('helpBack');
  if(!help.guides){
    title.textContent='Help'; back.hidden=true;
    body.innerHTML=`<p class="help-empty"><span class="ndoc-spin"></span> Loading help…</p>`;
    try{ await loadHelp(); }
    catch(_){
      body.innerHTML=`<p class="help-empty">Help couldn't load. Check your connection and try again.</p><button type="button" class="btn sm" data-help-retry>Retry</button>`;
      return;
    }
  }
  const guide=(help.view==='guide' && help.id!=='whats-new') ? help.guides.find(g=>g.id===help.id) : null;
  if(help.view==='guide' && help.id==='whats-new'){
    title.textContent="What's new";
    body.innerHTML=`<article class="help-article">${HelpLib.renderWhatsNew(help.news)}</article>`;
    markNewsSeen();
  } else if(guide){
    title.textContent=guide.title;
    body.innerHTML=`<article class="help-article">${HelpLib.renderGuide(guide.body, { embed:helpEmbed })}</article>`;
  } else {                                       // the index — also the fallback for an unknown id
    help.view='index'; help.id='';
    title.textContent='Help';
    body.innerHTML=`<input class="help-search" id="helpSearch" type="search" placeholder="Search help" aria-label="Search help" value="${esc(help.query)}"><div id="helpResults">${helpResultsHTML()}</div>`;
  }
  back.hidden = help.view==='index';
  setHelpUrl(help.view==='index' ? '' : help.id);
  body.scrollTop=0;
}
function openHelp(id, opener){
  const d=document.getElementById('helpDrawer'); if(!d) return;
  if(d.hidden) help.opener=opener||document.activeElement;
  help.view=id?'guide':'index'; help.id=id||'';
  d.hidden=false; document.body.classList.add('help-open');
  renderHelp();
  d.focus({ preventScroll:true });
}
function closeHelp(){
  const d=document.getElementById('helpDrawer'); if(!d || d.hidden) return;
  d.hidden=true; document.body.classList.remove('help-open'); setHelpUrl('');
  const o=help.opener; help.opener=null;
  if(o && o.isConnected && typeof o.focus==='function') o.focus({ preventScroll:true });
}

document.getElementById('helpClose').addEventListener('click', closeHelp);
document.getElementById('helpBack').addEventListener('click', ()=>{ help.view='index'; help.id=''; renderHelp(); });
document.getElementById('helpDrawer').addEventListener('click', e=>{
  const l=e.target.closest('[data-help-link]');
  if(l){ e.preventDefault(); help.view='guide'; help.id=l.dataset.helpLink; renderHelp(); return; }
  if(e.target.closest('[data-help-retry]')) renderHelp();
});
document.getElementById('helpBody').addEventListener('input', e=>{
  if(e.target.id!=='helpSearch') return;
  help.query=e.target.value;
  const r=document.getElementById('helpResults'); if(r) r.innerHTML=helpResultsHTML();
});
// Any [data-help="<id>"] opens that guide ("" = the index); the header ? toggles.
document.addEventListener('click', e=>{
  const t=e.target.closest('[data-help]'); if(!t) return;
  e.preventDefault();
  const d=document.getElementById('helpDrawer');
  if(t.id==='helpBtn' && d && !d.hidden){ closeHelp(); return; }
  openHelp(t.dataset.help, t);
});
// Esc peels the drawer first: the capture phase runs before the modal's Esc-to-close.
document.addEventListener('keydown', e=>{
  if(e.key!=='Escape') return;
  const d=document.getElementById('helpDrawer');
  if(d && !d.hidden){ e.preventDefault(); e.stopImmediatePropagation(); closeHelp(); }
}, true);
// Welcome: auto-opens once per device, the first time a signed-in identity resolves.
function maybeWelcome(){
  if(!(state.identity && state.identity.signedIn)) return;
  const p=new URL(location.href).searchParams;
  if(p.has('event') || p.has('help')) return;                               // arrived via a shared link — don't cover it
  if(document.getElementById('scrim').classList.contains('open')) return;   // something is already open
  if(helpGet(HELP_WELCOMED_KEY)!==null) return;                             // welcomed before, or storage unavailable
  if(!helpSet(HELP_WELCOMED_KEY,'1')) return;
  if(!HELP_RETURNING) loadNews().then(markNewsSeen, ()=>{});                // brand-new here: nothing is "new" to them
  openHelp('welcome');
}
document.addEventListener('est:identity', maybeWelcome);

```

- [ ] **Step 2: Wire `?help=` and the dot into `init()`**

In `init()`, replace:
```js
  buildWeekHead(); renderLayers(); updateNavLabel(); initAuth();
```
with:
```js
  buildWeekHead(); renderLayers(); updateNavLabel(); initAuth();
  { const hp=new URL(location.href).searchParams.get('help'); if(hp!==null) openHelp(hp); }   // ?help=<id> opens that guide (works signed out)
```

and replace:
```js
  openFromUrl();                 // deep-link: ?event=<id>&section=<id> opens that event
```
with:
```js
  openFromUrl();                 // deep-link: ?event=<id>&section=<id> opens that event
  loadNews().then(paintHelpDot, ()=>{});   // What's new dot on the header ? (after the first paint)
```

- [ ] **Step 3: Syntax + guard**

Run: `node --check web/app.js && node scripts/check-help.mjs`
Expected: `check-help: OK`.

- [ ] **Step 4: Verify signed-out paths in the preview**

With the `web` preview open, `navigate` to `http://localhost:8080/` and check:
1. The sign-in screen shows **New here? See how it works**. Click it → the drawer opens on "Welcome to the Planning Calendar" with button chips and a tip box; the address bar has `?help=welcome` (`read_page` or a screenshot).
2. Press Esc → the drawer closes and `?help=` leaves the URL.
3. `navigate` to `http://localhost:8080/?help=reading-the-calendar` → the drawer opens on "Read the calendar"; the key shows four status chips (Draft / Proposed / Approved 🔒 / Cancelled), a reference chip, and program swatches.
4. Click **← All guides** → four groups (Getting started / Planning an event / After approval / Help) and **What's new** at the bottom. Type `eventbrite` in the search → "Publish to Eventbrite" appears; type `zzzz` → "No guides match…". Clear the search.
5. Click **What's new** → three dated sections; `javascript_tool`: `localStorage.getItem('est-help-seen')` returns `"2026-09-29"`.
6. `navigate` to `http://localhost:8080/?help=not-a-guide` → the drawer opens on the index.
7. `read_console_messages {onlyErrors:true}` → no new errors.

- [ ] **Step 5: Verify the Welcome and the header `?` with a simulated signed-in viewer**

`navigate` to `http://localhost:8080/`, then run (inspection only — a read-only viewer; never commit this):
```js
localStorage.removeItem('est-help-welcomed'); localStorage.removeItem('est-help-seen');
state.identity={signedIn:true,matched:true,name:'Preview',canWrite:false,canApprove:false};
state.authResolved=true; state.authPending=false; renderAuth();
document.dispatchEvent(new CustomEvent('est:identity'));
```
Expected: the sign-in screen hides and the drawer opens on the Welcome; `localStorage.getItem('est-help-welcomed')` is `"1"`. Close it (×), then run `document.dispatchEvent(new CustomEvent('est:identity'))` again → the drawer stays closed. Click the header **?** → the index opens; click **?** again → it closes. `paintHelpDot()` state: `document.getElementById('helpBtn').classList.contains('has-news')` is `false` only after What's new has been opened (step 4.5) or for a brand-new visitor.

- [ ] **Step 6: Verify dark mode and phone width**

`resize_window {colorScheme:'dark'}`, open a guide, screenshot → readable text, chips and the tip box on the dark theme. `resize_window {preset:'mobile'}`, reload, open a guide → the drawer fills the screen; × returns to the calendar. Finish with `resize_window {preset:'desktop'}`.

- [ ] **Step 7: Commit**

```bash
git add web/app.js
git commit -m "feat(help): Help drawer — guides, search, What's new + dot, Welcome, ?help= links" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Editor entry points — the tab `?`, the status badge, the create form `?`

**Files:**
- Modify: `web/app.js`

- [ ] **Step 1: Give each editor section its guide**

Replace:
```js
// Editor workspace sections (left rail). `live` sections have real panels;
// the rest render a muted "coming soon" teaser. No icon webfont — text labels.
const SECTIONS = [
  { id:'details',   label:'Details',              live:true },
  { id:'notes',     label:'Planning Notes',       live:true },
  { id:'volunteers',label:'Potluck & Volunteers', live:true },
  { id:'attendees', label:'Attendees',            live:true },
  { id:'budget',    label:'Budget & expenses',    live:false },
  { id:'comms',     label:'Comms',                live:false },
  { id:'feedback',  label:'Feedback',             live:false },
];
```
with:
```js
// Editor workspace sections (left rail). `live` sections have real panels;
// the rest render a muted "coming soon" teaser. `help` = the guide (web/help/
// guide.md) the editor header's ? opens for that tab. No icon webfont — text labels.
const SECTIONS = [
  { id:'details',   label:'Details',              live:true,  help:'edit-details' },
  { id:'notes',     label:'Planning Notes',       live:true,  help:'planning-notes' },
  { id:'volunteers',label:'Potluck & Volunteers', live:true,  help:'signups' },
  { id:'attendees', label:'Attendees',            live:true,  help:'attendees' },
  { id:'budget',    label:'Budget & expenses',    live:false, help:'feedback' },
  { id:'comms',     label:'Comms',                live:false, help:'feedback' },
  { id:'feedback',  label:'Feedback',             live:false, help:'feedback' },
];
```

- [ ] **Step 2: Status badge button + `?` in the editor header**

In `openEditor`, replace:
```js
  // header: derived status badge next to the title on the LEFT (display-only;
  // transitions live in the footer); action icons on the right.
  const si=statusInfo(ev);
  let badges = `<span class="badge b-${si.cls}">${si.label}</span>`;
  if(isPastEvent(ev)) badges += `<span class="badge b-past">Past</span>`;
  document.getElementById('mBadges').innerHTML = badges;
  let head = '';
```
with:
```js
  // header: derived status badge next to the title on the LEFT (a button that
  // opens the lifecycle guide; transitions live in the footer); action icons on
  // the right — ? (help for the active tab), view-in-gather, copy-link.
  const si=statusInfo(ev);
  let badges = `<button type="button" class="badge b-${si.cls} badge-btn" data-help="lifecycle" title="What does this mean?">${si.label}</button>`;
  if(isPastEvent(ev)) badges += `<span class="badge b-past">Past</span>`;
  document.getElementById('mBadges').innerHTML = badges;
  let head = `<button type="button" class="mhead-ico q" data-act="help" title="Help for this tab" aria-label="Help for this tab">?</button>`;
```

- [ ] **Step 3: `?` in the New event form**

In `openNewEventForm`, replace:
```js
  document.getElementById('mBadges').innerHTML=''; document.getElementById('mActions').innerHTML = '';   // no status/approve until the row exists
```
with:
```js
  document.getElementById('mBadges').innerHTML='';   // no status/approve until the row exists
  document.getElementById('mActions').innerHTML = `<button type="button" class="mhead-ico q" data-help="add-event" title="Help: adding an event" aria-label="Help: adding an event">?</button>`;
```

- [ ] **Step 4: Handle the header `?`**

Replace:
```js
// header actions: copy-link icon (status is display-only; transitions are in the footer)
document.getElementById('mActions').addEventListener('click',e=>{
  const act=e.target.closest('[data-act]')?.dataset.act; if(!act) return;
  if(act==='copylink'){ navigator.clipboard.writeText(location.href).then(()=>toast('Link copied','ok'), ()=>toast('Copy failed','err')); }
});
```
with:
```js
// header actions: ? (help for the active tab) + copy-link. The status badge opens
// the lifecycle guide through data-help; transitions are in the footer.
document.getElementById('mActions').addEventListener('click',e=>{
  const btn=e.target.closest('[data-act]'); const act=btn?.dataset.act; if(!act) return;
  if(act==='copylink'){ navigator.clipboard.writeText(location.href).then(()=>toast('Link copied','ok'), ()=>toast('Copy failed','err')); }
  else if(act==='help'){ const s=SECTIONS.find(x=>x.id===activeSection); openHelp((s && s.help) || '', btn); }
});
```

- [ ] **Step 5: Syntax + guard**

Run: `node --check web/app.js && node scripts/check-help.mjs`
Expected: `check-help: OK` (it now also verifies the `help:` ids and the `lifecycle` / `add-event` links).

- [ ] **Step 6: Verify in the preview (simulated read-only viewer)**

Reload `http://localhost:8080/` and run the Task 8 Step 5 snippet again (a `canWrite:false` viewer — the editor opens read-only, so nothing can autosave). Then:
1. Click any event chip → the editor opens. The header shows a **?** icon, and the status badge is a button (hover: "What does this mean?").
2. Click **?** on Details → the drawer opens on "Edit an event", with the editor still visible beside it (desktop width).
3. Switch to the **Attendees** tab, click **?** → "See who's coming".
4. Click the status badge → "From draft to approved".
5. Press Esc → only the drawer closes; press Esc again → the editor closes.
6. Create-form **?**: run `state.identity.canWrite=true`, click **+ New event**, click its **?** → "Add an event or idea". Then click **Cancel** — **never Create** — and run `state.identity.canWrite=false`.
7. `read_console_messages {onlyErrors:true}` → no new errors.

- [ ] **Step 7: Commit**

```bash
git add web/app.js
git commit -m "feat(help): editor entry points — tab ?, status-badge guide, create-form ?" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The blocking hook

**Files:**
- Create: `.claude/settings.json`

- [ ] **Step 1: Create the project hook config**

Create `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/scripts/check-help.mjs\" --hook",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

(Contract confirmed against https://code.claude.com/docs/en/hooks.md on 2026-09-29: stdin carries `tool_name`, `tool_input.command` and `cwd`; exit 2 blocks the call and shows stderr to Claude; any other non-zero exit is a non-blocking warning; `$CLAUDE_PROJECT_DIR` is set; project settings changes are picked up without a restart. The script does its own command filtering, so no `if` condition is needed.)

- [ ] **Step 2: Commit it on the feature branch**

```bash
git add .claude/settings.json
git commit -m "chore(help): PreToolUse hook runs the help guard before merges into main and PRs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Make a scratch branch that "forgets" the help**

```bash
git checkout -b tmp/help-guard-demo
printf '\n// help-guard demo\n' >> web/app.js
git commit -qam "demo: screens change without help"
```

- [ ] **Step 4: CLI branch check fails, with the reason**

Run: `node scripts/check-help.mjs --branch tmp/help-guard-demo --base feat/help-guide; echo "exit=$?"`
Expected: `check-help: 1 problem` → `this branch changes the app's screens (web/app.js) but not web/help/ (tmp/help-guard-demo vs feat/help-guide)`, the Fix line, `exit=1`.

- [ ] **Step 5: Hook mode blocks the equivalent PR**

Run: `printf '%s' "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"gh pr create --base feat/help-guide --fill\"},\"cwd\":\"$PWD\"}" | node scripts/check-help.mjs --hook; echo "exit=$?"`
Expected: `Help guard blocked this pull request — …` plus the same problem, `exit=2`.

- [ ] **Step 6: The live hook blocks it inside Claude Code**

Run this exact command through the Bash tool (if the hook were NOT active it would only print gh's help — harmless):
```bash
gh pr create --base feat/help-guide --help
```
Expected: the tool call is **blocked** and the result shows the "Help guard blocked this pull request" message. If gh's help text prints instead, the hook is not active: check that `.claude/settings.json` is valid JSON (`node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8'))"`), then ask the user to open `/hooks` in an interactive `claude` terminal to confirm it's registered.

- [ ] **Step 7: The escape hatch lets it through**

```bash
git commit -q --allow-empty -m "chore: demo" -m "Help: none — demo of the escape hatch"
node scripts/check-help.mjs --branch tmp/help-guard-demo --base feat/help-guide; echo "exit=$?"
```
Expected: `check-help: OK (tmp/help-guard-demo vs feat/help-guide)`, `exit=0`.

- [ ] **Step 8: Clean up the scratch branch**

```bash
git checkout -q feat/help-guide && git branch -D tmp/help-guard-demo && git status --short
```
Expected: back on `feat/help-guide`, the scratch branch deleted, a clean tree (the demo line never reached the feature branch).

---

### Task 11: The GitHub check

**Files:**
- Create: `.github/workflows/check-help.yml`

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/check-help.yml`:

```yaml
name: Help guide check
# Keeps web/help/ (the in-app guides) in step with the app — see scripts/check-help.mjs.
on:
  pull_request:
  push:
    branches: [main]
jobs:
  check-help:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Unit tests (help-lib + guard)
        run: node --test proxy/test/help-lib.test.js proxy/test/check-help.test.js
      - name: Content check (labels, links, ids, What's new)
        run: node scripts/check-help.mjs
      - name: Branch check (screens changed → help changed, or "Help: none — <reason>")
        if: github.event_name == 'pull_request'
        run: node scripts/check-help.mjs --branch HEAD --base origin/${{ github.base_ref }}
```

- [ ] **Step 2: Sanity-check the YAML**

Run: `ruby -ryaml -e 'YAML.load_file(".github/workflows/check-help.yml"); puts "yaml ok"'`
Expected: `yaml ok`. (If `ruby` isn't installed, skip this step — GitHub validates the file on push.)

- [ ] **Step 3: Run the same commands locally**

Run: `node --test proxy/test/help-lib.test.js proxy/test/check-help.test.js && node scripts/check-help.mjs && node scripts/check-help.mjs --branch HEAD --base main`
Expected: `# fail 0`, then `check-help: OK`, then `check-help: OK (HEAD vs main)`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/check-help.yml
git commit -m "ci(help): run the help guard on PRs and pushes to main" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Docs — the CLAUDE.md rule and the spec sync

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-09-29-in-app-help-design.md`

- [ ] **Step 1: CLAUDE.md repo map**

Replace:
```
| `web/embed-test/index.html` | "Did JS run in the embed?" validator — **deferred** (standalone is the current path) | Netlify (`plan.eastsidetribe.org`) |
```
with:
```
| `web/embed-test/index.html` | "Did JS run in the embed?" validator — **deferred** (standalone is the current path) | Netlify (`plan.eastsidetribe.org`) |
| `web/help/` | In-app help — `guide.md` (lead-facing guides), `whats-new.md`, `help-lib.js` (parser/renderer shared by the app, the tests and the guard) | Netlify (with `web/`) |
| `scripts/check-help.mjs` | Help guard — keeps `web/help/` in step with the app (run by a Claude Code hook + a GitHub check) | — |
```

- [ ] **Step 2: CLAUDE.md app-structure bullet**

Replace:
```
- **`openInfo()`**: the legend/key modal (the round "i" button).
```
with:
```
- **Help drawer** (`openHelp(id)` / `closeHelp` / `renderHelp` — the HELP block near
  the end of `app.js`): a right-side drawer that renders `web/help/guide.md` +
  `whats-new.md` through `HelpLib` (`web/help/help-lib.js`). Entry points: the header
  **?** (`#helpBtn`), the editor header's **?** (`data-act="help"` → the active
  section's `SECTIONS[].help`), the create form's **?**, the status badge
  (`data-help="lifecycle"`), the sign-in "New here?" link, `?help=<id>`, and a
  once-per-device Welcome on first sign-in (`est-help-welcomed`); a What's-new dot
  (`est-help-seen`). The calendar key is the guide's live `{{legend}}` embed
  (`legendEmbedHTML`). App code names a guide ONLY via `openHelp('<id>')`,
  `help:'<id>'` or `data-help="<id>"` — the forms the guard checks.
```

- [ ] **Step 3: CLAUDE.md convention**

Replace:
```
- `main` is always deployable. Work on branches, PR into `main`.
```
with:
```
- `main` is always deployable. Work on branches, PR into `main`.
- **Help ships with the change.** Any change a program lead could notice — a new,
  renamed, moved or removed button, tab, field, step or rule — updates
  `web/help/guide.md` and adds a dated line to `web/help/whats-new.md` **in the same
  branch**; implementation plans for user-facing work include an "Update help" task.
  Write for a non-technical lead (writing guide at the top of `guide.md`) and put exact
  on-screen text in `[[ ]]` — the guard checks it still exists. A branch that touches
  the screens (top-level `web/*.js|html`) with nothing lead-visible records
  `Help: none — <reason>` in a commit message. `scripts/check-help.mjs` enforces this:
  a PreToolUse hook (`.claude/settings.json`) blocks `git merge <branch>` into `main`
  and `gh pr create` on findings, and `.github/workflows/check-help.yml` runs it on PRs
  and pushes to `main`. By hand: `node scripts/check-help.mjs [--branch <ref>]`.
```

- [ ] **Step 4: Spec sync — the stale publish hint**

In `docs/superpowers/specs/2026-09-29-in-app-help-design.md`, replace:
```
the "Eventbrite is behind your latest edits" hint,
```
with:
```
the Update draft / Update published event buttons that appear after an edit,
```

- [ ] **Step 5: Spec sync — the HelpLib API**

In the same file, replace:
```
- `renderGuide(body, { chip, embed })` → safe HTML. All text is escaped; only the §4
  syntax becomes markup; `chip(label)` and `embed(name)` are supplied by the caller.
- `uiLabels(md)` → `[{ label, line }]`, for the guard.
- `parseWhatsNew(md)` → `[{ date, items }]`.
```
with:
```
- `renderGuide(body, { embed })` → safe HTML. All text is escaped; only the §4 syntax
  becomes markup; `[[Label]]` always renders as `<span class="uichip">`; `embed(name)`
  is supplied by the caller.
- `uiLabels(md)`, `guideLinks(md)`, `embeds(md)` → `[{ …, line }]`, for the guard.
- `parseWhatsNew(md)` → `{ entries: [{ date, line, items }], errors }`;
  `renderWhatsNew(entries)` → safe HTML.
- `searchGuides(guides, query)` → the guides containing every word.
```

- [ ] **Step 6: Spec sync — compound merge commands**

In the same file, replace:
```
  - `git merge <ref>` while the current branch is `main` — the ref is the first
```
with:
```
  - `git merge <ref>` into `main` (the current branch, or one the same command
    switches to first, e.g. `git checkout main && git merge <ref>`) — the ref is the first
```

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-29-in-app-help-design.md
git commit -m "docs(help): CLAUDE.md 'Help ships with the change' rule; sync the spec" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Final verification

**Files:** none (verification only — fix anything found in the relevant earlier file, then re-run).

- [ ] **Step 1: Every test and check**

Run:
```bash
(cd proxy && npm test) && node --check web/app.js && node --check web/help/help-lib.js && node scripts/check-help.mjs && node scripts/check-help.mjs --branch feat/help-guide
```
Expected: `# fail 0` (the existing proxy suites plus both new files), no `node --check` output, `check-help: OK`, `check-help: OK (feat/help-guide vs main)`.

- [ ] **Step 2: Walk every guide against the running app**

In the preview (signed out, plus the simulated read-only viewer from Task 8 Step 5), open each guide and confirm each claim. If the app disagrees, fix the **guide**:

| Guide | Confirm in the app / code |
|---|---|
| Welcome | Path and roles match `footerActionsHTML`, `roleLabel` and `publishPanelHTML` (Tribal Council publishes) |
| Get around the calendar | Overview / Calendar buttons; the year arrows; the layer toggles; at phone width, year + layers inside ⋯; `setInterval(… 60000)` refresh |
| Read the calendar | The key's chips look like real chips on the calendar; `+1` marker; range tags like `12–18` in the Ideas column |
| Add an event or idea | **+ New event** opens a form with Title, When (Exact date / Date range / Whole month), Program(s), Leads, Where (type a new name → "＋ New venue") — then **Cancel** |
| Edit an event | Tab names; save-label texts in `setSaveStatus` |
| From draft to approved | Footer buttons per status in `footerActionsHTML`; the `locked` rule in `openEditor` |
| Planning notes | `renderNotes` states and button text |
| Potluck & volunteer sign-ups | Group names, the Add rows, **+ Add sign-up**; the read-only note for viewers |
| Publish to Eventbrite | For an approved event: the **Public listing** fields; a non-approved event shows the "Available once approved" note |
| See who's coming | Viewer without a token sees "Sign in as a program lead or council member…"; filter names in `web/roster-lib.js` |
| Share a link | The link icon's tooltip reads "Copy link"; a guide URL carries `?help=` |
| Common problems | **Continue with Google** / **Email me a link** on the sign-in screen; **Refresh roles & people** in `renderAuth` |
| Suggest an improvement | **Feedback / Ideas** opens the board; **Submit** appears for a matched viewer — don't submit |

- [ ] **Step 3: Visual proof**

Screenshot at desktop width: the editor open with the drawer beside it on "Edit an event". Screenshot at phone width (`resize_window {preset:'mobile'}`): the drawer full-screen on the Welcome. Screenshot in dark mode: "Read the calendar" with the key. Reset with `resize_window {preset:'desktop'}`. Then `read_console_messages {onlyErrors:true}` → no new errors.

- [ ] **Step 4: Hand the user a live spot-check list**

Role-specific behavior can't be exercised without a real lead/council login, so give the user this short list to try on `plan.eastsidetribe.org` after the merge deploys:
1. As a Program Lead on an approved event: the details are read-only and there's no Eventbrite publish button — matching "From draft to approved" and "Publish to Eventbrite".
2. As Tribal Council: the Publish flow's button texts match the "Publish to Eventbrite" guide.
3. First sign-in on a fresh browser: the Welcome opens once; the ? dot appears for returning users until they open What's new.

- [ ] **Step 5: Review the branch**

Run: `git log --oneline main..feat/help-guide && git status --short`
Expected: the task commits listed and a clean tree. Then hand off to superpowers:finishing-a-development-branch — the help hook will run the guard on the merge/PR automatically.
