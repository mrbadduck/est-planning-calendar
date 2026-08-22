# Publish to Eventbrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A program lead can create + publish a basic **free** Eventbrite event from the planning app — core details, capacity, venue (respecting address privacy) — via a role-gated `POST /publish/eventbrite` Worker route, with a first-class observability layer (Coda `Publish Log` + row status fields + in-app errors).

**Architecture:** Direct-from-Worker. The Worker holds an EST Eventbrite private token and orchestrates create→venue→ticket→structured-content→publish, storing the Eventbrite id on the planning row immediately after create (idempotency). Pure payload/date builders live in a dependency-free, unit-tested module; I/O lives in thin wrappers over `fetch`. Design spec: `docs/superpowers/specs/2026-08-22-eventbrite-publish-design.md`.

**Tech Stack:** Cloudflare Worker (ESM), vanilla buildless app, Node 22 `node --test`. No new runtime deps. Coda ids: doc `DYAz_wCVfv`, planning table `grid--gYIvdD-cE`, venues `grid-foC40iAOaX`, people `grid-X316Eql8dE`. Program timezone = `America/Chicago`.

---

## File Structure

- **Create** `proxy/src/eventbrite.js` — pure builders: `zonedToUtcISO`, `eventToEventbritePayload`, `ticketClassPayload`, `structuredContentBody`, `venuePayload`, `eventbriteWebUrl`. No network.
- **Create** `proxy/test/eventbrite.test.js` — `node --test` unit tests for the above (incl. the registrants-only "no address" safety invariant).
- **Modify** `proxy/src/worker.js` — add the Eventbrite I/O client fns + the `POST /publish/eventbrite` route + Publish-Log append; new config (`EVENTBRITE_TOKEN` secret, `EVENTBRITE_ORG_ID`, `CODA_PUBLISH_LOG_TABLE`, `EVENTBRITE_TZ`).
- **Modify** `proxy/wrangler.toml` + `proxy/.dev.vars.example` — declare the new vars.
- **Modify** `web/app.js` — event model (`capacity`, `addressVisibility`, publish-status fields) in `planningRowToEvent`/`eventToCodaCells`; editor fields + Publish/Update button + states + Open-in-Eventbrite + error surfacing; `DB.publishEventbrite()`.
- **Modify** `web/styles.css` — minimal styles for the publish panel/badge (reuse existing `.locknote`/`.badge` idioms).
- **Coda schema (via MCP, no repo files):** planning-row columns, `Eventbrite Venue ID` on venues, new `Publish Log` table.
- **Modify** `CLAUDE.md` — revise principle #3 (downstream publish = server-side Worker).

---

## Task 1: Coda schema (MCP, no code)

**Files:** none (Coda doc changes via the Superhuman Docs MCP). Record every new column id in the task's commit message / a scratch note for later tasks.

- [ ] **Step 1: Add columns to `EST Planning Events SRC` (`grid--gYIvdD-cE`)** via `table_columns_manage`:
  - `Capacity` — number
  - `Address visibility` — SelectList, options exactly: `Public`, `Registrants only`
  - `Eventbrite Event ID` — text
  - `Eventbrite URL` — text
  - `Eventbrite Ticket Class ID` — text
  - `Publish status` — SelectList, options exactly: `Unpublished`, `Publishing`, `Published`, `Error`
  - `Last published at` — text (plain text ISO; avoid Coda auto-typing per the Start/End gotcha — pin to text)
  - `Last publish error` — text

- [ ] **Step 2: Add `Eventbrite Venue ID` (text) to `EST Venues SRC` (`grid-foC40iAOaX`)** via `table_columns_manage`.

- [ ] **Step 3: Create the `Publish Log` table** on the planning page via `table_create`, columns:
  `When` (text ISO), `Planning Event` (lookup → `grid--gYIvdD-cE`), `Actor` (lookup → `grid-X316Eql8dE`), `Target` (SelectList: `Eventbrite`,`gCal`), `Action` (SelectList: `create`,`update`,`ticket`,`structured-content`,`publish`), `Result` (SelectList: `ok`,`error`), `Eventbrite ID` (text), `Eventbrite URL` (text), `HTTP status` (number), `Message` (text).

- [ ] **Step 4: Verify** with `table_columns_read` on all three tables; record the new table id (`grid-…`) and the `Publish status`/`Address visibility` option spellings.

- [ ] **Step 5: Commit** a note capturing the ids.

```bash
git commit --allow-empty -m "chore(coda): add publish columns + Publish Log table (ids in body)

Planning cols: Capacity, Address visibility, Eventbrite Event ID/URL/Ticket Class ID,
Publish status, Last published at, Last publish error.
Venues: Eventbrite Venue ID. New table: Publish Log = grid-XXXXXX."
```

---

## Task 2: Pure Eventbrite builders + unit tests

**Files:**
- Create: `proxy/src/eventbrite.js`
- Test: `proxy/test/eventbrite.test.js`

- [ ] **Step 1: Write the failing tests**

Create `proxy/test/eventbrite.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  zonedToUtcISO, eventToEventbritePayload, ticketClassPayload,
  structuredContentBody, venuePayload, eventbriteWebUrl,
} from '../src/eventbrite.js';

const TZ = 'America/Chicago';

test('zonedToUtcISO converts Central wall-time to UTC (CDT, summer)', () => {
  assert.equal(zonedToUtcISO('2026-09-01', '18:00', TZ), '2026-09-01T23:00:00Z');
});
test('zonedToUtcISO converts Central wall-time to UTC (CST, winter, crosses midnight)', () => {
  assert.equal(zonedToUtcISO('2026-01-15', '18:00', TZ), '2026-01-16T00:00:00Z');
});

test('eventToEventbritePayload builds create body with utc+tz, currency, capacity, summary', () => {
  const ev = { title: 'Kabbalat Shabbat', date: '2026-09-01', start: '18:00', end: '20:00',
    capacity: 40, description: 'Come sing with us. '.repeat(20) };
  const p = eventToEventbritePayload(ev, TZ);
  assert.equal(p.event.name.html, 'Kabbalat Shabbat');
  assert.deepEqual(p.event.start, { timezone: TZ, utc: '2026-09-01T23:00:00Z' });
  assert.deepEqual(p.event.end, { timezone: TZ, utc: '2026-09-02T01:00:00Z' });
  assert.equal(p.event.currency, 'USD');
  assert.equal(p.event.capacity, 40);
  assert.equal(p.event.listed, true);
  assert.ok(p.event.summary.length <= 140);
});

test('ticketClassPayload — free ticket uses capacity', () => {
  assert.deepEqual(ticketClassPayload({ capacity: 40 }), {
    ticket_class: { name: 'General Admission', free: true, quantity_total: 40 },
  });
});
test('ticketClassPayload — paid tier (v2 shape) emits cost in cents', () => {
  assert.deepEqual(ticketClassPayload({ capacity: 40, ticketType: 'paid', price: 15 }), {
    ticket_class: { name: 'General Admission', cost: 'USD,1500', quantity_total: 40 },
  });
});

test('structuredContentBody wraps html in a single text module at the given version', () => {
  const b = structuredContentBody('<p>Hi</p>', 3);
  assert.equal(b.modules[0].type, 'text');
  assert.equal(b.modules[0].data.body.text, '<p>Hi</p>');
  assert.equal(b.publish, true);
});

test('venuePayload — public sends the full address', () => {
  const v = venuePayload({ name: 'JCC', address: '801 Percy Warner Blvd, Nashville, TN' }, 'Public');
  assert.equal(v.venue.name, 'JCC');
  assert.equal(v.venue.address.address_1, '801 Percy Warner Blvd, Nashville, TN');
});
test('venuePayload — registrants-only sends NO address (safety invariant)', () => {
  const v = venuePayload({ name: 'Private home', address: '123 Secret St, Nashville, TN' }, 'Registrants only');
  assert.equal(v.venue.name, 'Private home');
  assert.equal(v.venue.address, undefined);   // address must never be present
});

test('eventbriteWebUrl builds the myevent manage link', () => {
  assert.equal(eventbriteWebUrl('123456789'), 'https://www.eventbrite.com/myevent?eid=123456789');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd proxy && node --test`
Expected: FAIL — cannot resolve `../src/eventbrite.js`.

- [ ] **Step 3: Write `proxy/src/eventbrite.js`**

```js
/**
 * Pure Eventbrite v3 payload + date builders — no network, no Worker globals.
 * The rich description goes through Structured Content (event.description was
 * deprecated 2021); publish requires a ticket class + venue/online.
 */

// Offset (ms) of `tz` at a given instant: format that instant AS the tz, read it
// back as if UTC, subtract. Intl with timeZone is available in Workers and Node.
function tzOffsetMs(instant, tz) {
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(instant);
  const [d, t] = s.split(', ');
  const [mo, da, yr] = d.split('/').map(Number);
  const [hh, mi, ss] = t.split(':').map(Number);
  return Date.UTC(yr, mo - 1, da, hh, mi, ss) - instant.getTime();
}

// A local wall-clock date+time in `tz` -> a UTC ISO string 'YYYY-MM-DDTHH:MM:SSZ'.
// Two-pass to be correct across DST boundaries.
export function zonedToUtcISO(dateStr, timeStr, tz) {
  const [Y, M, D] = dateStr.split('-').map(Number);
  const [h, m] = String(timeStr || '00:00').split(':').map(Number);
  const guess = Date.UTC(Y, M - 1, D, h, m, 0);
  let utc = guess - tzOffsetMs(new Date(guess), tz);
  utc = guess - tzOffsetMs(new Date(utc), tz);
  return new Date(utc).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

// event.* create/update body. Times are exact wall-clock (HH:MM) in `tz`.
export function eventToEventbritePayload(ev, tz) {
  const summary = stripHtml(ev.description).slice(0, 140);
  return {
    event: {
      'name': { html: ev.title || '' },
      'start': { timezone: tz, utc: zonedToUtcISO(ev.date, ev.start, tz) },
      'end': { timezone: tz, utc: zonedToUtcISO(ev.date, ev.end || ev.start, tz) },
      'currency': 'USD',
      'capacity': Number(ev.capacity) || undefined,
      'listed': true,           // public by decision
      'summary': summary,
    },
  };
}

// Free (v1) or paid (v2). Paid cost is "USD,<cents>".
export function ticketClassPayload(ev) {
  const tc = { name: 'General Admission', quantity_total: Number(ev.capacity) || undefined };
  if (ev.ticketType === 'paid') tc.cost = `USD,${Math.round(Number(ev.price || 0) * 100)}`;
  else tc.free = true;
  return { ticket_class: tc };
}

// Structured Content write body: one text module carrying the description HTML.
// `versionToWrite` is the next version number (current + 1).
export function structuredContentBody(html, versionToWrite) {
  return {
    publish: true,
    modules: [{ type: 'text', data: { body: { text: String(html || '') } } }],
    // version is carried in the URL path, not the body; kept here for callers/tests
    _version: versionToWrite,
  };
}

// Venue body. SAFETY: registrants-only never includes an address.
export function venuePayload(venue, addressVisibility) {
  const v = { name: venue.name || 'Venue' };
  if (addressVisibility !== 'Registrants only' && venue.address) {
    v.address = { address_1: venue.address };
  }
  return { venue: v };
}

export function eventbriteWebUrl(eventId) {
  return `https://www.eventbrite.com/myevent?eid=${eventId}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd proxy && node --test`
Expected: PASS — all eventbrite + existing ical tests green.

- [ ] **Step 5: Commit**

```bash
git add proxy/src/eventbrite.js proxy/test/eventbrite.test.js
git commit -m "feat(proxy): pure Eventbrite payload + tz->UTC builders + unit tests"
```

> **Note on `structuredContentBody._version`:** the version number goes in the URL path (`/structured_content/{version}/`), not the body. The builder returns it as `_version` for the caller to use; strip it before POSTing (the Worker client does `const {_version, ...body} = structuredContentBody(...)`).

---

## Task 3: Worker Eventbrite I/O client

**Files:** Modify `proxy/src/worker.js` (add a client section near the bottom, after the Google-auth helpers).

- [ ] **Step 1: Add the import + client functions**

At the top of `worker.js`, extend the existing import:

```js
import { parseVEvents } from './ical.js';
import { zonedToUtcISO, eventToEventbritePayload, ticketClassPayload, structuredContentBody, venuePayload, eventbriteWebUrl } from './eventbrite.js';
```

Add a client section (thin wrappers; every call returns `{ ok, status, body }` so the route can log verbatim):

```js
const EB_BASE = 'https://www.eventbriteapi.com/v3';
async function ebFetch(env, path, method = 'GET', body) {
  const r = await fetch(`${EB_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.EVENTBRITE_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { ok: r.ok, status: r.status, body: j };
}
```

Plus small helpers the route composes: `ebCreateEvent(env, payload)` → `POST /organizations/{EVENTBRITE_ORG_ID}/events/`; `ebUpdateEvent(env, id, payload)` → `POST /events/{id}/`; `ebCreateVenue(env, payload)` → `POST /organizations/{org}/venues/`; `ebCreateTicket(env, id, payload)`/`ebUpdateTicket(env,id,tcId,payload)` → `.../ticket_classes/`; `ebGetStructuredContent(env,id)` → `GET /events/{id}/structured_content/`; `ebSetStructuredContent(env,id,version,body)` → `POST /events/{id}/structured_content/{version}/`; `ebPublish(env,id)` → `POST /events/{id}/publish/`. Each is a 1-line `ebFetch` call.

- [ ] **Step 2: Syntax check**

Run: `node --check proxy/src/worker.js`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add proxy/src/worker.js
git commit -m "feat(proxy): Eventbrite v3 I/O client wrappers"
```

---

## Task 4: Worker `POST /publish/eventbrite` route

**Files:** Modify `proxy/src/worker.js` (route in the `fetch` switch, near `/notes-doc`), `proxy/wrangler.toml`, `proxy/.dev.vars.example`.

- [ ] **Step 1: Declare config**

`proxy/.dev.vars.example` — add:
```
EVENTBRITE_TOKEN="eb-private-token"
```
`proxy/wrangler.toml` `[vars]` — add:
```
EVENTBRITE_ORG_ID = "1080997994263"
EVENTBRITE_TZ = "America/Chicago"
CODA_PUBLISH_LOG_TABLE = "grid-CJNl0A1OGZ"   # Publish Log (Task 1)
```

- [ ] **Step 2: Add the Publish-Log append helper**

```js
async function logPublish(env, base, docId, auth, rec) {
  if (!env.CODA_PUBLISH_LOG_TABLE) return;
  const cells = [
    { column: 'When', value: new Date().toISOString() },
    { column: 'Planning Event', value: rec.rowId ? [rec.rowId] : [] },
    { column: 'Actor', value: rec.actorId ? [rec.actorId] : [] },
    { column: 'Target', value: 'Eventbrite' },
    { column: 'Action', value: rec.action },
    { column: 'Result', value: rec.ok ? 'ok' : 'error' },
    { column: 'Eventbrite ID', value: rec.ebId || '' },
    { column: 'Eventbrite URL', value: rec.ebUrl || '' },
    { column: 'HTTP status', value: rec.status || 0 },
    { column: 'Message', value: rec.message || '' },
  ];
  try {
    await fetch(`${base}/docs/${docId}/tables/${env.CODA_PUBLISH_LOG_TABLE}/rows`,
      { method: 'POST', headers: auth, body: JSON.stringify({ rows: [{ cells }] }) });
  } catch (_) { /* logging must never break the publish path */ }
}
```

- [ ] **Step 3: Add the route** (in the `fetch` switch)

```js
if (parts[0] === 'publish' && parts[1] === 'eventbrite' && request.method === 'POST') {
  if (env.ALLOW_WRITES !== 'true') return json({ error: 'writes disabled' }, 403, cors);
  if (!env.EVENTBRITE_TOKEN || !env.EVENTBRITE_ORG_ID) return json({ error: 'eventbrite not configured' }, 500, cors);
  let id; try { id = await authIdentity(request, env, base, docId, auth); }
  catch (e) { return json({ error: 'invalid token' }, 401, cors); }
  if (!id || !id.canWrite) return json({ error: 'not authorized' }, 403, cors);

  let body; try { body = JSON.parse((await request.text()) || '{}'); } catch (e) { return json({ error: 'bad body' }, 400, cors); }
  const rowId = body.rowId;
  if (!rowId) return json({ error: 'rowId required' }, 400, cors);

  // Load the planning row; enforce approved + exact date/time preconditions.
  const rowsUrl = `${base}/docs/${docId}/tables/${tableId}/rows`;
  const one = await fetch(`${rowsUrl}/${encodeURIComponent(rowId)}?useColumnNames=true&valueFormat=simpleWithArrays`, { headers: auth });
  if (!one.ok) return json({ error: 'row not found' }, 404, cors);
  const row = await one.json();
  const V = row.values || {};
  if (String(V['Status'] || '').toLowerCase() !== 'approved') return json({ error: 'event must be Approved before publishing' }, 409, cors);
  if (String(V['Scheduling'] || 'Exact').toLowerCase() !== 'exact' || !V['Date'] || !V['Start'])
    return json({ error: 'publish needs an exact date and start time' }, 409, cors);

  const setRow = (cells) => fetch(`${rowsUrl}/${encodeURIComponent(rowId)}`, { method: 'PUT', headers: auth, body: JSON.stringify({ row: { cells } }) });
  const fail = async (action, r) => {
    const msg = (r.body && (r.body.error_description || r.body.error)) || `HTTP ${r.status}`;
    await setRow([{ column: 'Publish status', value: 'Error' }, { column: 'Last publish error', value: String(msg) }]);
    await logPublish(env, base, docId, auth, { rowId, actorId: id.personId, action, ok: false, status: r.status, message: String(msg) });
    return json({ error: msg, step: action }, 502, cors);
  };
```

Then the orchestration (pseudocode-precise; each `ebX` returns `{ok,status,body}`):

```js
  // normalize the few fields we need off the row
  const ev = {
    title: V['Title'] || '', date: String(V['Date']).slice(0, 10),
    start: (String(V['Start']).match(/(?:T|^)(\d{2}:\d{2})/) || [])[1] || '',
    end:   (String(V['End']  || '').match(/(?:T|^)(\d{2}:\d{2})/) || [])[1] || '',
    capacity: Number(V['Capacity']) || undefined,
    description: V['Event Description'] || '',
    addressVisibility: V['Address visibility'] || 'Public',
    ebId: V['Eventbrite Event ID'] || '', tcId: V['Eventbrite Ticket Class ID'] || '',
  };
  const tz = env.EVENTBRITE_TZ || 'America/Chicago';
  await setRow([{ column: 'Publish status', value: 'Publishing' }]);

  // 1. create-once (store id immediately)
  let ebId = ev.ebId;
  if (!ebId) {
    const r = await ebCreateEvent(env, eventToEventbritePayload(ev, tz));
    if (!r.ok) return fail('create', r);
    ebId = r.body.id;
    await setRow([{ column: 'Eventbrite Event ID', value: ebId }, { column: 'Eventbrite URL', value: eventbriteWebUrl(ebId) }]);
    await logPublish(env, base, docId, auth, { rowId, actorId: id.personId, action: 'create', ok: true, status: r.status, ebId, ebUrl: eventbriteWebUrl(ebId) });
  } else {
    const r = await ebUpdateEvent(env, ebId, eventToEventbritePayload(ev, tz));
    if (!r.ok) return fail('update', r);
  }

  // 2. venue (public → address; registrants-only → name only; none → online)
  //    Resolve the venue row from V['Venue'] relation → read EST Venues SRC for
  //    Venue Name + Address (+ cached Eventbrite Venue ID). If no venue, set
  //    event.online_event=true via ebUpdateEvent. Cache new EB venue id back to
  //    the venue row. (Full venue resolution detailed in step 4.)

  // 3. ticket class (free v1)
  if (!ev.tcId) {
    const r = await ebCreateTicket(env, ebId, ticketClassPayload(ev));
    if (!r.ok) return fail('ticket', r);
    await setRow([{ column: 'Eventbrite Ticket Class ID', value: r.body.id }]);
  } else {
    const r = await ebUpdateTicket(env, ebId, ev.tcId, ticketClassPayload(ev));
    if (!r.ok) return fail('ticket', r);
  }

  // 4. structured content (description body) — read version, write version+1
  const sc = await ebGetStructuredContent(env, ebId);
  const ver = ((sc.body && sc.body.page_version_number) || 0) + 1;
  const { _version, ...scBody } = structuredContentBody(ev.description, ver);
  const scr = await ebSetStructuredContent(env, ebId, ver, scBody);
  if (!scr.ok) return fail('structured-content', scr);

  // 5. publish
  const pub = await ebPublish(env, ebId);
  if (!pub.ok) return fail('publish', pub);

  // 6. success write-back + log
  await setRow([
    { column: 'Publish status', value: 'Published' }, { column: 'Published?', value: true },
    { column: 'Last published at', value: new Date().toISOString() }, { column: 'Last publish error', value: '' },
  ]);
  await logPublish(env, base, docId, auth, { rowId, actorId: id.personId, action: 'publish', ok: true, status: pub.status, ebId, ebUrl: eventbriteWebUrl(ebId) });
  return json({ ok: true, eventbriteId: ebId, url: eventbriteWebUrl(ebId) }, 200, cors);
}
```

- [ ] **Step 4: Implement venue resolution** (the one non-trivial gap in step 3's comment)

Add a helper that, given `V['Venue']` (relation display-name array) and address visibility, ensures an Eventbrite venue and returns a venue id or null (→ online):
- Read `EST Venues SRC` (`grid-foC40iAOaX`) rows once (reuse `readAllRows`), find the row whose `Venue Name` matches; read `Address` (`c-19lFeKZu_W` by name `Address`), `Eventbrite Venue ID`.
- If it already has an `Eventbrite Venue ID`, use it.
- Else `ebCreateVenue(env, venuePayload({name, address}, addressVisibility))`; on ok, write the returned venue id back to that venue row (`Eventbrite Venue ID`) and use it.
- Set it via `ebUpdateEvent(env, ebId, { event: { venue_id } })`. If no venue at all, `ebUpdateEvent(env, ebId, { event: { online_event: true } })`.
- Any failure → `fail('venue', r)`.

- [ ] **Step 5: Syntax check + node check**

Run: `node --check proxy/src/worker.js`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add proxy/src/worker.js proxy/wrangler.toml proxy/.dev.vars.example
git commit -m "feat(proxy): POST /publish/eventbrite — orchestration, write-back, Publish Log"
```

---

## Task 5: App — model, editor fields, publish button

**Files:** Modify `web/app.js`, `web/styles.css`.

- [ ] **Step 1: Extend the event model**

In `planningRowToEvent` (after `description`): add
```js
    capacity: Number(v['Capacity']) || '',
    addressVisibility: v['Address visibility'] || 'Public',
    publishStatus: v['Publish status'] || 'Unpublished',
    eventbriteUrl: (typeof v['Eventbrite URL'] === 'string' ? v['Eventbrite URL'] : '') || '',
    eventbriteId: v['Eventbrite Event ID'] || '',
    lastPublishError: v['Last publish error'] || '',
```
(remove the placeholder `eventbriteUrl:''` on the line that currently hardcodes it.)

In `eventToCodaCells` add:
```js
    {column:'Capacity',          value:e.capacity===''||e.capacity==null?'':Number(e.capacity)},
    {column:'Address visibility',value:e.addressVisibility||'Public'},
```
(Do **not** write the Eventbrite/publish-status columns from the app — those are Worker-owned.)

- [ ] **Step 2: Add `DB.publishEventbrite`**

```js
  async publishEventbrite(rowId){ const r=await fetch(`${this.base}/publish/eventbrite`,{method:'POST',headers:this._wh(),body:JSON.stringify({rowId})}); const j=await r.json().catch(()=>({})); if(!r.ok){ const e=new Error(j.error||`publish failed (${r.status})`); e.status=r.status; throw e; } return j; },
```

- [ ] **Step 3: Editor fields + publish panel** (in `openEditor`, planning branch)

Add, for `canEdit` events: a **Capacity** number input (`f_capacity`) and an **Address visibility** segmented control (`f_addrvis`, Public / Registrants only), collected in `readForm()`.

Add a **publish panel** shown only when `ev.status==='approved'` and `canEdit`, modeled on `notesDocPanelHTML`:
- Not linked (`!ev.eventbriteId`): a **Publish to Eventbrite** button (`data-act="publish-eb"`).
- Linked: **Open in Eventbrite ↗** (`ev.eventbriteUrl`) + an **Update Eventbrite** button + a status badge (`ev.publishStatus`); copy: "Opens this event in Eventbrite — on your phone, tap through to Check-In in the Eventbrite Organizer app."
- Error: show `ev.lastPublishError`.

- [ ] **Step 4: Wire the button handler**

Where editor actions are handled, add for `data-act="publish-eb"`: save first if dirty, then `await DB.publishEventbrite(ev.id)` under a spinner/toast ("Publishing…"→"Published"/error), then `refresh()` so the new status + link render. Surface `err.message` verbatim on failure.

- [ ] **Step 5: Styles** — add a `.publish-panel` block reusing `.locknote`/`.badge` idioms in `web/styles.css`.

- [ ] **Step 6: Node check**

Run: `node --check web/app.js`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add web/app.js web/styles.css
git commit -m "feat(app): capacity + address-visibility fields, Publish/Update Eventbrite panel"
```

---

## Task 6: End-to-end verify (real EST org) + observability

**Files:** none (verification).

- [ ] **Step 1: Set the secret + deploy** — `cd proxy && npx wrangler secret put EVENTBRITE_TOKEN` (Eric's EST private token), then `npx wrangler deploy`. Confirm `curl -s -X POST .../publish/eventbrite` without auth → 403.

- [ ] **Step 2: Serve the app locally**, sign in as a lead (Eric), pick an **Approved** exact-date test event with a capacity, click **Publish to Eventbrite**.

- [ ] **Step 3: Verify in Eventbrite** (via `read_page`/browser or the org dashboard): the event exists, is **published**, has the title, start/end in Central time, a free General Admission ticket at the capacity, and the description body. For a **registrants-only** test event, confirm the public listing shows **no street address**.

- [ ] **Step 4: Verify observability** — planning row shows `Publish status=Published`, `Eventbrite URL`, `Last published at`; the `Publish Log` table has create + publish `ok` rows with the actor. Force one failure (e.g. a row missing capacity) and confirm an `error` row + `Last publish error` populated.

- [ ] **Step 5: Verify idempotency** — click **Update Eventbrite**; confirm no second event is created (same `Eventbrite Event ID`), fields update.

- [ ] **Step 6: Clean up** — unpublish/delete the Eventbrite test event(s); clear the test row's publish fields.

- [ ] **Step 7: Screenshot proof** and share with the user.

---

## Task 7: Docs

**Files:** Modify `CLAUDE.md`.

- [ ] **Step 1: Revise principle #3** — from "Downstream lives in Superhuman Docs, not here" to: downstream **publish** is a **server-side Worker** concern (never the browser); the Eventbrite/gCal push runs in the proxy on demand; Coda remains the aggregation + observability store (the pack still syncs Eventbrite → Coda for metrics).

- [ ] **Step 2: Add a short "Eventbrite publish" note** to Current status + the secrets list (`EVENTBRITE_TOKEN`), and the token/rotation reminder.

- [ ] **Step 3: Commit + open PR**

```bash
git push -u origin feat/eventbrite-publish
gh pr create --title "Publish to Eventbrite (v1: create + free ticket + publish, direct-from-Worker)" --body "Implements docs/superpowers/specs/2026-08-22-eventbrite-publish-design.md."
```

---

## Self-Review

**Spec coverage:** create+publish (Tasks 2–4), free ticket (§ticketClassPayload), capacity (model+editor), venue + address-visibility safety (Task 4 step 4 + venuePayload test), Structured Content versioning (Task 4 step 3 #4), idempotency (create-once + stored ids, Task 6 step 5), observability (Publish Log + row fields + in-app errors, Tasks 4/5), gating (Approved + canWrite + exact date/time, Task 4 step 3), config/secret + key rotation (Tasks 4/7), Open-in-Eventbrite web link (Task 5). Deferred correctly: banner, templates, gCal, paid tickets (builder stubbed for v2), address delivery.

**Placeholder scan:** the only intentional deferral is the `grid-XXXXXX` Publish-Log id, filled in Task 1 and threaded to Task 4 config — flagged, not a gap. Venue resolution is spelled out in Task 4 step 4 rather than left vague.

**Type consistency:** `eventToEventbritePayload(ev, tz)`, `ticketClassPayload(ev)`, `venuePayload(venue, addressVisibility)`, `structuredContentBody(html, version)` signatures match their call sites in Task 4. Row-status column names match Task 1's schema and §6 of the spec. `Publish status` option spellings (`Publishing`/`Published`/`Error`) are consistent between schema (Task 1) and route (Task 4).
