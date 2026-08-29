// Pure helpers for the gather (member sign-ups) backend. No I/O — unit-tested.

import { PLANNING_COLS, SLOT_COLS, CLAIM_COLS } from './coda-columns.js';

// --- Coda relation-cell coercion -------------------------------------------
// Coda's `rich` valueFormat returns TEXT as markdown: plain strings come back
// fenced in triple backticks (```Main dish```) with markdown punctuation
// backslash-escaped. stripRich undoes that encoding so callers always see the
// raw text; non-strings pass through untouched.
export function stripRich(s) {
  if (typeof s !== 'string') return s;
  let t = s;
  const m = /^```([\s\S]*)```$/.exec(t);
  if (m) t = m[1];
  return t.replace(/\\([\\`*_~[\]()#+\-.!>|{}])/g, '$1');
}

// A relation cell reads back one of two ways depending on valueFormat:
//   simpleWithArrays -> a display-name string (or array of them)
//   rich (default)   -> a { rowId, name, ... } row-reference object (or array)
// relName extracts the first DISPLAY NAME (cosmetic use), relId the first ROW ID
// (grouping + the security-critical ownership check). relId returns null for a
// name-only cell so an id comparison can never silently pass on a display name.
export function relName(cell) {
  const first = Array.isArray(cell) ? cell[0] : cell;
  if (first && typeof first === 'object') return stripRich(first.name || '');
  return first == null ? '' : stripRich(String(first));
}
export function relId(cell) {
  const first = Array.isArray(cell) ? cell[0] : cell;
  if (first && typeof first === 'object') return first.rowId || first.id || null;
  return null;
}
// Coerce any cell (rich object, array, or primitive) to a plain scalar. Rich reads
// can wrap even non-relation values ({ name } for selects, { value } for some
// formats); this unwraps them so the projection sees primitives. Arrays -> first.
export function plain(cell) {
  const f = Array.isArray(cell) ? cell[0] : cell;
  if (f && typeof f === 'object') return stripRich(f.name !== undefined ? f.name : (f.value !== undefined ? f.value : ''));
  return f == null ? '' : stripRich(f);
}

// --- People slim projection --------------------------------------------------
// The People table is 1128 rows x ~50 cols — the auth/member/picker paths read
// only three columns. Project rows down to those (same id-keyed row shape, so
// findPersonByEmail/resolvePerson work unchanged) before caching: the snapshot
// stays ~100KB instead of multi-MB.
export function slimPeopleRows(rows, cols) {
  return (rows || []).map((r) => ({
    id: r.id,
    values: {
      [cols.fullName]: (r.values && r.values[cols.fullName]) || '',
      [cols.firstName]: (r.values && r.values[cols.firstName]) || '',
      [cols.lastName]: (r.values && r.values[cols.lastName]) || '',
      [cols.allEmails]: (r.values && r.values[cols.allEmails]) || [],
      [cols.leadershipStatus]: (r.values && r.values[cols.leadershipStatus]) || [],
    },
  }));
}

// Member-facing display name — never the full name. "First L." when we have
// name parts (or can split a spaced full name); people rows self-onboarded via
// email often have the address in Full Name and empty first/last, so a
// single-token or blank name falls back to a friendly placeholder.
export function friendlyName(first, last, full) {
  const f = String(first || '').trim(), l = String(last || '').trim(), n = String(full || '').trim();
  if (f && l) return `${f} ${l[0].toUpperCase()}.`;
  if (f) return f;
  const parts = n.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
  return 'Anonymous Neighbor';
}

// --- People find-or-create (open signup) -----------------------------------
// Split a display name: first = first token, last = the rest.
export function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: '', last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

// Find the People row whose All Emails contains `email` (lowercased). rows are
// id-keyed (byId read); returns the row or null.
export function findPersonByEmail(rows, email, cols) {
  const want = String(email || '').toLowerCase();
  if (!want) return null;
  return (rows || []).find((r) => {
    const em = r && r.values && r.values[cols.allEmails];
    const list = (em == null || em === '') ? [] : (Array.isArray(em) ? em : [em]);
    return list.some((x) => String(x).toLowerCase() === want);
  }) || null;
}

// Cells to create a self-onboarded People row. Email is the writable manual-input
// column (All Emails is a formula that combines it, so future matches then work).
// The Notes marker is how admins spot auto-created rows (no dedicated Source col).
export function personCreateCells(email, name, cols, todayISO) {
  const { first, last } = splitName(name);
  const full = String(name || '').trim() || String(email || '');
  return [
    { column: cols.fullName, value: full },
    { column: cols.firstName, value: first },
    { column: cols.lastName, value: last },
    { column: cols.emailManual, value: String(email || '').toLowerCase() },
    { column: cols.notes, value: `Self-onboarded via gather ${String(todayISO || '').slice(0, 10)}` },
  ];
}

// --- Claims ------------------------------------------------------------------
// Cells to insert a claim. Relations (slot, member) are written as ROW IDS.
// `input` is the output of validateClaimInput; `memberId` is the caller's person id.
export function claimCreateCells(input, memberId, cols) {
  const cells = [
    { column: cols.slot, value: [input.slot] },
    { column: cols.member, value: [memberId] },
    { column: cols.qty, value: input.qty },
  ];
  if (input.contributionDetail) cells.push({ column: cols.contributionDetail, value: input.contributionDetail });
  if (input.notes) cells.push({ column: cols.notes, value: input.notes });
  return cells;
}

// SECURITY: the person id that owns a claim row. The row MUST have been read rich
// (relations as objects) so this compares ids, never spoofable display names.
export function claimOwnerId(claimRow, cols) {
  return relId(claimRow && claimRow.values && claimRow.values[cols.member]);
}

// --- Slots (lead builder) ----------------------------------------------------
// Cells to create/update a slot. On create pass { withEvent:true } to write the
// Event relation (row id); update omits it. Only provided fields are written.
export function slotCells(input, cols, opts = {}) {
  const b = input || {};
  const cells = [];
  if (opts.withEvent && b.event) cells.push({ column: cols.event, value: [b.event] });
  if (b.kind != null) cells.push({ column: cols.kind, value: b.kind });
  if (b.label != null) cells.push({ column: cols.label, value: String(b.label) });
  if (b.neededQty != null) cells.push({ column: cols.neededQty, value: Number(b.neededQty) || 0 });
  if (b.sortOrder != null) cells.push({ column: cols.sortOrder, value: Number(b.sortOrder) || 0 });
  return cells;
}

// --- Published + upcoming filter for the member home list --------------------
// A planning row (id-keyed values) is visible to members when Published? is true,
// its Status isn't Cancelled, AND its effective date is today or later. The
// Cancelled guard matters because cancelling tears down the Eventbrite listing
// but leaves the Published? checkbox set — without it a cancelled-after-publish
// event would keep showing to members. Effective date = exact Date, else the
// range window end/start, else the Month date. Undated published rows are kept
// (shown) rather than hidden. `todayISO` = 'YYYY-MM-DD'.
export function isPublishedUpcoming(row, cols, todayISO) {
  const v = (row && row.values) || {};
  const pub = plain(v[cols.published]);
  if (!(pub === true || pub === 'true')) return false;
  if (String(plain(v[cols.status])).toLowerCase() === 'cancelled') return false;
  return effectiveUpcoming(v, cols, todayISO);
}

// Planner preview: an APPROVED row that isn't published yet, same upcoming
// window. Only ever shown to write-authorized callers (leads/council) so they
// can see the member-facing sheet before publishing.
export function isApprovedUpcoming(row, cols, todayISO) {
  const v = (row && row.values) || {};
  if (String(plain(v[cols.status])).toLowerCase() !== 'approved') return false;
  return effectiveUpcoming(v, cols, todayISO);
}

// Effective date = exact Date, else the range window end/start, else the Month
// date. Undated rows are kept (shown) rather than hidden.
function effectiveUpcoming(v, cols, todayISO) {
  const eff = plain(v[cols.date]) || plain(v[cols.windowEnd]) || plain(v[cols.windowStart]) || null;
  if (!eff) return true;
  return String(eff).slice(0, 10) >= String(todayISO).slice(0, 10);
}

// How many claims a slot still wants. Never negative; oversubscription clamps to 0.
export function slotRemaining(neededQty, claims) {
  const filled = (claims || []).reduce((s, c) => s + (Number(c && c.qty) || 0), 0);
  return Math.max(0, (Number(neededQty) || 0) - filled);
}

// Validate + normalize a POST /claims body. Throws on missing slot. `member`
// (a People row id) is only honored by the Worker for write-authorized callers
// — a lead signing someone else up from the plan-side builder.
export function validateClaimInput(body) {
  const b = body || {};
  if (!b.slot || typeof b.slot !== 'string') throw new Error('slot required');
  return {
    slot: b.slot,
    qty: clampQty(b.qty),
    contributionDetail: String(b.contributionDetail || '').trim(),
    notes: String(b.notes || '').trim(),
    member: (typeof b.member === 'string' && b.member) || '',
  };
}
function clampQty(q) {
  let qty = Math.floor(Number(q));
  if (!Number.isFinite(qty) || qty < 1) qty = 1;
  if (qty > 20) qty = 20;                                  // sane upper bound
  return qty;
}

// Cells for a PUT /claims/:id patch (qty + contribution only — the slot and
// member relations are immutable; delete + re-add to move a claim).
export function claimUpdateCells(body, cols) {
  const b = body || {};
  return [
    { column: cols.qty, value: clampQty(b.qty) },
    { column: cols.contributionDetail, value: String(b.contributionDetail || '').trim() },
  ];
}

// Project a planning-event row to the PUBLIC, member-safe shape. This is an
// allowlist: only these fields ever leave the Worker to a member. Internal fields
// (Planning Notes, Event Description, attribution, publish internals, etc.) must
// NEVER appear. `slots` = the event's slot rows; `claimsBySlot` maps slotId ->
// array of that slot's claim rows; `callerName` (+ opts.callerId, preferred when
// present) drives `mineClaimed`. In the detail view (includeClaimants) each claim
// carries `mine`, and the caller's OWN claim also carries its `claimId` (safe to
// expose — it's the member's own row — and needed for unclaim).
export function projectEventForMember(row, slots, claimsBySlot, callerName, opts = {}) {
  const callerId = opts.callerId || null;
  const v = (row && row.values) || {};
  const ad = plain(v[PLANNING_COLS.allDay]);
  return {
    id: row && row.id,
    ...(opts.preview ? { preview: true } : {}),   // approved-but-unpublished, planner eyes only
    title: plain(v[PLANNING_COLS.title]) || '',
    scheduling: plain(v[PLANNING_COLS.scheduling]) || null,
    date: plain(v[PLANNING_COLS.date]) || null,
    start: plain(v[PLANNING_COLS.start]) || null,
    end: plain(v[PLANNING_COLS.end]) || null,
    allDay: ad === true || ad === 'true',
    windowStart: plain(v[PLANNING_COLS.windowStart]) || null,
    windowEnd: plain(v[PLANNING_COLS.windowEnd]) || null,
    summary: plain(v[PLANNING_COLS.publicSummary]) || '',
    description: plain(v[PLANNING_COLS.publicDescription]) || '',
    location: relName(v[PLANNING_COLS.venue]) || relName(v[PLANNING_COLS.venueOther]) || '',   // coarse: venue name/other, no street address
    eventbriteUrl: plain(v[PLANNING_COLS.eventbriteUrl]) || '',
    // hasSlots lets a signed-out browser show the "sign in to volunteer" CTA;
    // opts.anonymous strips the sheet itself (labels, counts, claimants) —
    // slot details are for signed-in members only.
    hasSlots: (slots || []).length > 0,
    slots: opts.anonymous ? [] : (slots || []).map((s) => {
      const sv = (s && s.values) || {};
      const claimRows = (claimsBySlot && claimsBySlot[s.id]) || [];
      const claims = claimRows.map((c) => {
        const rawName = relName(c.values && c.values[CLAIM_COLS.member]);   // name-string OR rich {name}
        const memberId = relId(c.values && c.values[CLAIM_COLS.member]);
        const mine = (callerId && memberId === callerId)
          || (!callerId && !!callerName && rawName === callerName);          // mine matches on the RAW name
        const o = {
          // opts.nameOf maps a member to their member-safe display form ("First
          // L." / placeholder) — full names must not reach other members.
          name: opts.nameOf ? opts.nameOf(memberId, rawName) : rawName,
          contribution: plain(c.values && c.values[CLAIM_COLS.contributionDetail]) || '',
          qty: Number(plain(c.values && c.values[CLAIM_COLS.qty])) || 1,
          mine,
        };
        if (mine && c && c.id) o.claimId = c.id;   // only the caller's own claim id is ever exposed
        return o;
      });
      const needed = Number(plain(sv[SLOT_COLS.neededQty])) || 0;
      const slotObj = {
        id: s.id,
        kind: plain(sv[SLOT_COLS.kind]) || null,
        label: plain(sv[SLOT_COLS.label]) || '',
        neededQty: needed,
        sortOrder: Number(plain(sv[SLOT_COLS.sortOrder])) || 0,
        remaining: slotRemaining(needed, claims),
        mineClaimed: claims.some((c) => c.mine),
      };
      if (opts.includeClaimants) slotObj.claims = claims;   // detail view only
      return slotObj;
    }).sort((a, b) => a.sortOrder - b.sortOrder),
  };
}
