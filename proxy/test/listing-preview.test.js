// web/listing-preview.js is a plain browser script that attaches `ListingPreview`
// to globalThis — importing it for side effects makes it testable under node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../web/listing-preview.js';

const { fromForm, textToHtml, AREA } = globalThis.ListingPreview;

const ev = (o = {}) => ({
  title: 'Shabbat Dinner', publicSummary: 'Dinner together', publicDescription: 'Come eat.\n\nBring a friend.',
  scheduling: 'exact', allDay: false, date: '2027-03-05', start: '18:30', end: '21:00',
  venueName: 'EST Hall', venueOther: '', addressVisibility: 'Public', capacity: 40, ...o,
});

test('fromForm: the previewModel shape the Worker sends', () => {
  const m = fromForm(ev(), { timezone: 'America/Chicago' });
  assert.deepEqual(Object.keys(m).sort(),
    ['descriptionHtml', 'endLocal', 'local', 'location', 'logoUrl', 'name', 'startLocal', 'status', 'summary', 'tickets', 'timezone']);
  assert.equal(m.local, true);
  assert.equal(m.name, 'Shabbat Dinner');
  assert.equal(m.summary, 'Dinner together');
  assert.equal(m.startLocal, '2027-03-05T18:30:00');
  assert.equal(m.endLocal, '2027-03-05T21:00:00');
  assert.equal(m.timezone, 'America/Chicago');
  assert.equal(m.status, 'draft');
  assert.equal(m.logoUrl, null);
  assert.deepEqual(m.tickets, [{ name: 'General Admission', free: true, quantityTotal: 40 }]);
});

test('fromForm: public address shows the venue name; the street address lives on Eventbrite', () => {
  const m = fromForm(ev());
  assert.deepEqual(m.location, { online: false, name: 'EST Hall', displayAddress: '', note: 'Full address shown on Eventbrite' });
});

test('fromForm: registrants only shows just the area, never the venue name', () => {
  const m = fromForm(ev({ addressVisibility: 'Registrants only', venueName: "Anna's House" }));
  assert.deepEqual(m.location, { online: false, name: '', displayAddress: AREA, note: 'Full address shown to registrants only' });
  assert.equal(AREA, 'Nashville, TN');
});

test('fromForm: a private home with no choice yet lists as registrants only (R14)', () => {
  const m = fromForm(ev({ addressVisibility: '', venueName: "Anna's House" }), { venue: { type: 'Home' } });
  assert.equal(m.location.name, '');
  assert.equal(m.location.displayAddress, AREA);
  const pub = fromForm(ev({ addressVisibility: 'Public', venueName: "Anna's House" }), { venue: { type: 'Home' } });
  assert.equal(pub.location.name, "Anna's House");   // an explicit Public is never overridden
});

test('fromForm: no venue is an online event; Venue (other) shows its name', () => {
  assert.deepEqual(fromForm(ev({ venueName: '' })).location, { online: true, name: '', displayAddress: '' });
  assert.equal(fromForm(ev({ venueName: '', venueOther: 'The Park' })).location.name, 'The Park');
});

test('fromForm: no free tickets → no ticket line', () => {
  for (const c of ['', 0, '0', null, 'abc']) assert.deepEqual(fromForm(ev({ capacity: c })).tickets, [], String(c));
  assert.equal(fromForm(ev({ capacity: '25' })).tickets[0].quantityTotal, 25);
});

test('fromForm: all-day or not an exact date', () => {
  const a = fromForm(ev({ allDay: true, start: '', end: '' }));
  assert.equal(a.startLocal, '2027-03-05'); assert.equal(a.endLocal, '');
  const r = fromForm(ev({ scheduling: 'range', date: '' }));
  assert.equal(r.startLocal, ''); assert.equal(r.endLocal, '');
});

test('fromForm: blank title and summary', () => {
  const m = fromForm(ev({ title: '  ', publicSummary: '' }));
  assert.equal(m.name, ''); assert.equal(m.summary, '');
});

test('textToHtml: escapes, blank lines make paragraphs, single newlines <br>', () => {
  assert.equal(textToHtml('Come eat.\n\nBring a friend.'), '<p>Come eat.</p><p>Bring a friend.</p>');
  assert.equal(textToHtml('Line one\nline two'), '<p>Line one<br>line two</p>');
  assert.equal(textToHtml('<script>alert(1)</script> & "x"'), '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;</p>');
  assert.equal(textToHtml('\r\n\r\n  \n'), '');
  assert.equal(textToHtml(null), '');
});

test('fromForm: description goes through textToHtml (escaped)', () => {
  assert.equal(fromForm(ev({ publicDescription: '<b>hi</b>' })).descriptionHtml, '<p>&lt;b&gt;hi&lt;/b&gt;</p>');
});

test('the escaped description survives ListingHtml.sanitize unchanged', async () => {
  await import('../../web/listing-html.js');
  const h = textToHtml('a < b & <img src=x onerror=alert(1)>\n\nok');
  assert.equal(globalThis.ListingHtml.sanitize(h), h);
});
