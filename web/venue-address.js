/* venue-address.js — shared structured-address rules for venues.
   Pure (no DOM, no fetch, no browser globals): loaded by the app as a script tag,
   imported for side effects by the Worker, and by node tests
   (proxy/test/venue-address.test.js). Attaches `VenueAddress` to globalThis.

   - normalize(a): trim, collapse spaces, uppercase state
   - compose(a): "Street, Unit, City, ST ZIP", empty parts omitted
   - validate(a, {allowBlank}): {ok, errors}
   - hasAddress(v): structured Street+City, else a non-blank legacy `address`
   - sameName(a, b): case-insensitive, whitespace-collapsed equality
   - zipText(z): a ZIP cell as text; Coda may hand back a number (2134), so pad it to 5 digits ("02134")
   - mergeVenues(fresh, local, keepIds): the app's venue list after a fresh /ref/venues read —
     the fresh list, plus any local entry whose id is in keepIds (added or changed here)
     that the fresh list doesn't have yet; an id in both comes from the fresh list
   - offerAdd(typed, venues): the venue picker offers + Add "<typed>" as a venue —
     something typed, and no venue (closed or not, any type) has that name */
(function (root) {
  // USPS codes (50 states + DC + PR). The Worker's address parser (proxy/src/eventbrite.js) uses this set too.
  const US_STATES = new Set(('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT ' +
    'NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR').split(' '));
  const clean = v => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();

  function normalize(a) {
    a = a || {};
    return { street: clean(a.street), unit: clean(a.unit), city: clean(a.city),
      state: clean(a.state).toUpperCase(), zip: clean(a.zip) };
  }

  function compose(a) {
    const n = normalize(a);
    const stateZip = [n.state, n.zip].filter(Boolean).join(' ');
    return [n.street, n.unit, n.city, stateZip].filter(Boolean).join(', ');
  }

  function validate(a, opts) {
    const n = normalize(a);
    const allowBlank = !!(opts && opts.allowBlank);
    if (allowBlank && !n.street && !n.unit && !n.city && !n.state && !n.zip) return { ok: true, errors: {} };
    const errors = {};
    if (!n.street) errors.street = 'Add the street';
    if (!n.city) errors.city = 'Add the city';
    if (!/^[A-Z]{2}$/.test(n.state) || !US_STATES.has(n.state)) errors.state = 'Use the 2-letter state (e.g. TN)';
    if (n.zip && !/^\d{5}(-\d{4})?$/.test(n.zip)) errors.zip = 'ZIP is 5 digits';
    return { ok: Object.keys(errors).length === 0, errors };
  }

  function hasAddress(v) {
    v = v || {};
    if (clean(v.street) && clean(v.city)) return true;
    return !!clean(v.address);
  }

  const sameName = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();

  const zipText = z => (Array.isArray(z) ? zipText(z[0]) : typeof z === 'number' ? String(z).padStart(5, '0') : clean(z));

  function mergeVenues(fresh, local, keepIds) {
    const list = (fresh || []).filter(Boolean);
    const have = new Set(list.map(v => v.id));
    const keep = new Set(keepIds || []);
    return list.concat((local || []).filter(v => v && keep.has(v.id) && !have.has(v.id)));
  }

  const offerAdd = (typed, venues) => !!clean(typed) && !(venues || []).some(v => v && sameName(v.name, typed));

  root.VenueAddress = { normalize, compose, validate, hasAddress, sameName, offerAdd, zipText, mergeVenues, US_STATES };
})(globalThis);
