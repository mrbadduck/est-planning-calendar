/* page-rules.js — pure rules for the event page: section-id aliases, the lifecycle
   step notes, "needs approval", the late-revert rule and the late-failure toast. Pure (no DOM): node-tested in
   proxy/test/page-rules.test.js. Attaches `PageRules` to globalThis (same shape as
   editor-head.js).

   sectionFromParam(id) -> string
     Maps an old or alias section id (?section=, links) to the tab id. The first tab
     stays 'details' so old links and syncUrl keep working.
   stepNotes(ev, {fmtDate, registrants, capacity}) -> string[6]
     One note per lifecycle step (Draft, Proposed, Approved, On Eventbrite,
     Published, Past — the event's date); '' when there is nothing to say.
   updatedFromEbLine(ev, fmtDate) -> string
     "Updated from Eventbrite: Start time, Capacity · <when>" when a change came in
     from Eventbrite after the last push from plan (ev.lastFromEb, ev.lastEbPushAt);
     '' otherwise.
   needsApproval(ev) -> boolean
     A planning event that is Proposed.
   revertTransition(ev, prev, setStatus) -> boolean
     A transition's Status write never confirmed: put `prev` back into ev, but only
     while ev.status is still the status that transition set — a later transition
     is never undone. Returns whether it reverted.
   lateFailMsg(step, title, {workerWrite}) -> string
     The toast for a background confirm that failed: "<step> “<title>” didn’t
     confirm — …". A step with {title} in it places the quoted title there ("Adding
     {title} to Eventbrite"); otherwise the title follows it. Edits and transitions
     say "open it and try again"; no step -> "The change didn’t confirm. Check again in a minute."; a Worker write (workerWrite: the Eventbrite side
     already happened) says "check it again in a minute". */
(function (root) {
  const ALIASES = { notes: 'planning', attendance: 'attendees', publish: 'details', listing: 'details' };
  function sectionFromParam(id) {
    if (id == null || id === '') return 'details';
    return Object.prototype.hasOwnProperty.call(ALIASES, id) ? ALIASES[id] : id;
  }

  const str = v => (v == null ? '' : String(v).trim());
  // A plain YYYY-MM-DD (approvedAt) passes through; an ISO timestamp (lastEbPushAt,
  // lastPublishedAt) becomes its LOCAL date, not the UTC slice (an evening push in
  // New York is already tomorrow in UTC).
  const pad = n => String(n).padStart(2, '0');
  function localDay(s) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (isNaN(d.getTime())) return s.slice(0, 10);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function stepNotes(ev, opts) {
    ev = ev || {};
    const o = opts || {};
    const fmt = typeof o.fmtDate === 'function' ? o.fmtDate : s => s;
    const day = v => { const s = str(v); return s ? fmt(localDay(s)) : ''; };
    const draft = ev.origin === 'Eventbrite' ? 'Imported from Eventbrite' : str(ev.createdBy) ? 'by ' + str(ev.createdBy) : '';
    const approved = [str(ev.approvedBy) ? 'by ' + str(ev.approvedBy) : '', day(ev.approvedAt)].filter(Boolean).join(' · ');
    const eb = day(ev.lastEbPushAt);
    let pub = day(ev.lastPublishedAt);
    if (pub && o.registrants != null)
      pub += ' · ' + o.registrants + (o.capacity != null ? ' of ' + o.capacity : '') + ' registered';
    return [draft, '', approved, eb, pub, day(ev.date)];
  }

  const EB_LABELS = { title: 'Title', date: 'Date', start: 'Start time', end: 'End time', capacity: 'Capacity',
    publicDescription: 'Description', venue: 'Venue', publishState: 'Status on Eventbrite' };
  function updatedFromEbLine(ev, fmtDate) {
    const l = ev && ev.lastFromEb;
    if (!l || !str(l.at) || !Array.isArray(l.fields)) return '';
    const at = new Date(l.at).getTime();
    if (isNaN(at)) return '';
    const push = str(ev.lastEbPushAt) ? new Date(ev.lastEbPushAt).getTime() : NaN;
    if (!isNaN(push) && at <= push) return '';
    const names = l.fields.map(f => EB_LABELS[f]).filter(Boolean);
    if (!names.length) return '';
    const fmt = typeof fmtDate === 'function' ? fmtDate : s => s;
    return 'Updated from Eventbrite: ' + names.join(', ') + ' · ' + fmt(localDay(str(l.at)));
  }

  const needsApproval = ev => !!ev && ev.source === 'planning' && ev.status === 'proposed';

  function revertTransition(ev, prev, setStatus) {
    if (!ev || ev.status !== setStatus) return false;
    Object.assign(ev, prev);
    return true;
  }

  function lateFailMsg(step, title, opts) {
    if (!step) return 'The change didn’t confirm. Check again in a minute.';   // no step to name: the generic line
    const t = '“' + (title || 'an event') + '”';
    const what = step.includes('{title}') ? step.replace('{title}', t) : step + ' ' + t;
    return what + ' didn’t confirm — ' + (opts && opts.workerWrite ? 'check it again in a minute' : 'open it and try again');
  }

  root.PageRules = { sectionFromParam, stepNotes, updatedFromEbLine, needsApproval, revertTransition, lateFailMsg };
})(typeof globalThis !== 'undefined' ? globalThis : this);
