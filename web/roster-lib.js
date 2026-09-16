/* Roster segments + mail helpers for the plan app's Attendees section.
   Plain script (no modules — the app is buildless): attaches `RosterLib` to
   globalThis, so app.js reads window.RosterLib and proxy/test can import the
   same file for side effects. Pure — no DOM, no fetch. */
(function (root) {
  // Fixed segments over roster rows ({ kind:'order'|'claimant', member, claims:[{slotId,label,kind}], email }).
  const SEGMENTS = [
    { id: 'all',                   label: 'All',                        test: () => true },
    { id: 'registered',            label: 'Registered',                 test: (r) => r.kind === 'order' },
    { id: 'unregisteredClaimants', label: 'Signed up, not registered',  test: (r) => r.kind === 'claimant' },
    { id: 'registeredNoClaim',     label: 'Registered, no sign-up',     test: (r) => r.kind === 'order' && !(r.claims || []).length },
    { id: 'members',               label: 'Members',                    test: (r) => !!r.member },
    { id: 'nonMembers',            label: 'Non-members',                test: (r) => !r.member },
  ];
  // One segment per distinct slot that appears in any row's claims (first-seen order).
  function slotSegments(rows) {
    const seen = new Map();
    for (const r of (rows || [])) for (const c of (r.claims || [])) if (c.slotId && !seen.has(c.slotId)) seen.set(c.slotId, c);
    return [...seen.values()].map((c) => ({
      id: 'slot:' + c.slotId, label: c.label || 'Slot', kind: c.kind || '',
      test: (r) => (r.claims || []).some((x) => x.slotId === c.slotId),
    }));
  }
  function segmentsFor(rows) { return SEGMENTS.concat(slotSegments(rows)); }
  function applySegment(rows, segs, id) {
    const s = (segs || []).find((x) => x.id === id) || SEGMENTS[0];
    return (rows || []).filter(s.test);
  }
  // Distinct, lowercased, non-blank addresses of the given rows.
  function emailsOf(rows) {
    return [...new Set((rows || []).map((r) => String((r && r.email) || '').trim().toLowerCase()).filter(Boolean))];
  }
  // mailto: links break past ~2k chars in some browsers/clients; past this the
  // UI disables Email and points at Copy instead.
  const MAILTO_MAX = 1900;
  function mailtoHref(emails, subject) {
    const list = (emails || []).map(encodeURIComponent).join(',');
    const href = 'mailto:?bcc=' + list + (subject ? '&subject=' + encodeURIComponent(subject) : '');
    return href.length > MAILTO_MAX ? null : href;
  }
  root.RosterLib = { SEGMENTS, segmentsFor, applySegment, emailsOf, mailtoHref, MAILTO_MAX };
})(typeof globalThis !== 'undefined' ? globalThis : this);
