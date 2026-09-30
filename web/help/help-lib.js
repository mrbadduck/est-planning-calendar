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
  // A guide with a missing/bad/reserved/duplicate id, no title, or no group is
  // reported and skipped. Authoring slips (an unterminated comment, a [[label]]
  // split across lines, a heading with no space after #) are reported too.
  function parseGuide(md) {
    const guides = [], errors = [], seen = new Set();
    let group = '', cur = null;
    const close = () => {
      if (cur) { cur.body = cur.lines.join('\n').trim(); delete cur.lines; guides.push(cur); }
      cur = null;
    };
    linesOf(md).forEach((raw, i) => {
      const line = i + 1;
      if (raw.includes('<!--')) errors.push({ line, message: 'unterminated <!-- comment — close it with -->' });
      if (/\[\[(?![^\]\n]*\]\])/.test(raw)) errors.push({ line, message: 'unclosed [[ — keep each [[Label]] on one line' });
      if (/^#{1,3}[^#\s]/.test(raw)) errors.push({ line, message: 'put a space after the # in a heading' });
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
        else if (!title) err = `guide "${id}" has no title`;
        else if (!group) err = `guide "${id}" comes before the first "# Group" heading`;
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
  // #id → another guide (the drawer handles data-help-link clicks); http(s) →
  // new tab; mailto → the mail app (no blank tab); any other scheme
  // (javascript:, data:) renders as plain text.
  function link(label, url) {
    if (url.startsWith('#')) return `<a href="#" data-help-link="${esc(url.slice(1))}">${inline(label)}</a>`;
    if (/^https?:/i.test(url)) return `<a href="${esc(url)}" target="_blank" rel="noopener">${inline(label)}</a>`;
    if (/^mailto:/i.test(url)) return `<a href="${esc(url)}">${inline(label)}</a>`;
    return inline(label);
  }

  // Block markup for one guide body: paragraphs, "### " subheads, "- " / "1. "
  // lists (one level; an <ol> keeps its first number, e.g. after a tip), "> " tips,
  // and {{embed}} on its own line (via opts.embed; inner spaces allowed).
  function renderGuide(body, opts) {
    const embed = (opts && opts.embed) || (() => '');
    const out = [];
    let para = [], list = null, tip = null;
    const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); para = []; };
    const flushList = () => { if (list) out.push(`<${list.tag}${list.start > 1 ? ` start="${list.start}"` : ''}>${list.items.map((it) => `<li>${inline(it)}</li>`).join('')}</${list.tag}>`); list = null; };
    const flushTip = () => { if (tip) out.push(`<div class="help-tip">${inline(tip.join(' '))}</div>`); tip = null; };
    const flush = () => { flushPara(); flushList(); flushTip(); };
    for (const raw of stripComments(body).split('\n')) {
      const line = raw.trim();
      let m;
      if (!line) { flush(); continue; }
      if ((m = /^\{\{\s*([a-z][a-z0-9-]*)\s*\}\}$/.exec(line))) { flush(); out.push(embed(m[1]) || ''); continue; }
      if ((m = /^###\s+(.+)$/.exec(line))) { flush(); out.push(`<h3>${inline(m[1])}</h3>`); continue; }
      if ((m = /^>\s?(.*)$/.exec(line))) { flushPara(); flushList(); (tip = tip || []).push(m[1]); continue; }
      const ul = /^-\s+(.+)$/.exec(line), ol = !ul && /^(\d+)\.\s+(.+)$/.exec(line);
      if (ul || ol) {
        const tag = ul ? 'ul' : 'ol';
        flushPara(); flushTip();
        if (!list || list.tag !== tag) { flushList(); list = { tag, start: ol ? Number(ol[1]) : 1, items: [] }; }
        list.items.push(ul ? ul[1] : ol[2]);
        continue;
      }
      if (list) { list.items[list.items.length - 1] += ' ' + line; continue; }   // wrapped list item
      flushTip();
      para.push(line);
    }
    flush();
    return out.join('\n');
  }

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
    return entries.map((e) => `<h3>${esc(fmtDate(e.date))}</h3><ul>${e.items.map((it) => `<li>${inline(it)}</li>`).join('')}</ul>`).join('');
  }

  // Search: every word must appear in the guide's title or body (case-insensitive).
  function searchGuides(guides, query) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return (guides || []).filter((g) => { const hay = `${g.title}\n${g.body}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
  }

  root.HelpLib = { EMBEDS, RESERVED, esc, stripComments, parseGuide, renderGuide, renderInline: inline, uiLabels, guideLinks, embeds, parseWhatsNew, renderWhatsNew, searchGuides };
})(typeof globalThis !== 'undefined' ? globalThis : this);
