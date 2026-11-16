/* editor-head.js — what the open event's header shows under and beside its title.
   Pure (no DOM): node-tested in proxy/test/editor-head.test.js. Attaches
   `EditorHead` to globalThis (same shape as save-queue.js).

   subtitle(text, max=120) -> string
     The first non-blank line of the internal description, whitespace collapsed, cut at
     `max` characters with an ellipsis. '' when there is nothing to show.
   programTag(programIds, progMap) -> null | { id, name, color, more }
     The first program that is in progMap (its own name and color) and how many
     more programs the event has. null when the event has none we know.
   TAG_MIX / tagColors(color, theme) / contrast(a, b) — the program tag's colors as
     styles.css mixes them (color-mix in srgb: fill = color TAG_MIX.bg% into
     --surface, text = color TAG_MIX[theme].text% into --ink), so a test can hold
     the text to WCAG 4.5:1 for every program color in both themes. */
(function (root) {
  function subtitle(text, max) {
    const cap = max > 1 ? max : 120;
    const line = String(text == null ? '' : text).split(/\r?\n/).map(s => s.replace(/\s+/g, ' ').trim()).find(Boolean) || '';
    if (line.length <= cap) return line;
    return line.slice(0, cap - 1).replace(/\s+$/, '') + '…';
  }
  function programTag(programIds, progMap) {
    const ids = (Array.isArray(programIds) ? programIds : [programIds]).filter(Boolean);
    const map = progMap || {};
    const known = ids.filter(id => id !== 'oth' && map[id] && map[id].name);
    if (!known.length) return null;
    const p = map[known[0]];
    return { id: known[0], name: p.name, color: p.color || '', more: ids.length - 1 };
  }
  // Theme tokens the tag mixes with (styles.css :root and its dark override).
  const THEMES = { light: { surface: '#ffffff', ink: '#1C1B22' }, dark: { surface: '#242330', ink: '#E9E7F0' } };
  // Percent of the program color in the tag fill and text (the rest is --surface / --ink).
  const TAG_MIX = { bg: 14, light: { text: 45 }, dark: { text: 50 } };
  function parseColor(c) {
    const s = String(c || '').trim();
    let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (m) {
      const h = m[1].length === 3 ? m[1].replace(/./g, x => x + x) : m[1];
      return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    }
    m = s.match(/^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i);
    if (m) {
      const H = +m[1], S = m[2] / 100, L = m[3] / 100;
      const k = n => (n + H / 30) % 12, a = S * Math.min(L, 1 - L);
      const f = n => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      return [f(0), f(8), f(4)].map(v => Math.round(v * 255));
    }
    return null;
  }
  const mix = (a, b, pctA) => a.map((v, i) => v * pctA / 100 + b[i] * (1 - pctA / 100));
  const lum = rgb => {
    const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  function contrast(a, b) {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  function tagColors(color, theme) {
    const c = parseColor(color), t = THEMES[theme];
    if (!c || !t) return null;
    return { bg: mix(c, parseColor(t.surface), TAG_MIX.bg), text: mix(c, parseColor(t.ink), TAG_MIX[theme].text) };
  }
  root.EditorHead = { subtitle, programTag, parseColor, contrast, tagColors, TAG_MIX, THEMES };
})(typeof globalThis !== 'undefined' ? globalThis : this);
