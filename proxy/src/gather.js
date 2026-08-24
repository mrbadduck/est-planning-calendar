// Pure helpers for the gather (member sign-ups) backend. No I/O — unit-tested.

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
    title: v['Title'] || '',
    scheduling: v['Scheduling'] || null,
    date: v['Date'] || null,
    start: v['Start'] || null,
    end: v['End'] || null,
    allDay: v['All day'] === true || v['All day'] === 'true',
    windowStart: v['Window start'] || null,
    windowEnd: v['Window end'] || null,
    summary: v['Public summary'] || '',
    description: v['Public description'] || '',
    location: v['Venue'] || v['Venue (other)'] || '',      // coarse: venue name/other, no street address
    eventbriteUrl: v['Eventbrite URL'] || '',
    slots: (slots || []).map((s) => {
      const sv = (s && s.values) || {};
      const claimRows = (claimsBySlot && claimsBySlot[s.id]) || [];
      const claims = claimRows.map((c) => ({
        name: (c.values && c.values['Member']) || '',
        contribution: (c.values && c.values['Contribution detail']) || '',
        qty: Number(c.values && c.values['Qty']) || 1,
      }));
      const slotObj = {
        id: s.id,
        kind: sv['Kind'] || null,
        label: sv['Label'] || '',
        neededQty: Number(sv['Needed qty']) || 0,
        sortOrder: Number(sv['Sort order']) || 0,
        remaining: slotRemaining(sv['Needed qty'], claims),
        mineClaimed: !!callerName && claims.some((c) => c.name === callerName),
      };
      if (opts.includeClaimants) slotObj.claims = claims;   // detail view only
      return slotObj;
    }).sort((a, b) => a.sortOrder - b.sortOrder),
  };
}
