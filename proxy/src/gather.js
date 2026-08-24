// Pure helpers for the gather (member sign-ups) backend. No I/O — unit-tested.

import { PLANNING_COLS, SLOT_COLS, CLAIM_COLS } from './coda-columns.js';

// How many claims a slot still wants. Never negative; oversubscription clamps to 0.
export function slotRemaining(neededQty, claims) {
  const filled = (claims || []).reduce((s, c) => s + (Number(c && c.qty) || 0), 0);
  return Math.max(0, (Number(neededQty) || 0) - filled);
}

// Validate + normalize a POST /claims body. Throws on missing slot.
export function validateClaimInput(body) {
  const b = body || {};
  if (!b.slot || typeof b.slot !== 'string') throw new Error('slot required');
  let qty = Math.floor(Number(b.qty));
  if (!Number.isFinite(qty) || qty < 1) qty = 1;
  if (qty > 20) qty = 20;                                  // sane upper bound
  return {
    slot: b.slot,
    qty,
    contributionDetail: String(b.contributionDetail || '').trim(),
    notes: String(b.notes || '').trim(),
  };
}

// Project a planning-event row to the PUBLIC, member-safe shape. This is an
// allowlist: only these fields ever leave the Worker to a member. Internal fields
// (Planning Notes, Event Description, attribution, publish internals, etc.) must
// NEVER appear. `slots` = the event's slot rows; `claimsBySlot` maps slotId ->
// array of that slot's claim rows; `callerName` drives `mineClaimed`.
export function projectEventForMember(row, slots, claimsBySlot, callerName, opts = {}) {
  const v = (row && row.values) || {};
  return {
    id: row && row.id,
    title: v[PLANNING_COLS.title] || '',
    scheduling: v[PLANNING_COLS.scheduling] || null,
    date: v[PLANNING_COLS.date] || null,
    start: v[PLANNING_COLS.start] || null,
    end: v[PLANNING_COLS.end] || null,
    allDay: v[PLANNING_COLS.allDay] === true || v[PLANNING_COLS.allDay] === 'true',
    windowStart: v[PLANNING_COLS.windowStart] || null,
    windowEnd: v[PLANNING_COLS.windowEnd] || null,
    summary: v[PLANNING_COLS.publicSummary] || '',
    description: v[PLANNING_COLS.publicDescription] || '',
    location: v[PLANNING_COLS.venue] || v[PLANNING_COLS.venueOther] || '',      // coarse: venue name/other, no street address
    eventbriteUrl: v[PLANNING_COLS.eventbriteUrl] || '',
    slots: (slots || []).map((s) => {
      const sv = (s && s.values) || {};
      const claimRows = (claimsBySlot && claimsBySlot[s.id]) || [];
      const claims = claimRows.map((c) => ({
        name: (c.values && c.values[CLAIM_COLS.member]) || '',
        contribution: (c.values && c.values[CLAIM_COLS.contributionDetail]) || '',
        qty: Number(c.values && c.values[CLAIM_COLS.qty]) || 1,
      }));
      const slotObj = {
        id: s.id,
        kind: sv[SLOT_COLS.kind] || null,
        label: sv[SLOT_COLS.label] || '',
        neededQty: Number(sv[SLOT_COLS.neededQty]) || 0,
        sortOrder: Number(sv[SLOT_COLS.sortOrder]) || 0,
        remaining: slotRemaining(sv[SLOT_COLS.neededQty], claims),
        mineClaimed: !!callerName && claims.some((c) => c.name === callerName),
      };
      if (opts.includeClaimants) slotObj.claims = claims;   // detail view only
      return slotObj;
    }).sort((a, b) => a.sortOrder - b.sortOrder),
  };
}
