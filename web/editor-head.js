/* editor-head.js — what the open event's header shows under and beside its title.
   Pure (no DOM): node-tested in proxy/test/editor-head.test.js. Attaches
   `EditorHead` to globalThis (same shape as save-queue.js).

   subtitle(text, max=120) -> string
     The first non-blank line of the internal notes, whitespace collapsed, cut at
     `max` characters with an ellipsis. '' when there is nothing to show.
   programTag(programIds, progMap) -> null | { id, name, color, more }
     The first program that is in progMap (its own name and color) and how many
     more programs the event has. null when the event has none we know. */
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
  root.EditorHead = { subtitle, programTag };
})(typeof globalThis !== 'undefined' ? globalThis : this);
