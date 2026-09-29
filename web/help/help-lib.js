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
