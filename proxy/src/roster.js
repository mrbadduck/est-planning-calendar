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

// One row per distinct CLAIMANT person across the event's slots. Slots + claims
// are rich Coda rows (relations as { rowId, name }), the shape the /slots route
// already reads. Person facts (canonical name, first email, member) come from the
// slim People projection; a claim whose person row is missing still shows, with
// the relation's display name and no email.
export function claimantRows(slots, claimsBySlot, peopleRows, cols) {
  const byPerson = new Map();
  for (const s of (slots || [])) {
    const sv = (s && s.values) || {};
    const slotInfo = { slotId: s.id, kind: plain(sv[SLOT_COLS.kind]) || '', label: plain(sv[SLOT_COLS.label]) || '' };
    for (const c of ((claimsBySlot && claimsBySlot[s.id]) || [])) {
      const cv = (c && c.values) || {};
      const pid = relId(cv[CLAIM_COLS.member]);
      if (!pid) continue;                                   // name-only cell: can't resolve, can't email
      let row = byPerson.get(pid);
      if (!row) {
        const p = personFacts((peopleRows || []).find((r) => r.id === pid) || null, cols);
        row = {
          key: `person:${pid}`, kind: 'claimant', orderId: null,
          name: p.name || relName(cv[CLAIM_COLS.member]) || '', email: p.email, orderStatus: null,
          tickets: [], claims: [], personId: pid, matched: !!p.personId, member: p.member,
        };
        byPerson.set(pid, row);
      }
      row.claims.push({ ...slotInfo, contribution: plain(cv[CLAIM_COLS.contributionDetail]) || '', qty: Number(plain(cv[CLAIM_COLS.qty])) || 1 });
    }
  }
  return [...byPerson.values()];
}

// Resolve each order to a person (email <-> All Emails) and fold matching
// claimants INTO the order row (match by personId, else by email). Claimants
// with no order are appended as their own rows. Orders keep the Eventbrite
// name — it's what the registrant typed for this event. Sorted by name.
export function mergeRoster(orders, claimants, peopleRows, cols) {
  const byPid = new Map(), byEmail = new Map();
  for (const c of (claimants || [])) {
    if (c.personId) byPid.set(c.personId, c);
    if (c.email) byEmail.set(c.email, c);
  }
  const used = new Set();
  const rows = (orders || []).map((o) => {
    const p = personFacts(o.email ? findPersonByEmail(peopleRows, o.email, cols) : null, cols);
    const row = { ...o, personId: p.personId, matched: !!p.personId, member: p.member };
    const c = (p.personId && byPid.get(p.personId)) || (o.email && byEmail.get(o.email)) || null;
    if (c) { row.claims = c.claims; used.add(c.key); }
    return row;
  });
  for (const c of (claimants || [])) if (!used.has(c.key)) rows.push(c);
  rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return rows;
}

export function rosterSummary(rows) {
  const s = { rows: 0, orders: 0, tickets: 0, claimants: 0, unregisteredClaimants: 0, members: 0, unmatched: 0, noEmail: 0 };
  for (const r of (rows || [])) {
    s.rows++;
    if (r.kind === 'order') {
      s.orders++;
      s.tickets += (r.tickets || []).reduce((n, t) => n + (Number(t.qty) || 0), 0);
      if (!r.matched) s.unmatched++;
    } else {
      s.unregisteredClaimants++;
    }
    if ((r.claims || []).length) s.claimants++;
    if (r.member) s.members++;
    if (!r.email) s.noEmail++;
  }
  return s;
}

// The whole pipeline: raw Eventbrite orders + this event's rich slot/claim rows +
// the slim People projection -> { rows, summary }.
export function buildRoster({ orders, slots, claimsBySlot, people, cols }) {
  const o = orderRows(orders);
  const c = claimantRows(slots, claimsBySlot, people, cols);
  const rows = mergeRoster(o, c, people, cols);
  return { rows, summary: rosterSummary(rows) };
}
