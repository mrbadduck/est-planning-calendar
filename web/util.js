/* util.js — small pure helpers: HTML escaping, date/time formatting, linkify, cssColor.
   Owns: cssColor, esc, cap, fmtDate, fmtTime, fmtDateTimeAt, fmtDateTimeRange, linkify
   Reads: WD, MONTHS (state.js; only when called, not at load)
   Writes: nothing
   Loaded after: editor-head.js (no load-time dependency) */

// A CSS color from data (e.g. a reference calendar's Color) — only real color
// values, so a value can't add declarations to a style="" attribute.
function cssColor(c, fallback){ const s=String(c||'').trim(); return /^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([\d\s.,%\/+-]+\)|var\(--[\w-]+\)|[a-z]+)$/i.test(s) ? s : fallback; }
// The header ? and the editor's aria-modal track the drawer (the editor stays usable beside it).

/* utils */
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function cap(s){return s?s[0].toUpperCase()+s.slice(1):s;}
function fmtDate(ds){const [y,m,d]=ds.split('-').map(Number);return `${WD[new Date(y,m-1,d).getDay()]}, ${MONTHS[m-1]} ${d}, ${y}`;}
// Reference-event datetime formatting. `iso` is a UTC (…Z) or naive datetime;
// rendered in the viewer's local time zone (EST leaders are in Nashville).
function fmtTime(iso){ return new Date(iso).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}); }
function fmtDateTimeAt(iso){ const d=new Date(iso); return `${WD[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} · ${fmtTime(iso)}`; }
function fmtDateTimeRange(startIso, endIso){
  if(!startIso) return '';
  const start=fmtDateTimeAt(startIso);
  if(!endIso) return start;
  const sd=new Date(startIso), ed=new Date(endIso);
  return sd.toDateString()===ed.toDateString() ? `${start} – ${fmtTime(endIso)}` : `${start} – ${fmtDateTimeAt(endIso)}`;
}
// Escape text, then turn bare URLs into safe links (used for ref descriptions).
function linkify(text){ return esc(text).replace(/(https?:\/\/[^\s<]+)/g, u=>`<a href="${u}" target="_blank" rel="noopener">${u}</a>`); }
