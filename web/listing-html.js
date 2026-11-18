/* listing-html.js — allowlist sanitizer for Eventbrite description HTML.
   Pure (no DOM): a tokenizer over the string, so node tests it
   (proxy/test/listing-html.test.js). Attaches `ListingHtml` to globalThis.

   sanitize(html) -> string
     Allowed tags: p br strong b em i ul ol li a[href]. They are re-emitted in
     canonical lowercase with no attributes, except `a`, which keeps only an
     http(s)/mailto href and gets target="_blank" rel="noopener". Every other
     tag is dropped (its text stays). <script>/<style> are dropped with their
     content (an unclosed one drops the rest of the input); comments are
     dropped; an unterminated tag drops the rest. Text keeps well-formed
     character references verbatim and escapes everything else (< > & "), so output holds a raw `<` only in tags emitted here.
     Tags left open are closed at the end.
     Block tags outside the allowlist (div, headings, section, table cells…) are
     paragraph boundaries: top-level text between them is wrapped in its own <p>
     (Eventbrite stores summary and body as sibling <div>s, which otherwise ran
     together), and inside a p/li a boundary becomes a <br>. Never an empty or a
     nested <p>. Input with no block tags is not wrapped. */
(function (root) {
  const ALLOWED = { p: 1, br: 1, strong: 1, b: 1, em: 1, i: 1, ul: 1, ol: 1, li: 1, a: 1 };
  const VOID = { br: 1 };
  const INLINE = { strong: 1, b: 1, em: 1, i: 1, a: 1 };
  const BLOCK = {};
  ('div section article header footer main aside nav blockquote h1 h2 h3 h4 h5 h6 pre ' +
   'table thead tbody tfoot tr td th figure figcaption address hr dl dt dd center').split(' ').forEach(t => { BLOCK[t] = 1; });
  const AUTO_P = '#p'; // a <p> opened here for a block boundary (closes as </p>)
  const closeTag = name => '</' + (name === AUTO_P ? 'p' : name) + '>';
  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  function decode(s) {
    return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));?/g, (m, dec, hex, name) => {
      if (name) return Object.prototype.hasOwnProperty.call(NAMED, name.toLowerCase()) ? NAMED[name.toLowerCase()] : m;
      const cp = dec ? parseInt(dec, 10) : parseInt(hex, 16);
      if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '';
      return String.fromCodePoint(cp);
    });
  }
  // Text: keep well-formed character references verbatim (the browser decodes them to
  // characters, never markup); escape everything else.
  function escText(s) {
    return s.replace(/&(?:[a-zA-Z][a-zA-Z0-9]{1,31};|#\d{1,7};|#[xX][0-9a-fA-F]{1,6};)|[&<>"]/g,
      m => m.length > 1 ? m : m === '&' ? '&amp;' : m === '<' ? '&lt;' : m === '>' ? '&gt;' : '&quot;');
  }
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  const STRIP = /[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g;
  function safeHref(raw) {
    // Decode entities. Whitespace/control chars are ignored by browsers inside the scheme,
    // so strip them up to the first ':' and require an allowlisted scheme. After the colon,
    // spaces are percent-encoded and control chars dropped.
    const v = decode(raw);
    const k = v.indexOf(':');
    if (k < 0) return null;
    const scheme = v.slice(0, k).replace(STRIP, '');
    if (!/^(https?|mailto)$/i.test(scheme)) return null;
    const rest = v.slice(k + 1).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '').replace(/ /g, '%20');
    return scheme + ':' + rest;
  }

  // Parse a tag starting at html[i] === '<'. Returns { end, name, closing, href } or null if
  // there is no terminating '>' (quote-aware).
  function parseTag(html, i) {
    const n = html.length;
    let p = i + 1, closing = false;
    if (html[p] === '/') { closing = true; p++; }
    const ns = p;
    while (p < n && !/[\s\/>]/.test(html[p])) p++;
    const name = html.slice(ns, p).toLowerCase();
    let href = null;
    for (;;) {
      while (p < n && /[\s\/]/.test(html[p])) p++;
      if (p >= n) return null;
      if (html[p] === '>') return { end: p + 1, name, closing, href };
      const as = p;
      while (p < n && !/[\s=\/>]/.test(html[p])) p++;
      if (p === as) p++; // stray char (e.g. a lone quote): skip it
      const an = html.slice(as, p).toLowerCase();
      while (p < n && /\s/.test(html[p])) p++;
      let val = null;
      if (html[p] === '=') {
        p++;
        while (p < n && /\s/.test(html[p])) p++;
        if (html[p] === '"' || html[p] === "'") {
          const q = html[p], e = html.indexOf(q, p + 1);
          if (e < 0) return null;
          val = html.slice(p + 1, e); p = e + 1;
        } else {
          const vs = p;
          while (p < n && !/[\s>]/.test(html[p])) p++;
          val = html.slice(vs, p);
        }
      }
      if (an === 'href' && href === null && val !== null) href = val;
    }
  }

  function sanitize(html) {
    const s = html == null ? '' : String(html);
    const n = s.length;
    let out = '', text = '', i = 0;
    const stack = [];
    const MAX_DEPTH = 100;
    // blockMode: a block tag has been seen, so top-level content goes in paragraphs.
    // hadContent: something visible since the container/break began; needBreak: a
    // boundary inside a p/li owes a <br> before the next content.
    let blockMode = false, hadContent = false, needBreak = false;
    const closeTo = k => { while (stack.length > k) out += closeTag(stack.pop()); };
    const beforeContent = () => {
      if (blockMode && stack.length === 0) { out += '<p>'; stack.push(AUTO_P); }
      else if (needBreak) out += '<br>';
      needBreak = false; hadContent = true;
    };
    const boundary = () => {
      blockMode = true;
      const k = stack.indexOf(AUTO_P);
      if (k >= 0) closeTo(k);
      else if (stack.length && hadContent) needBreak = true;
      hadContent = false;
    };
    const flush = () => {
      if (!text) return;
      if (/\S/.test(text)) { beforeContent(); out += escText(text); }
      else if (!(blockMode && stack.length === 0)) out += escText(text);
      text = '';
    };
    while (i < n) {
      const c = s[i];
      if (c !== '<') { text += c; i++; continue; }
      if (s.startsWith('<!--', i)) {
        flush();
        const e = s.indexOf('-->', i + 4);
        if (e < 0) break;
        i = e + 3; continue;
      }
      if (!/[a-zA-Z\/]/.test(s[i + 1] || '') || (s[i + 1] === '/' && !/[a-zA-Z]/.test(s[i + 2] || ''))) {
        text += '<'; i++; continue; // not a tag: literal text (escaped on flush)
      }
      const t = parseTag(s, i);
      if (!t) break; // unterminated tag: drop the rest
      flush();
      i = t.end;
      if ((t.name === 'script' || t.name === 'style') && !t.closing) {
        const m = new RegExp('</' + t.name + '[\\s/>]', 'ig'); m.lastIndex = i;
        const r = m.exec(s);
        if (!r) break; // unclosed: drop everything after
        const gt = s.indexOf('>', r.index);
        if (gt < 0) break;
        i = gt + 1; continue;
      }
      if (BLOCK[t.name]) { boundary(); continue; }
      if (!ALLOWED[t.name]) continue;
      if (t.closing) {
        const k = stack.lastIndexOf(t.name);
        if (k >= 0) closeTo(k);
        if (!INLINE[t.name]) { needBreak = false; hadContent = false; }
        continue;
      }
      if (stack.length >= MAX_DEPTH && !VOID[t.name]) continue; // too deep: unwrap to text
      if (t.name === 'a') {
        const h = t.href == null ? null : safeHref(t.href);
        if (!h) continue; // unsafe link: unwrap to text
        beforeContent();
        out += '<a href="' + esc(h) + '" target="_blank" rel="noopener">';
        stack.push('a'); continue;
      }
      if (VOID[t.name]) {
        if (blockMode && stack.length === 0) continue; // blocks already separate
        if (needBreak) { out += '<br>'; needBreak = false; }
        out += '<' + t.name + '>'; hadContent = false; continue;
      }
      if (INLINE[t.name]) beforeContent();
      else {
        // p/ul/ol/li: never nest inside a paragraph opened here.
        const k = stack.indexOf(AUTO_P);
        if (k >= 0) closeTo(k);
        needBreak = false; hadContent = false;
      }
      out += '<' + t.name + '>';
      stack.push(t.name);
    }
    flush();
    closeTo(0);
    return out;
  }

  root.ListingHtml = { sanitize };
})(typeof globalThis !== 'undefined' ? globalThis : this);
