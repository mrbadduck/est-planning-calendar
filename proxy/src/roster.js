// Pure helpers for the lead-facing attendee ROSTER (plan app, Attendees section).
// No I/O — unit-tested. A roster row is one Eventbrite ORDER (the buyer) or one
// gather CLAIMANT with no matching order; both resolve to an EST person by
// email <-> People `All Emails` (the same rule Coda's Orders sync uses).
//
// PRIVACY: rows carry raw emails. This module only ever feeds the role-gated
// plan route; gather's member projection (gather.js) must never import it.
import { relId, relName, plain, findPersonByEmail } from './gather.js';
import { SLOT_COLS, CLAIM_COLS } from './coda-columns.js';

const normEmail = (e) => String(e || '').toLowerCase().trim();

// The facts the roster needs about one (slim) People row. `null` row -> empties,
// so callers can spread the result without null checks.
export function personFacts(row, cols) {
  if (!row) return { personId: null, name: '', email: '', member: false };
  const v = row.values || {};
  const em = v[cols.allEmails];
  const list = (em == null || em === '') ? [] : (Array.isArray(em) ? em : [em]);
  const am = v[cols.activeMember];
  return {
    personId: row.id,
    name: String(v[cols.fullName] || ''),
    email: normEmail(list[0] || ''),
    member: am === true || am === 'true',
  };
}

// One row per ACTIVE Eventbrite order (`GET /events/{id}/orders/?expand=attendees`).
// Tickets roll up by ticket class over the order's live attendees (one attendee
// = one ticket; a missing quantity counts as 1). Cancelled/refunded orders and
// attendees are dropped. Person fields start empty — mergeRoster resolves them.
export function orderRows(orders) {
  const out = [];
  for (const o of (orders || [])) {
    if (!o || o.id == null) continue;
    const st = String(o.status || '').toLowerCase();
    if (st === 'cancelled' || st === 'canceled' || st === 'refunded' || st === 'deleted') continue;
    const byClass = new Map();
    for (const a of (o.attendees || [])) {
      if (!a || a.cancelled || a.refunded) continue;
      const cls = String(a.ticket_class_name || 'Ticket');
      byClass.set(cls, (byClass.get(cls) || 0) + (Number(a.quantity) || 1));
    }
    const name = String(o.name || `${o.first_name || ''} ${o.last_name || ''}`).trim();
    out.push({
      key: `order:${o.id}`, kind: 'order', orderId: String(o.id),
      name, email: normEmail(o.email), orderStatus: st || 'placed',
      tickets: [...byClass].map(([cls, qty]) => ({ class: cls, qty })),
      claims: [], personId: null, matched: false, member: false,
    });
  }
  return out;
}
