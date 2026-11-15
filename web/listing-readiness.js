/* listing-readiness.js — shared rules for the Eventbrite publish flow.
   Pure (no DOM, no fetch, no browser globals): loaded by the app as a script tag,
   imported for side effects by the Worker, and by node tests
   (proxy/test/listing-readiness.test.js). Attaches `ListingRules` to globalThis.

   - stageOf(ev): where an event is in its life (spec 5.1)
   - FIELDS: field registry; `public` ones are what gets pushed to Eventbrite
   - readiness(ev, {venue, todayISO}): the checks the footer, fields and Worker share
   - addressVisibilityDefault(current, venue): Home venues default to Registrants only
   - syncStatus / unpushedFields: compare the event with the last pushed snapshot */
// Dates are YYYY-MM-DD and times zero-padded HH:MM: string comparison relies on it.
(function (root) {
  const blank = v => v == null || String(v).trim() === '';
  const str = v => (v == null ? '' : String(v).trim());

  function stageOf(ev) {
    const s = ev && ev.status;
    if (s === 'cancelled') return 'cancelled';
    if (s === 'draft') return 'draft';
    if (s === 'proposed') return 'proposed';
    if (s === 'approved') {
      if (!ev.eventbriteId) return 'approved';
      return ev.publishStatus === 'Published' ? 'published' : 'onEventbrite';
    }
    return 'draft';
  }

  const pub = label => ({ label, public: true });
  const FIELDS = {
    title: pub('Title'),
    description: { label: 'Internal description', public: false },
    programs: { label: 'Program(s)', public: false },
    leads: { label: 'Leads', public: false },
    date: pub('Date'),
    start: pub('Start time'),
    end: pub('End time'),
    venue: pub('Venue'),
    publicSummary: pub('Public summary'),
    publicDescription: pub('Public description'),
    capacity: pub('Capacity'),
    addressVisibility: pub('Address visibility'),
  };
  for (const k of Object.keys(FIELDS)) if (FIELDS[k].public) FIELDS[k].pushedKey = k;
  FIELDS.venue.pushedKey = 'venueName'; // the pushed snapshot stores the venue as venueName

  // Value of a FIELDS key on an app event (venue is stored as venueName).
  const evValue = (ev, key) => (key === 'venue' ? ev.venueName : ev[key]);

  const wholeNumber = v => {
    const s = str(v);
    return /^\d+$/.test(s) && Number(s) >= 1;
  };

  function readiness(ev, opts) {
    const venue = (opts && opts.venue) || null;
    const todayISO = opts && opts.todayISO;
    const chk = (key, field, ok, message) => ({ key, field, ok: !!ok, message });
    const hasDate = !blank(ev.date), hasStart = !blank(ev.start), hasEnd = !blank(ev.end);
    const vis = str(ev.addressVisibility);
    const add = [
      chk('approved', null, ev.status === 'approved', 'Needs Tribal Council approval first'),
      chk('title', 'title', !blank(ev.title), 'Add a title'),
      chk('exact', 'date', ev.scheduling === 'exact' && !ev.allDay,
        "Pick an exact date and times (Eventbrite can't list a range, month or all-day event)"),
      chk('date', 'date', hasDate, 'Add a date'),
      chk('future', 'date', !hasDate || !todayISO || str(ev.date) >= todayISO, "Pick a date that hasn't passed"),
      chk('start', 'start', hasStart, 'Add a start time'),
      chk('end', 'end', hasEnd, 'Add an end time'),
      chk('endAfterStart', 'end', !hasStart || !hasEnd || str(ev.end) > str(ev.start), 'End time must be after the start time'),
      chk('capacity', 'capacity', wholeNumber(ev.capacity), 'Add a capacity: how many free tickets Eventbrite offers'),
      chk('venueOther', 'venue', blank(ev.venueOther) || !blank(ev.venueName),
        'Add this venue to Venues first, so Eventbrite gets its address'),
      chk('venueAddress', 'venue', !venue || !(vis === '' || vis === 'Public') || venue.hasAddress,
        'Add a street address to the venue, or choose Registrants only'),
    ];
    const publish = add.concat([
      chk('publicDescription', 'publicDescription', !blank(ev.publicDescription),
        'Add a public description (Eventbrite requires one to publish)'),
    ]);
    return { add, publish };
  }

  function addressVisibilityDefault(current, venue) {
    if (blank(current) && venue && venue.type === 'Home') return 'Registrants only';
    return current;
  }

  function sameValue(key, a, b) {
    if (key === 'capacity') {
      const n = v => (blank(v) ? null : Number(str(v)));
      const x = n(a), y = n(b);
      if (x === null || y === null) return x === y;
      if (Number.isFinite(x) && Number.isFinite(y)) return x === y;
      return str(a) === str(b);
    }
    return str(a) === str(b);
  }

  function syncStatus(ev, pushed) {
    const out = {};
    for (const key of Object.keys(FIELDS)) {
      if (!FIELDS[key].public) continue;
      out[key] = pushed == null ? 'unknown'
        : sameValue(key, evValue(ev, key), pushed[FIELDS[key].pushedKey]) ? 'match' : 'changed';
    }
    return out;
  }

  function unpushedFields(ev, pushed) {
    const s = syncStatus(ev, pushed);
    return Object.keys(FIELDS).filter(k => s[k] === 'changed');
  }

  root.ListingRules = { stageOf, FIELDS, readiness, addressVisibilityDefault, syncStatus, unpushedFields };
})(typeof globalThis !== 'undefined' ? globalThis : this);
