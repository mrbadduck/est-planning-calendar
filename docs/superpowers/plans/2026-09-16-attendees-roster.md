# Attendees Roster + Registrant Comms (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give program leads a live per-event roster (Eventbrite orders ∪ gather claimants, resolved to EST people, with an active-member badge), segment filters, and Copy emails / mailto BCC actions, in a new **Attendees** section of the plan app's event workspace.

**Architecture:** One new role-gated Worker route `GET /roster/:rowId` composes Eventbrite orders (live, paged), the event's gather slots + claims (Coda), and the cached slim People projection (now carrying `Active Member?`) through pure helpers in `proxy/src/roster.js`, KV-cached per event. The plan app renders the roster read-only; segments and the mailto guard are pure functions in `web/roster-lib.js` (a plain script that also loads under `node --test`). Gather's member projection is untouched and stays email-free.

**Tech Stack:** Cloudflare Worker (ESM, `node --test` for pure modules), Coda REST (id-keyed rich reads), Eventbrite v3 (`/events/{id}/orders/?expand=attendees`), buildless vanilla JS + CSS in `web/`.

**Spec:** `docs/superpowers/specs/2026-09-16-attendees-roster-design.md`

**Branch:** `feat/attendees-roster` (already created; spec committed on it).

**Deploy posture (Eric's standing preference):** local first — `npm test` in `proxy/`, `wrangler dev`, `live-server`. One Worker deploy at the end for the live check. Netlify deploys on merge; don't merge to `main` until the Worker is live.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `proxy/src/coda-columns.js` | modify | add `PEOPLE_COLS.activeMember` (`c-yJfWc0GMsQ`, "Active Member?") |
| `proxy/src/gather.js` | modify | `slimPeopleRows` projects `activeMember` |
| `proxy/test/gather.test.js` | modify | slim-shape test covers the new field; member-projection email-free assertion |
| `proxy/src/roster.js` | create | pure roster builders: `personFacts`, `orderRows`, `claimantRows`, `mergeRoster`, `rosterSummary`, `buildRoster` |
| `proxy/test/roster.test.js` | create | unit tests for every roster helper |
| `proxy/src/worker.js` | modify | `PEOPLE_KV_KEY` bump; `GET /roster/:rowId`; `ebAllOrders`; `rosterKvKey`; `bustRosterForSlot` wired into claim writes; header route list |
| `web/roster-lib.js` | create | `RosterLib` global: segments, `emailsOf`, `mailtoHref` (+ node-testable) |
| `proxy/test/roster-lib.test.js` | create | tests for `RosterLib` (imports `../../web/roster-lib.js`) |
| `web/index.html` | modify | load `roster-lib.js` before `app.js` |
| `web/app.js` | modify | `SECTIONS` (`attendees` live), `sectionId` alias, `DB.roster`, `renderAttendees` / `wireAttendees`, `fmtAgo`, `renderSection` dispatch |
| `web/styles.css` | modify | `.roster-*` styles + table badges |
| `CLAUDE.md`, `proxy/README.md` | modify | document the new section + route |
| `.claude/launch.json` | modify | add a `proxy` config (`wrangler dev`) for local verification |

---

### Task 1: Project `Active Member?` into the slim People snapshot

**Files:**
- Modify: `proxy/src/coda-columns.js:44-52` (`PEOPLE_COLS`)
- Modify: `proxy/src/gather.js:47-58` (`slimPeopleRows`)
- Modify: `proxy/src/worker.js:882` (`PEOPLE_KV_KEY`)
- Test: `proxy/test/gather.test.js:144-168`

- [ ] **Step 1: Extend the slim-shape test to expect `activeMember`**

In `proxy/test/gather.test.js`, replace the whole `slimPeopleRows keeps only the auth/picker columns` test with:

```js
test('slimPeopleRows keeps only the auth/picker/roster columns, same row shape', () => {
  const rows = [
    { id: 'i-a', values: {
      [PEOPLE_COLS.fullName]: 'Leah Cohen',
      [PEOPLE_COLS.firstName]: 'Leah',
      [PEOPLE_COLS.lastName]: 'Cohen',
      [PEOPLE_COLS.allEmails]: ['leah@x.com'],
      [PEOPLE_COLS.leadershipStatus]: ['Tribal Council'],
      [PEOPLE_COLS.activeMember]: true,
      'c-something-huge': 'FIFTY OTHER COLUMNS OF PAYLOAD',
    } },
    { id: 'i-b', values: {} },   // sparse row -> safe defaults
  ];
  const slim = slimPeopleRows(rows, PEOPLE_COLS);
  assert.deepEqual(slim[0], { id: 'i-a', values: {
    [PEOPLE_COLS.fullName]: 'Leah Cohen',
    [PEOPLE_COLS.firstName]: 'Leah',
    [PEOPLE_COLS.lastName]: 'Cohen',
    [PEOPLE_COLS.allEmails]: ['leah@x.com'],
    [PEOPLE_COLS.leadershipStatus]: ['Tribal Council'],
    [PEOPLE_COLS.activeMember]: true,
  } });
  assert.deepEqual(slim[1], { id: 'i-b', values: { [PEOPLE_COLS.fullName]: '', [PEOPLE_COLS.firstName]: '', [PEOPLE_COLS.lastName]: '', [PEOPLE_COLS.allEmails]: [], [PEOPLE_COLS.leadershipStatus]: [], [PEOPLE_COLS.activeMember]: false } });
  assert.ok(!JSON.stringify(slim).includes('FIFTY OTHER'));
  // the slim shape still feeds the existing matcher unchanged
  assert.equal(findPersonByEmail(slim, 'LEAH@x.com', PEOPLE_COLS).id, 'i-a');
});

test('slimPeopleRows coerces a string "true" Active Member? cell to a boolean', () => {
  const slim = slimPeopleRows([{ id: 'i-c', values: { [PEOPLE_COLS.activeMember]: 'true' } }], PEOPLE_COLS);
  assert.equal(slim[0].values[PEOPLE_COLS.activeMember], true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd proxy && node --test test/gather.test.js 2>&1 | tail -20`
Expected: FAIL — `slimPeopleRows keeps only…` (the `activeMember` key is missing from the projection because `PEOPLE_COLS.activeMember` is undefined).

- [ ] **Step 3: Add the column id and project it**

In `proxy/src/coda-columns.js`, inside `PEOPLE_COLS` after the `notes` line add:

```js
  activeMember:     'c-yJfWc0GMsQ', // Active Member? (formula: any active Givebutter plan — Coda owns the rule)
```

In `proxy/src/gather.js`, replace `slimPeopleRows` with:

```js
export function slimPeopleRows(rows, cols) {
  return (rows || []).map((r) => {
    const am = r.values && r.values[cols.activeMember];
    return {
      id: r.id,
      values: {
        [cols.fullName]: (r.values && r.values[cols.fullName]) || '',
        [cols.firstName]: (r.values && r.values[cols.firstName]) || '',
        [cols.lastName]: (r.values && r.values[cols.lastName]) || '',
        [cols.allEmails]: (r.values && r.values[cols.allEmails]) || [],
        [cols.leadershipStatus]: (r.values && r.values[cols.leadershipStatus]) || [],
        [cols.activeMember]: am === true || am === 'true',   // roster badge; Coda formula column
      },
    };
  });
}
```

Update the comment above it: change `read only three columns` to `read only a handful of columns`.

In `proxy/src/worker.js`, change:

```js
const PEOPLE_KV_KEY = 'people-slim-v2';   // v2: + first/last name (bump on any slim-shape change)
```
to
```js
const PEOPLE_KV_KEY = 'people-slim-v3';   // v3: + Active Member? (bump on any slim-shape change)
```

- [ ] **Step 4: Run the tests**

Run: `cd proxy && npm test 2>&1 | tail -8`
Expected: all pass (`# fail 0`).

- [ ] **Step 5: Commit**

```bash
git add proxy/src/coda-columns.js proxy/src/gather.js proxy/src/worker.js proxy/test/gather.test.js
git commit -m "feat(proxy): project Active Member? into the slim People snapshot

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `roster.js` — order rows + person facts

**Files:**
- Create: `proxy/src/roster.js`
- Create: `proxy/test/roster.test.js`

- [ ] **Step 1: Write the failing tests**

Create `proxy/test/roster.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personFacts, orderRows } from '../src/roster.js';
import { PEOPLE_COLS } from '../src/coda-columns.js';

const person = (id, name, emails, member) => ({ id, values: {
  [PEOPLE_COLS.fullName]: name, [PEOPLE_COLS.allEmails]: emails, [PEOPLE_COLS.activeMember]: member,
} });

test('personFacts: id, name, first email (lowercased), member flag; null row -> empty facts', () => {
  assert.deepEqual(personFacts(person('i-a', 'Dana Levy', ['Dana@X.com', 'd2@x.com'], true), PEOPLE_COLS),
    { personId: 'i-a', name: 'Dana Levy', email: 'dana@x.com', member: true });
  assert.deepEqual(personFacts(person('i-b', 'No Mail', [], 'true'), PEOPLE_COLS),
    { personId: 'i-b', name: 'No Mail', email: '', member: true });
  assert.deepEqual(personFacts(null, PEOPLE_COLS), { personId: null, name: '', email: '', member: false });
});

test('orderRows: one row per active order, tickets rolled up by class, email lowercased', () => {
  const rows = orderRows([
    { id: '101', name: 'Dana Levy', email: 'Dana@X.com', status: 'placed', attendees: [
      { ticket_class_name: 'General Admission', quantity: 1 },
      { ticket_class_name: 'General Admission', quantity: 1 },
      { ticket_class_name: 'Kids', quantity: 1 },
      { ticket_class_name: 'Kids', quantity: 1, cancelled: true },   // excluded
    ] },
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    key: 'order:101', kind: 'order', orderId: '101', name: 'Dana Levy', email: 'dana@x.com', orderStatus: 'placed',
    tickets: [{ class: 'General Admission', qty: 2 }, { class: 'Kids', qty: 1 }],
    claims: [], personId: null, matched: false, member: false,
  });
});

test('orderRows: skips cancelled/refunded orders; falls back to first+last name; blank email stays blank', () => {
  const rows = orderRows([
    { id: '1', name: 'Gone', email: 'g@x.com', status: 'cancelled', attendees: [] },
    { id: '2', name: 'Money Back', email: 'm@x.com', status: 'refunded', attendees: [] },
    { id: '3', first_name: 'At The', last_name: 'Door', email: '', status: 'placed', attendees: [{ ticket_class_name: 'GA' }] },
    null,
  ]);
  assert.deepEqual(rows.map((r) => r.orderId), ['3']);
  assert.equal(rows[0].name, 'At The Door');
  assert.equal(rows[0].email, '');
  assert.deepEqual(rows[0].tickets, [{ class: 'GA', qty: 1 }]);   // missing quantity counts as 1
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd proxy && node --test test/roster.test.js 2>&1 | head -5`
Expected: FAIL — `Cannot find module '.../src/roster.js'`.

- [ ] **Step 3: Create `proxy/src/roster.js` with `personFacts` and `orderRows`**

```js
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
```

- [ ] **Step 4: Run the tests**

Run: `cd proxy && node --test test/roster.test.js 2>&1 | tail -6`
Expected: 3 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add proxy/src/roster.js proxy/test/roster.test.js
git commit -m "feat(proxy): roster helpers — personFacts + orderRows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: `roster.js` — claimant rows

**Files:**
- Modify: `proxy/src/roster.js`
- Test: `proxy/test/roster.test.js`

- [ ] **Step 1: Write the failing test**

Append to `proxy/test/roster.test.js` (and add `claimantRows` to the roster import line, plus `SLOT_COLS, CLAIM_COLS` to the coda-columns import):

```js
const slot = (id, kind, label) => ({ id, values: { [SLOT_COLS.kind]: kind, [SLOT_COLS.label]: label } });
const claim = (memberId, memberName, contribution, qty) => ({ id: 'i-c' + Math.random(), values: {
  [CLAIM_COLS.member]: { rowId: memberId, name: memberName }, [CLAIM_COLS.contributionDetail]: contribution, [CLAIM_COLS.qty]: qty,
} });

test('claimantRows: one row per distinct claimant person, claims grouped, person facts from People', () => {
  const slots = [slot('i-s1', 'Potluck', 'Dessert'), slot('i-s2', 'Volunteer', 'Setup')];
  const claimsBySlot = {
    'i-s1': [claim('i-p1', 'Dana Levy', 'kugel', 1), claim('i-p2', 'Ari Gold', 'cookies', 2)],
    'i-s2': [claim('i-p1', 'Dana Levy', '', 1)],
  };
  const people = [person('i-p1', 'Dana Levy', ['dana@x.com'], true)];   // i-p2 has no People row -> unmatched
  const rows = claimantRows(slots, claimsBySlot, people, PEOPLE_COLS);
  assert.equal(rows.length, 2);
  const dana = rows.find((r) => r.personId === 'i-p1');
  assert.deepEqual(dana, {
    key: 'person:i-p1', kind: 'claimant', orderId: null, name: 'Dana Levy', email: 'dana@x.com', orderStatus: null,
    tickets: [], personId: 'i-p1', matched: true, member: true,
    claims: [
      { slotId: 'i-s1', kind: 'Potluck', label: 'Dessert', contribution: 'kugel', qty: 1 },
      { slotId: 'i-s2', kind: 'Volunteer', label: 'Setup', contribution: '', qty: 1 },
    ],
  });
  const ari = rows.find((r) => r.personId === 'i-p2');
  assert.equal(ari.name, 'Ari Gold');       // falls back to the relation's display name
  assert.equal(ari.email, '');
  assert.equal(ari.matched, false);
  assert.equal(ari.member, false);
  assert.equal(ari.claims[0].qty, 2);
});

test('claimantRows: a claim with no member relation id is skipped; no slots -> []', () => {
  const rows = claimantRows([slot('i-s1', 'Potluck', 'Dessert')], { 'i-s1': [{ values: { [CLAIM_COLS.member]: 'Name Only' } }] }, [], PEOPLE_COLS);
  assert.deepEqual(rows, []);
  assert.deepEqual(claimantRows([], {}, [], PEOPLE_COLS), []);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd proxy && node --test test/roster.test.js 2>&1 | grep -E "^# (pass|fail)|SyntaxError"`
Expected: a SyntaxError (`claimantRows` is not exported).

- [ ] **Step 3: Implement `claimantRows`**

Append to `proxy/src/roster.js`:

```js
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
```

- [ ] **Step 4: Run the tests**

Run: `cd proxy && node --test test/roster.test.js 2>&1 | tail -6`
Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add proxy/src/roster.js proxy/test/roster.test.js
git commit -m "feat(proxy): roster helpers — claimantRows

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `roster.js` — merge, summary, `buildRoster`

**Files:**
- Modify: `proxy/src/roster.js`
- Test: `proxy/test/roster.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `proxy/test/roster.test.js` (add `mergeRoster, rosterSummary, buildRoster` to the roster import):

```js
test('mergeRoster: orders resolve to people by email; a claimant matching by personId or email merges in; leftovers append', () => {
  const people = [
    person('i-p1', 'Dana Levy', ['dana@x.com', 'dana-alt@x.com'], true),
    person('i-p2', 'Ari Gold', ['ari@x.com'], false),
    person('i-p3', 'Noa Peretz', ['noa@x.com'], false),
  ];
  const orders = orderRows([
    { id: '1', name: 'D. Levy', email: 'DANA-ALT@x.com', status: 'placed', attendees: [{ ticket_class_name: 'GA' }] },   // matches i-p1 via alt email
    { id: '2', name: 'Stranger', email: 'who@x.com', status: 'placed', attendees: [{ ticket_class_name: 'GA' }] },       // unmatched
    { id: '3', name: 'Ari Gold', email: 'ari@x.com', status: 'placed', attendees: [{ ticket_class_name: 'GA' }] },
  ]);
  const claimants = [
    { key: 'person:i-p1', kind: 'claimant', orderId: null, name: 'Dana Levy', email: 'dana@x.com', orderStatus: null, tickets: [], personId: 'i-p1', matched: true, member: true,
      claims: [{ slotId: 'i-s1', kind: 'Potluck', label: 'Dessert', contribution: 'kugel', qty: 1 }] },
    { key: 'person:i-p3', kind: 'claimant', orderId: null, name: 'Noa Peretz', email: 'noa@x.com', orderStatus: null, tickets: [], personId: 'i-p3', matched: true, member: false,
      claims: [{ slotId: 'i-s2', kind: 'Volunteer', label: 'Setup', contribution: '', qty: 1 }] },
  ];
  const rows = mergeRoster(orders, claimants, people, PEOPLE_COLS);
  assert.deepEqual(rows.map((r) => r.key), ['order:3', 'order:1', 'person:i-p3', 'order:2']);   // sorted by name: Ari, D. Levy, Noa, Stranger
  const dana = rows.find((r) => r.key === 'order:1');
  assert.equal(dana.name, 'D. Levy');                  // orders keep the Eventbrite name (what they typed for THIS event)
  assert.equal(dana.personId, 'i-p1');
  assert.equal(dana.matched, true);
  assert.equal(dana.member, true);
  assert.equal(dana.claims.length, 1);                 // claimant merged into the order row
  assert.ok(!rows.some((r) => r.key === 'person:i-p1'));   // ...and not duplicated
  const ari = rows.find((r) => r.key === 'order:3');
  assert.deepEqual([ari.personId, ari.matched, ari.member, ari.claims], ['i-p2', true, false, []]);
  const stranger = rows.find((r) => r.key === 'order:2');
  assert.deepEqual([stranger.personId, stranger.matched, stranger.member], [null, false, false]);
  const noa = rows.find((r) => r.key === 'person:i-p3');
  assert.equal(noa.kind, 'claimant');
});

test('mergeRoster: a claimant with no People row still merges into an order by email', () => {
  const orders = orderRows([{ id: '9', name: 'Ghost', email: 'ghost@x.com', status: 'placed', attendees: [] }]);
  const claimants = [{ key: 'person:i-zz', kind: 'claimant', orderId: null, name: 'Ghost', email: 'ghost@x.com', orderStatus: null, tickets: [], personId: 'i-zz', matched: false, member: false, claims: [{ slotId: 'i-s1', kind: 'Potluck', label: 'Salad', contribution: '', qty: 1 }] }];
  const rows = mergeRoster(orders, claimants, [], PEOPLE_COLS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].claims.length, 1);
});

test('rosterSummary counts orders, tickets, claimants, unregistered, members, unmatched, noEmail', () => {
  const rows = [
    { kind: 'order', email: 'a@x', tickets: [{ class: 'GA', qty: 2 }], claims: [{}], matched: true, member: true },
    { kind: 'order', email: '', tickets: [{ class: 'GA', qty: 1 }], claims: [], matched: false, member: false },
    { kind: 'claimant', email: 'c@x', tickets: [], claims: [{}], matched: true, member: false },
  ];
  assert.deepEqual(rosterSummary(rows), { rows: 3, orders: 2, tickets: 3, claimants: 2, unregisteredClaimants: 1, members: 1, unmatched: 1, noEmail: 1 });
});

test('buildRoster composes orders + slots/claims + people into { rows, summary }', () => {
  const out = buildRoster({
    orders: [{ id: '1', name: 'Dana Levy', email: 'dana@x.com', status: 'placed', attendees: [{ ticket_class_name: 'GA' }] }],
    slots: [slot('i-s1', 'Potluck', 'Dessert')],
    claimsBySlot: { 'i-s1': [claim('i-p1', 'Dana Levy', 'kugel', 1)] },
    people: [person('i-p1', 'Dana Levy', ['dana@x.com'], true)],
    cols: PEOPLE_COLS,
  });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].claims[0].label, 'Dessert');
  assert.equal(out.summary.orders, 1);
  assert.equal(out.summary.members, 1);
  assert.equal(out.summary.unregisteredClaimants, 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd proxy && node --test test/roster.test.js 2>&1 | grep -E "^# (pass|fail)|SyntaxError"`
Expected: SyntaxError (missing exports).

- [ ] **Step 3: Implement merge / summary / build**

Append to `proxy/src/roster.js`:

```js
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
```

- [ ] **Step 4: Run the full proxy suite**

Run: `cd proxy && npm test 2>&1 | tail -6`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add proxy/src/roster.js proxy/test/roster.test.js
git commit -m "feat(proxy): roster helpers — mergeRoster, rosterSummary, buildRoster

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Guard — gather's member projection stays email-free

**Files:**
- Test: `proxy/test/gather.test.js`

- [ ] **Step 1: Add the guard test**

Append to `proxy/test/gather.test.js`:

```js
test('PRIVACY: projectEventForMember never emits an email key anywhere in the projection', () => {
  const row = { id: 'i-ev', values: { [PLANNING_COLS.title]: 'Potluck', [PLANNING_COLS.published]: true } };
  const slots = [{ id: 'i-s1', values: { [SLOT_COLS.label]: 'Dessert', [SLOT_COLS.kind]: 'Potluck' } }];
  const claimsBySlot = { 'i-s1': [{ id: 'i-c1', values: { [CLAIM_COLS.member]: { rowId: 'i-p1', name: 'Dana Levy' }, [CLAIM_COLS.contributionDetail]: 'kugel', [CLAIM_COLS.qty]: 1 } }] };
  const proj = projectEventForMember(row, slots, claimsBySlot, 'Dana Levy', { includeClaimants: true, callerId: 'i-p1' });
  const walk = (o, path = '') => {
    if (Array.isArray(o)) return o.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (o && typeof o === 'object') for (const k of Object.keys(o)) { assert.ok(!/email/i.test(k), `email-ish key at ${path}.${k}`); walk(o[k], `${path}.${k}`); }
  };
  walk(proj);
});
```

- [ ] **Step 2: Run it**

Run: `cd proxy && node --test test/gather.test.js 2>&1 | tail -6`
Expected: pass (it documents the invariant; it should already hold).

- [ ] **Step 3: Commit**

```bash
git add proxy/test/gather.test.js
git commit -m "test(proxy): assert the member projection never carries an email

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Worker — `GET /roster/:rowId`, Eventbrite orders read, KV bust on claim writes

**Files:**
- Modify: `proxy/src/worker.js` (header comment ~line 9-16; imports ~line 30-38; gather routes after `const gatherTablesOk` ~line 570; `POST /claims` ~line 646-672; `PUT|DELETE /claims/:id` ~line 674-694; helpers near `ebAttendeeEmailHashes` ~line 978)

- [ ] **Step 1: Import the roster builder**

After the `from './gather.js';` import block add:

```js
import { buildRoster } from './roster.js';
```

- [ ] **Step 2: Document the route in the header comment**

After the `POST /notes-doc` line in the header comment add:

```
 *   GET    /roster/:rowId  lead-facing attendee roster (Eventbrite orders ∪ gather claimants) — role-gated; ?fresh=1 bypasses KV
```

- [ ] **Step 3: Add the route**

Immediately after this existing line inside `fetch()`:

```js
      const gatherTablesOk = env.CODA_SLOTS_TABLE && env.CODA_CLAIMS_TABLE;
```

insert:

```js
      if (parts[0] === 'roster' && parts[1] && parts.length === 2 && request.method === 'GET') {
        // Lead-facing attendee roster: Eventbrite orders ∪ gather claimants for one
        // planning row, each resolved to an EST person (email <-> People `All Emails`,
        // the same rule Coda's Orders sync uses) + the Active Member? flag.
        // Emails ARE returned — this is plan-only (canWrite), never a member route;
        // gather's projection stays email-free. Live from Eventbrite, KV-cached per
        // event (soft 60s / hard 5m; busted on claim writes); ?fresh=1 bypasses.
        let id; try { id = await authIdentity(request, env, base, docId, auth, ctx); } catch (e) { return json({ error: 'invalid token' }, 401, cors); }
        if (!id || !id.canWrite) return json({ error: 'not authorized' }, 403, cors);
        if (!env.EVENTBRITE_TOKEN) return json({ configured: false }, 200, cors);
        const rowId = decodeURIComponent(parts[1]);
        const build = async () => {
          const one = await fetch(`${base}/docs/${docId}/tables/${tableId}/rows/${encodeURIComponent(rowId)}?useColumnNames=false&valueFormat=rich`, { headers: auth });
          if (!one.ok) throw new Error(`event not found (${one.status})`);
          const ebId = plain(((await one.json()).values || {})[PLANNING_COLS.eventbriteId]) || '';
          const [orders, sl, cl, people] = await Promise.all([
            ebId ? ebAllOrders(env, ebId) : [],
            gatherTablesOk ? readAllRows(`${base}/docs/${docId}/tables/${env.CODA_SLOTS_TABLE}/rows`, auth, { rich: true }) : { ok: true, items: [] },
            gatherTablesOk ? readAllRows(`${base}/docs/${docId}/tables/${env.CODA_CLAIMS_TABLE}/rows`, auth, { rich: true }) : { ok: true, items: [] },
            peopleRows(base, docId, auth, env, ctx),
          ]);
          if (!sl.ok) throw new Error(`slots read failed (${sl.resp.status})`);
          const slots = sl.items.filter((s) => relId(s.values[SLOT_COLS.event]) === rowId);
          const claimsBySlot = {};
          for (const c of (cl.ok ? cl.items : [])) {
            const sid = relId(c.values[CLAIM_COLS.slot]);
            if (sid) (claimsBySlot[sid] = claimsBySlot[sid] || []).push(c);
          }
          const { rows, summary } = buildRoster({ orders, slots, claimsBySlot, people, cols: PEOPLE_COLS });
          return { configured: true, ebLinked: !!ebId, fetchedAt: new Date().toISOString(), summary, rows };
        };
        const key = rosterKvKey(rowId);
        let data;
        if (url.searchParams.get('fresh') === '1') {
          data = await build();                                   // refresh button: bypass + rewrite the snapshot
          if (env.CACHE) { try { await env.CACHE.put(key, JSON.stringify({ at: Date.now(), data })); } catch (_) {} }
        } else {
          data = await swrGet(env, ctx, key, 60_000, 300_000, build);
        }
        return json(data, 200, cors);
      }
```

(A thrown error — Eventbrite non-2xx, Coda read failure — falls through to the route-level `catch` and returns `502 { error: <message> }`, which is the verbatim-message contract the app renders with Retry.)

- [ ] **Step 4: Add the helpers**

Immediately after the `ebAttendeeEmailHashes` function add:

```js
// KV key for one event's lead-facing roster snapshot. Raw registrant emails live
// in this value — KV is server-side only, the same trust boundary as the Coda +
// Eventbrite tokens; it never feeds a member route.
const rosterKvKey = (rowId) => `roster-v1:${rowId}`;
// Every ACTIVE order for an event, attendees expanded (one attendee = one
// ticket), all pages. Quiet logging: order bodies carry registrant PII.
async function ebAllOrders(env, ebId) {
  const orders = [];
  let cont = null, pages = 0;
  do {
    const r = await ebFetch(env, `/events/${ebId}/orders/?status=active&expand=attendees${cont ? `&continuation=${encodeURIComponent(cont)}` : ''}`, 'GET', undefined, { quiet: true });
    if (!r.ok) throw new Error(`eventbrite orders read failed (${r.status})${r.body && r.body.error_description ? ': ' + r.body.error_description : ''}`);
    orders.push(...((r.body && r.body.orders) || []));
    const pg = r.body && r.body.pagination;
    cont = (pg && pg.has_more_items && pg.continuation) || null;
  } while (cont && ++pages < 20);
  return orders;
}
// A claim changed under `slotId`: drop that slot's EVENT roster snapshot so the
// next lead read sees it. Best-effort and off the response path (ctx.waitUntil).
async function bustRosterForSlot(env, base, docId, auth, slotId) {
  if (!env.CACHE || !slotId || !env.CODA_SLOTS_TABLE) return;
  try {
    const r = await fetch(`${base}/docs/${docId}/tables/${env.CODA_SLOTS_TABLE}/rows/${encodeURIComponent(slotId)}?useColumnNames=false&valueFormat=rich`, { headers: auth });
    if (!r.ok) return;
    const eid = relId(((await r.json()).values || {})[SLOT_COLS.event]);
    if (eid) await swrBust(env, rosterKvKey(eid));
  } catch (_) {}
}
```

- [ ] **Step 5: Bust on claim create**

In the `POST /claims` route, change:

```js
        if (!r.ok) return pass(r, cors);
        const j = await r.json();
        return json({ ok: true, id: (j.addedRowIds && j.addedRowIds[0]) || null }, 200, cors);
```
to
```js
        if (!r.ok) return pass(r, cors);
        if (ctx) ctx.waitUntil(bustRosterForSlot(env, base, docId, auth, input.slot));   // roster (plan Attendees) must see the new claim
        const j = await r.json();
        return json({ ok: true, id: (j.addedRowIds && j.addedRowIds[0]) || null }, 200, cors);
```

- [ ] **Step 6: Bust on claim edit/delete**

In the `PUT|DELETE /claims/:id` route, change:

```js
        const owner = claimOwnerId(await one.json(), CLAIM_COLS);
        if (!(owner && owner === m.personId) && !m.canWrite) return json({ error: 'not your claim' }, 403, cors);
```
to
```js
        const claimRow = await one.json();
        const owner = claimOwnerId(claimRow, CLAIM_COLS);
        if (!(owner && owner === m.personId) && !m.canWrite) return json({ error: 'not your claim' }, 403, cors);
        if (ctx) ctx.waitUntil(bustRosterForSlot(env, base, docId, auth, relId(claimRow.values && claimRow.values[CLAIM_COLS.slot])));   // roster must see the change
```

- [ ] **Step 7: Syntax-check and run the suite**

Run: `cd proxy && node --check src/worker.js && npm test 2>&1 | tail -4`
Expected: no syntax error; `# fail 0`.

- [ ] **Step 8: Commit**

```bash
git add proxy/src/worker.js
git commit -m "feat(proxy): GET /roster/:rowId — live attendee roster for leads (orders ∪ claimants, KV-cached)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `web/roster-lib.js` — segments + mailto guard (node-tested)

**Files:**
- Create: `web/roster-lib.js`
- Create: `proxy/test/roster-lib.test.js`
- Modify: `web/index.html:103-104`

- [ ] **Step 1: Write the failing tests**

Create `proxy/test/roster-lib.test.js`:

```js
// web/roster-lib.js is a plain browser script that attaches `RosterLib` to
// globalThis — importing it for side effects makes it testable under node too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../web/roster-lib.js';

const L = globalThis.RosterLib;
const rows = [
  { key: 'order:1', kind: 'order', email: 'a@x.com', member: true, claims: [{ slotId: 's1', label: 'Dessert', kind: 'Potluck' }] },
  { key: 'order:2', kind: 'order', email: 'B@X.com', member: false, claims: [] },
  { key: 'order:3', kind: 'order', email: '', member: false, claims: [] },
  { key: 'person:p9', kind: 'claimant', email: 'c@x.com', member: false, claims: [{ slotId: 's2', label: 'Setup', kind: 'Volunteer' }, { slotId: 's1', label: 'Dessert', kind: 'Potluck' }] },
];

test('segmentsFor: the fixed segments plus one per distinct slot seen in claims (first-seen order)', () => {
  const segs = L.segmentsFor(rows);
  assert.deepEqual(segs.map((s) => s.id), ['all', 'registered', 'unregisteredClaimants', 'registeredNoClaim', 'members', 'nonMembers', 'slot:s1', 'slot:s2']);
  assert.equal(segs.find((s) => s.id === 'slot:s2').label, 'Setup');
});

test('applySegment filters by predicate; unknown id falls back to All', () => {
  const segs = L.segmentsFor(rows);
  const keys = (id) => L.applySegment(rows, segs, id).map((r) => r.key);
  assert.deepEqual(keys('all'), ['order:1', 'order:2', 'order:3', 'person:p9']);
  assert.deepEqual(keys('registered'), ['order:1', 'order:2', 'order:3']);
  assert.deepEqual(keys('unregisteredClaimants'), ['person:p9']);
  assert.deepEqual(keys('registeredNoClaim'), ['order:2', 'order:3']);
  assert.deepEqual(keys('members'), ['order:1']);
  assert.deepEqual(keys('nonMembers'), ['order:2', 'order:3', 'person:p9']);
  assert.deepEqual(keys('slot:s1'), ['order:1', 'person:p9']);
  assert.deepEqual(keys('slot:s2'), ['person:p9']);
  assert.deepEqual(keys('nope'), keys('all'));
});

test('emailsOf: lowercased, deduped, blanks dropped', () => {
  assert.deepEqual(L.emailsOf(rows.concat([{ email: 'a@x.com' }])), ['a@x.com', 'b@x.com', 'c@x.com']);
});

test('mailtoHref: bcc list + subject, null when the link would exceed the safe length', () => {
  assert.equal(L.mailtoHref(['a@x.com', 'b@x.com'], 'Potluck!'), 'mailto:?bcc=a%40x.com,b%40x.com&subject=Potluck!');
  assert.equal(L.mailtoHref(['a@x.com'], ''), 'mailto:?bcc=a%40x.com');
  const many = Array.from({ length: 120 }, (_, i) => `person${i}@example.org`);   // ~2.9k chars
  assert.equal(L.mailtoHref(many, 'x'), null);
  assert.ok(L.MAILTO_MAX >= 1800 && L.MAILTO_MAX <= 2000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd proxy && node --test test/roster-lib.test.js 2>&1 | head -5`
Expected: FAIL — cannot find module `../../web/roster-lib.js`.

- [ ] **Step 3: Create `web/roster-lib.js`**

```js
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
```

- [ ] **Step 4: Load it in the app**

In `web/index.html`, change:

```html
<script type="module" src="auth-firebase.js"></script>
<script src="app.js"></script>
```
to
```html
<script type="module" src="auth-firebase.js"></script>
<script src="roster-lib.js"></script>
<script src="app.js"></script>
```

- [ ] **Step 5: Run the tests**

Run: `cd proxy && npm test 2>&1 | tail -4 && node --check ../web/roster-lib.js`
Expected: `# fail 0`; no syntax error.

- [ ] **Step 6: Commit**

```bash
git add web/roster-lib.js web/index.html proxy/test/roster-lib.test.js
git commit -m "feat(web): RosterLib — roster segments + mailto guard (node-tested plain script)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: App — Attendees section (registry, client, render, wire)

**Files:**
- Modify: `web/app.js` — `SECTIONS`/`sectionId` (~line 654-667), `DB` object (~line 369-376, add `roster`), `renderSection` (~line 1112-1119), new `renderAttendees`/`wireAttendees`/`fmtAgo` (insert after `comingSoonHTML`, ~line 1262)
- Modify: `web/styles.css` (append)

- [ ] **Step 1: Make the section live and alias the old id**

In `web/app.js`, replace:

```js
  { id:'attendance',label:'Attendance',           live:false },
```
with
```js
  { id:'attendees', label:'Attendees',            live:true },
```
and move that line up so it sits directly after the `publish` entry (live sections render first in the rail; array order = rail order).

Replace:
```js
// Back-compat: the Details section was formerly 'planning'; map old deep links.
const sectionId = id => (id==='planning' ? 'details' : id);
```
with
```js
// Back-compat: Details was formerly 'planning', Attendees was the 'attendance'
// coming-soon stub; map old deep links.
const sectionId = id => ({ planning:'details', attendance:'attendees' }[id] || id);
```

- [ ] **Step 2: Add the client call**

In the `DB` object, after the `removeSlot` line add:

```js
  // lead-facing attendee roster (Eventbrite orders ∪ gather claimants); fresh=true bypasses the Worker's KV snapshot
  async roster(rowId, fresh){ const r=await fetch(`${this.base}/roster/${encodeURIComponent(rowId)}${fresh?'?fresh=1':''}`,{headers:this._wh()}); const j=await r.json().catch(()=>({})); if(!r.ok){ const e=new Error(j.error||`roster failed (${r.status})`); e.status=r.status; throw e; } return j; },
```

- [ ] **Step 3: Dispatch the section**

In `renderSection`, after the `if(id==='volunteers')…` line add:

```js
  if(id==='attendees'){ panel.innerHTML=renderAttendees(ev); wireAttendees(panel, ev); return; }
```

- [ ] **Step 4: Add the render + wire pair**

Insert after `comingSoonHTML` (before the `/* ---- Volunteers & potluck` block):

```js
/* ---- Attendees: live roster (Eventbrite orders ∪ gather claimants) --------
   Read-only for leads. Emails ARE shown here — plan is lead-only; gather's
   member projection never carries an address. Segments are a client-side filter
   (RosterLib); Copy / Email act on the checked rows of the current segment.
   Selection is by row key, and emails are resolved from the loaded rows. */
function renderAttendees(ev){
  if(!ev.id) return `<div class="roster-wrap"><div class="soon-teaser"><div class="soon-h">Attendees</div><div class="hint">Save the event first.</div></div></div>`;
  return `<div class="roster-wrap" id="f_roster">
      <div class="roster-head"><div class="roster-sum hint" data-sum>Loading…</div><button type="button" class="btn sm ghost" data-act="roster-refresh" title="Pull the latest from Eventbrite">↻ Refresh</button></div>
      <div class="roster-segs" data-segs></div>
      <div class="roster-body" data-body>${SLOTS_LOADING_HTML}</div>
      <div class="roster-foot">
        <label class="roster-selall"><input type="checkbox" data-selall> <span data-selcount>0 selected</span></label>
        <span class="push"></span>
        <button type="button" class="btn sm" data-act="roster-copy" disabled>Copy emails</button>
        <a class="btn sm primary disabled" data-act="roster-mail" href="#" aria-disabled="true">Email</a>
      </div>
    </div>`;
}
async function wireAttendees(panel, ev){
  const wrap=panel.querySelector('#f_roster'); if(!wrap) return;
  const body=wrap.querySelector('[data-body]'); if(!body) return;   // save-first teaser
  const segsEl=wrap.querySelector('[data-segs]'), sum=wrap.querySelector('[data-sum]');
  const copyBtn=wrap.querySelector('[data-act="roster-copy"]'), mailBtn=wrap.querySelector('[data-act="roster-mail"]');
  const selAll=wrap.querySelector('[data-selall]'), selCount=wrap.querySelector('[data-selcount]');
  const L=window.RosterLib;
  let data=null, segs=[], seg='all', selected=new Set();
  const visible=()=>data?L.applySegment(data.rows, segs, seg):[];
  const chosen=()=>visible().filter(r=>selected.has(r.key));
  const plural=(n,w)=>`${n} ${w}${n===1?'':'s'}`;
  const paintFoot=()=>{
    const rows=chosen(), emails=L.emailsOf(rows), missing=rows.length-emails.length;
    selCount.textContent=`${rows.length} selected${missing>0?` · ${missing} without email`:''}`;
    copyBtn.disabled=!emails.length;
    const href=emails.length?L.mailtoHref(emails, ev.title||''):null;
    mailBtn.classList.toggle('disabled', !href); mailBtn.setAttribute('aria-disabled', String(!href));
    mailBtn.href=href||'#';
    mailBtn.title=(emails.length && !href)?'Too many addresses for a mail link — use Copy emails instead':'';
    const vis=visible();
    selAll.checked=vis.length>0 && vis.every(r=>selected.has(r.key));
    selAll.indeterminate=!selAll.checked && vis.some(r=>selected.has(r.key));
  };
  const paintSegs=()=>{
    segsEl.innerHTML=segs.map(s=>{ const n=data.rows.filter(s.test).length; return `<button type="button" class="roster-seg${s.id===seg?' on':''}" data-seg="${esc(s.id)}" aria-pressed="${s.id===seg}">${esc(s.label)} <span class="n">${n}</span></button>`; }).join('');
  };
  const statusBadge=r=> r.kind==='order'
    ? (r.matched ? `<span class="badge b-confirmed">Registered</span>` : `<span class="badge b-draft" title="No EST person matches this email yet">Not in People</span>`)
    : `<span class="badge b-past" title="Signed up in gather but hasn't registered on Eventbrite">Not registered</span>`;
  const paintRows=()=>{
    const rows=visible();
    if(!rows.length){
      const msg = data.rows.length ? 'No one in this segment.'
        : (data.ebLinked ? 'No registrations yet.' : 'Registrants appear here once the event is published to Eventbrite. Sign-ups from gather show as soon as they land.');
      body.innerHTML=`<div class="hint roster-empty">${msg}</div>`; paintFoot(); return;
    }
    body.innerHTML=`<table class="roster"><thead><tr><th></th><th>Name</th><th>Tickets</th><th>Sign-ups</th><th>Status</th></tr></thead><tbody>${rows.map(r=>`
      <tr data-key="${esc(r.key)}">
        <td><input type="checkbox" data-sel ${selected.has(r.key)?'checked':''} aria-label="Select ${esc(r.name||r.email||'row')}"></td>
        <td><div class="roster-name">${esc(r.name||'(no name)')}${r.member?` <span class="badge b-member" title="Active member">Member</span>`:''}</div><div class="roster-email">${r.email?esc(r.email):'<span class="hint">no email</span>'}</div></td>
        <td class="roster-tix">${r.tickets.length?r.tickets.map(t=>`${t.qty} × ${esc(t.class)}`).join('<br>'):'<span class="hint">—</span>'}</td>
        <td class="roster-claims">${r.claims.length?r.claims.map(c=>`<span class="roster-claim">${esc(c.label)}${c.contribution?` <span class="hint">· ${esc(c.contribution)}</span>`:''}</span>`).join(''):'<span class="hint">—</span>'}</td>
        <td>${statusBadge(r)}</td>
      </tr>`).join('')}</tbody></table>`;
    paintFoot();
  };
  const paintSum=()=>{ const s=data.summary; sum.textContent=`${plural(s.orders,'order')} · ${plural(s.tickets,'ticket')} · ${s.claimants} signed up · ${plural(s.members,'member')}${data.fetchedAt?` · updated ${fmtAgo(data.fetchedAt)}`:''}`; };
  const load=async(fresh)=>{
    try{
      data=await DB.roster(ev.id, fresh);
      if(data.configured===false){ body.innerHTML=`<div class="hint roster-empty">Eventbrite isn't configured on the proxy, so registrations can't be shown.</div>`; sum.textContent=''; return; }
      segs=L.segmentsFor(data.rows); if(!segs.some(s=>s.id===seg)) seg='all';
      selected=new Set([...selected].filter(k=>data.rows.some(r=>r.key===k)));   // drop selections that vanished
      paintSum(); paintSegs(); paintRows();
    }catch(e){
      sum.textContent='';
      if(e.status===403){ body.innerHTML=`<div class="hint roster-empty">Sign in as a program lead or council member to see attendees.</div>`; return; }
      body.innerHTML=`<div class="roster-err"><span>${esc(e.message||'Could not load attendees')}</span><button type="button" class="btn xs" data-act="roster-retry">Retry</button></div>`;
    }
  };
  wrap.addEventListener('click', async e=>{
    const sb=e.target.closest('[data-seg]'); if(sb){ seg=sb.dataset.seg; selected.clear(); paintSegs(); paintRows(); return; }
    const a=e.target.closest('[data-act]'); if(!a) return;
    const act=a.dataset.act;
    if(act==='roster-refresh'||act==='roster-retry'){ body.innerHTML=SLOTS_LOADING_HTML; await load(true); return; }
    if(act==='roster-copy'){
      const emails=L.emailsOf(chosen()); const text=emails.join(', ');
      try{ await navigator.clipboard.writeText(text); toast(`Copied ${plural(emails.length,'email')}`); }
      catch(_){ window.prompt('Copy these addresses:', text); }   // clipboard API blocked (http, permissions) — still hand them over
      return;
    }
    if(act==='roster-mail' && a.classList.contains('disabled')){ e.preventDefault(); }
  });
  wrap.addEventListener('change', e=>{
    if(e.target.matches('[data-selall]')){ const vis=visible(); vis.forEach(r=> e.target.checked ? selected.add(r.key) : selected.delete(r.key)); paintRows(); return; }
    if(e.target.matches('[data-sel]')){ const key=e.target.closest('tr').dataset.key; if(e.target.checked) selected.add(key); else selected.delete(key); paintFoot(); }
  });
  await load(false);
}
function fmtAgo(iso){
  const s=Math.max(0,(Date.now()-Date.parse(iso))/1000);
  if(!Number.isFinite(s)) return '';
  if(s<60) return 'just now';
  const m=Math.round(s/60); if(m<60) return `${m}m ago`;
  return `${Math.round(m/60)}h ago`;
}
```

- [ ] **Step 5: Styles**

`web/styles.css` ends with a dark-mode block that starts `@media (prefers-color-scheme:dark){` (~line 577). Insert the following immediately BEFORE that line:

```css
  /* ---- Attendees roster (plan, lead-only) ---------------------------------- */
  .roster-wrap{display:flex;flex-direction:column;gap:10px;min-height:0}
  .roster-foot .push{flex:1}
  .roster-head{display:flex;align-items:center;gap:8px}
  .roster-sum{flex:1;min-width:0}
  .roster-segs{display:flex;flex-wrap:wrap;gap:6px}
  .roster-seg{font:inherit;font-size:11.5px;padding:4px 9px;border-radius:20px;border:1px solid var(--hair-strong);background:var(--surface);color:var(--muted);cursor:pointer}
  .roster-seg:hover{color:var(--accent);border-color:var(--accent)}
  .roster-seg .n{opacity:.7;margin-left:3px;font-variant-numeric:tabular-nums}
  .roster-seg.on{background:var(--accent);border-color:var(--accent);color:#fff}
  .roster-seg.on .n{opacity:.9}
  table.roster{width:100%;border-collapse:collapse;font-size:12.5px}
  table.roster th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);font-weight:600;padding:4px 6px;border-bottom:1px solid var(--hair)}
  table.roster td{padding:6px;border-bottom:1px solid var(--hair);vertical-align:top}
  table.roster .badge{display:inline-block;font-size:10px;padding:2px 7px;border-radius:20px;font-weight:600;white-space:nowrap}
  .roster-name{font-weight:600;color:var(--ink)}
  .roster-email{color:var(--muted);font-size:11.5px;word-break:break-all}
  .roster-tix{white-space:nowrap;font-variant-numeric:tabular-nums}
  .roster-claim{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
  .badge.b-member{background:#E7F4E9;color:#2F7D3B;font-size:9.5px;padding:1px 6px;border-radius:20px;margin-left:5px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;vertical-align:middle}
  .roster-foot{display:flex;align-items:center;gap:8px;padding-top:8px;border-top:1px solid var(--hair);position:sticky;bottom:0;background:var(--surface)}
  .roster-selall{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);cursor:pointer}
  .roster-foot .btn.disabled{opacity:.5;pointer-events:none}
  .roster-empty{padding:14px 4px}
  .roster-err{padding:10px 12px;border:1px solid #E5B4B4;background:#FBEDED;border-radius:8px;color:#8A2E2E;font-size:12.5px;display:flex;gap:10px;align-items:center;justify-content:space-between}
  @media (max-width:640px){ table.roster th:nth-child(3),table.roster td:nth-child(3){display:none} .roster-claim{max-width:140px} }
```

Then add these two lines INSIDE the dark-mode block, just before its closing `}` (the last line of the file; the block's existing rules use the same two-space indent):

```css
    .badge.b-member{background:#23352B;color:#82C89D}
    .roster-err{background:#3C2626;border-color:#7A4040;color:#E9A0A0}
```

- [ ] **Step 6: Syntax check**

Run: `node --check web/app.js && node --check web/roster-lib.js && echo OK`
Expected: `OK`.

- [ ] **Step 7: Commit**

```bash
git add web/app.js web/styles.css
git commit -m "feat(web): Attendees section — live roster, segments, Copy emails / mailto BCC

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Local end-to-end verification (no deploy)

**Files:**
- Modify: `.claude/launch.json` (add a `proxy` configuration)

- [ ] **Step 1: Add a local proxy launch config**

In `.claude/launch.json`, add to `configurations`:

```json
    {
      "name": "proxy",
      "runtimeExecutable": "npm",
      "runtimeArgs": ["--prefix", "proxy", "run", "dev", "--", "--port", "8787"],
      "port": 8787
    }
```

`proxy/.dev.vars` must exist with a real `CODA_API_TOKEN` and `EVENTBRITE_TOKEN` (copy from `.dev.vars.example`; gitignored). `wrangler dev` uses `wrangler.toml` vars (CORS allowlist already includes `http://localhost:8080`) and a local KV emulation.

- [ ] **Step 2: Start both servers**

Use `preview_start` with `{name:"proxy"}` then `{name:"web"}`. Confirm the proxy answers: open `http://localhost:8787/rows` in the browser tab and expect a JSON list.

- [ ] **Step 3: Point the app at the local Worker**

In the web tab run (javascript_tool):

```js
localStorage.setItem('est-proxy-base','http://localhost:8787'); location.reload();
```

Sign in with a Program Lead / Tribal Council Google account (Firebase authorized domains already include `localhost`).

- [ ] **Step 4: Verify the section on a published event**

Open an event that has an Eventbrite id and at least one gather claim → rail item **Attendees**. Check with `read_page` / a screenshot:
- summary line shows orders · tickets · signed up · members · updated just now
- segment chips with counts, including one per slot
- rows show name, email, member badge where expected, ticket rollup, sign-ups, status badge
- tick two rows → footer says "2 selected", **Copy emails** enabled, **Email** href starts with `mailto:?bcc=`
- **Copy emails** → toast "Copied 2 emails" (or the prompt fallback on plain http)
- **Refresh** re-fetches (`?fresh=1` visible in `read_network_requests`)
- `read_console_messages` shows no errors

Also open an event with NO Eventbrite id → the "Registrants appear here once the event is published…" notice (with claimant rows if any). Sign out → "Sign in as a program lead…" notice (403).

- [ ] **Step 5: Verify the deep-link alias**

Navigate to `http://localhost:8080/?event=<rowId>&section=attendance` → the Attendees section opens and the URL rewrites to `section=attendees`.

- [ ] **Step 6: Reset the override and commit the launch config**

```js
localStorage.removeItem('est-proxy-base');
```

```bash
git add .claude/launch.json
git commit -m "dev: proxy launch config for local Worker verification

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Docs

**Files:**
- Modify: `CLAUDE.md` (the "Editor = a section-model workspace" bullet; the Worker "Serves…" line in *Current status*; the KV gotcha bullet; *Next steps*)
- Modify: `proxy/README.md` (route list intro)

- [ ] **Step 1: CLAUDE.md — editor bullet**

In the bullet that begins `**Editor = a section-model workspace**`, change `live sections **Planning** … + **Publish** … plus a muted **Coming soon** group (Budget/Comms/Volunteers/Attendance/Feedback)` to:

```
live sections **Details**, **Planning Notes**, **Potluck & Volunteers**, **Publish**
(`renderPublish`/`wirePublish`, gated on approved) and **Attendees**
(`renderAttendees`/`wireAttendees` — lead-only live roster of Eventbrite orders ∪
gather claimants via Worker `GET /roster/:rowId`, segment chips from
`web/roster-lib.js`, **Copy emails** / **Email** = `mailto:` BCC; leads send from
their own accounts, no Worker-side sending), plus a muted **Coming soon** group
(Budget/Comms/Feedback)
```

- [ ] **Step 2: CLAUDE.md — Worker + KV notes + next steps**

In *Current status* → the `Proxy: deployed` bullet, after `Serves \`GET /rows\`, \`GET /ref/:name\`, \`GET /me\`` add: `, \`GET /roster/:rowId\` (lead-only attendee roster: live Eventbrite orders + gather claims, resolved to People by \`All Emails\`, Active Member? badge from \`c-yJfWc0GMsQ\`)`.

In the KV gotcha bullet (`**The Worker caches Coda reads in KV**`), after the `/references` clause add: `, and **/roster/:rowId** (soft 60s/hard 5m per event — busted by the claim write routes via the slot's Event relation; \`?fresh=1\` for the refresh button; the value holds raw registrant emails, server-side only)`. In the same bullet's People-projection clause add: `(now also carries \`Active Member?\` — \`PEOPLE_KV_KEY\` is \`people-slim-v3\`; bump it on any slim-shape change)`.

Under *Next steps* → **Later**, add a new item: `- **Registrant comms v1 — ✅ DONE (Sep 2026):** Attendees roster + copy/mailto. Worker-side sending, a Comms Log, and the EST Memberships SRC-backed member rule are the follow-ups. Design: \`docs/superpowers/specs/2026-09-16-attendees-roster-design.md\`.`

- [ ] **Step 3: proxy/README.md**

After the sentence ending `writes are gated by Google Sign-In + role (verified server-side).` add: `\`GET /roster/:rowId\` (lead-only) returns an event's live attendee roster — Eventbrite orders plus gather claimants, with emails — and is the one read that carries registrant PII; it never serves member routes.`

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md proxy/README.md
git commit -m "docs: Attendees roster section + /roster route

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Deploy the Worker once, live check, PR

- [ ] **Step 1: Confirm the branch is green**

Run: `cd proxy && npm test 2>&1 | tail -4 && node --check src/worker.js && node --check ../web/app.js && ../scripts/sync-shared.sh --check`
Expected: `# fail 0`, no syntax errors, shared mirrors in sync.

- [ ] **Step 2: Deploy the Worker (the one deploy this feature needs)**

Run: `cd proxy && npm run deploy 2>&1 | tail -5`
Expected: `Deployed est-planning-proxy` with a version id. (Backward-compatible: the live app ignores the new route; the People KV key bump just re-fills once.)

- [ ] **Step 3: Live check against the prod Worker from the local app**

With the web preview still on `http://localhost:8080` and NO `est-proxy-base` override, open the same published event → Attendees loads from the deployed Worker. Confirm one row's email matches what Eventbrite shows for that order, and that a known Givebutter member carries the Member badge.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feat/attendees-roster
gh pr create --title "feat: Attendees roster + registrant comms v1 (copy / mailto)" --body "$(cat <<'PRBODY'
## What
- New **Attendees** section in the event workspace: live roster of Eventbrite orders ∪ gather claimants, resolved to EST people, with an Active Member badge.
- Segment chips (All / Registered / Signed up-not registered / Registered-no sign-up / Members / Non-members / per slot), row selection, **Copy emails** and **Email** (mailto BCC). Leads send from their own accounts.
- Worker: `GET /roster/:rowId` (role-gated, KV-cached per event, busted on claim writes); `Active Member?` projected into the slim People snapshot (`people-slim-v3`).
- Gather untouched; a new test asserts the member projection never carries an email.

## Design
`docs/superpowers/specs/2026-09-16-attendees-roster-design.md` · plan `docs/superpowers/plans/2026-09-16-attendees-roster.md`

## Verified
- `npm test` (proxy) green; `node --check` on app + lib
- Local: wrangler dev + live-server, signed in as council — roster, segments, copy, mailto, refresh, deep-link alias
- Worker deployed; live check from the local app against the prod Worker

🤖 Generated with [Claude Code](https://claude.com/claude-code)
PRBODY
)"
```

Netlify deploys `web/` on merge to `main`.
