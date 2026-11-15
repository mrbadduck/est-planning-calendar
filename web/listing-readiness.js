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

  // ---- footer wizard model (spec 5.5) ----
  const STEP_LABELS = ['Draft', 'Proposed', 'Approved', 'On Eventbrite', 'Published'];
  const STAGE_INDEX = { draft: 0, proposed: 1, approved: 2, onEventbrite: 3, published: 4 };
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

  // Shown when the listing was edited on Eventbrite since our last push (D8): the
  // footer and the app's listing card use this one text.
  const EB_CONFLICT_NOTICE = 'Someone changed this listing on Eventbrite since your last update. Updating will replace their changes.';

  function footerModel(input) {
    const { stage, past, checks, pending, sending, ebEditedElsewhere, registrants, proposedBy, justChanged } = input;
    const role = input.role || {};
    const unpushed = input.unpushed || [];
    const canEdit = !!role.canEdit, canApprove = !!role.canApprove;
    const cur = STAGE_INDEX[stage];
    const steps = STEP_LABELS.map((label, i) => ({ label,
      state: cur == null ? 'todo' : i < cur ? 'done' : i === cur ? 'current' : 'todo' }));
    const failing = list => (list || []).filter(c => !c.ok);
    const toLinks = list => list.map(c => ({ field: c.field, label: c.message }));
    const prim = (label, act, enabled, tone) => ({ label, act, enabled, tone });
    const savedText = prim('✓ Saved', null, false, 'quiet');
    const out = { steps, title: '', sub: '', links: [], primary: null, secondary: null, menu: [] };
    const del = sub => ({ act: 'delete', label: 'Delete event', sub: sub || '', tone: 'danger' });
    const addFail = failing(checks && checks.add), pubFail = failing(checks && checks.publish);
    const nUn = unpushed.length;
    const unNote = nUn === 1 ? "1 change isn't on Eventbrite yet" : nUn + " changes aren't on Eventbrite yet";
    const regLine = () => {
      const base = 'Published · registration open';
      if (registrants == null) return base;
      return input.capacity ? base + ' · ' + registrants + ' of ' + input.capacity + ' registered'
        : base + ' · ' + plural(registrants, 'registered', 'registered');
    };

    switch (stage) {
      case 'draft':
        out.title = 'Draft: only leads can see this';
        out.sub = 'Propose it when the plan is ready. Rough dates are fine for now.';
        if (canEdit) { out.primary = prim('Propose to council', 'propose', true, 'primary'); out.menu.push(del()); }
        break;
      case 'proposed':
        if (canApprove) {
          out.title = 'Needs your approval';
          const by = proposedBy && proposedBy.name, on = proposedBy && proposedBy.date;
          out.sub = 'Proposed' + (on ? ' ' + on : '') + (by ? ' by ' + by : '') +
            '. Approving lets the lead add it to Eventbrite and publish it.';
          out.primary = prim('Approve', 'approve', true, 'primary');
        } else {
          out.title = 'Awaiting Tribal Council approval';
          out.sub = 'You can keep editing meanwhile. This footer changes as soon as council approves.';
          if (canEdit) out.primary = savedText;
        }
        if (canEdit) out.menu.push(del());
        break;
      case 'approved':
        if (addFail.length) {
          out.title = 'Approved. ' + plural(addFail.length, 'thing', 'things') + ' left before Eventbrite';
          out.sub = 'Then Add to Eventbrite creates a private draft. Nobody sees it until you publish.';
          out.links = toLinks(addFail);
        } else {
          out.title = 'Ready for Eventbrite';
          out.sub = 'Adding creates a private draft listing. Nobody can see it until you publish.';
        }
        if (canEdit) {
          out.primary = prim('Add to Eventbrite', 'add-eb', addFail.length === 0, 'go');
          out.menu.push(del());
        }
        break;
      case 'onEventbrite': {
        out.title = 'On Eventbrite as a private draft';
        out.sub = 'Preview shows exactly what Eventbrite has. Publish makes it public and opens registration.';
        if (nUn) out.sub += ' ' + unNote + '.';
        if (ebEditedElsewhere) out.sub += ' ' + EB_CONFLICT_NOTICE;
        if (canEdit) {
          if (nUn) {
            out.primary = prim('Update draft', 'update-eb', addFail.length === 0, 'primary');
            out.links = toLinks(addFail);
          } else {
            out.primary = prim('Publish', 'publish-eb', pubFail.length === 0, 'go');
            out.links = toLinks(pubFail);
          }
          out.secondary = { label: 'Preview listing', act: 'preview-eb' };
          out.menu.push(del('Also deletes the Eventbrite draft'));
        }
        break;
      }
      case 'published':
        if (nUn) {
          out.title = unNote;
          out.sub = regLine() + '. Not on Eventbrite yet: ' +
            unpushed.map(k => (FIELDS[k] ? FIELDS[k].label : k)).join(', ') + '.';
        } else {
          out.title = regLine();
          out.sub = '';
        }
        if (ebEditedElsewhere) out.sub += (out.sub ? ' ' : '') + EB_CONFLICT_NOTICE;
        if (canEdit) {
          if (nUn) {
            out.primary = prim('Update listing', 'update-listing', pubFail.length === 0, 'primary');
            out.links = toLinks(pubFail);
          } else out.primary = savedText;
          if (registrants == null || registrants === 0)
            out.menu.push({ act: 'unpublish', label: 'Unpublish (back to private)', sub: 'Only possible while nobody has registered', tone: 'normal' });
          out.menu.push({ act: 'cancel', label: 'Cancel event…', sub: 'Cancels the listing and notifies registrants', tone: 'danger' });
        }
        break;
      case 'cancelled':
        out.title = 'Cancelled';
        out.sub = canApprove ? 'Reopen it to plan it again, or delete it for good.' : 'Tribal Council can reopen or delete it.';
        if (canApprove) { out.primary = prim('Reopen', 'reopen', true, 'primary'); out.menu.push(del()); }
        break;
    }

    // A past event has happened: nothing left to do at any stage (R10). The only
    // exception is the offer to tell registrants about a change, below.
    if (past) {
      out.primary = null; out.secondary = null; out.menu = []; out.links = [];
    }
    if (justChanged && justChanged.fields && justChanged.fields.length && (stage === 'published' || stage === 'onEventbrite') && canEdit) {
      const names = justChanged.fields.map(k => (FIELDS[k] ? FIELDS[k].label : k).toLowerCase());
      const what = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0];
      out.title = 'The ' + what + (names.length > 1 ? ' changed' : ' changed') + '. Let the ' +
        plural(justChanged.registrants || 0, 'registrant', 'registrants') + ' know?';
      out.sub = '';
      out.primary = prim('Email registrants', 'email-registrants', true, 'primary');
      out.secondary = { label: 'Not now', act: 'dismiss-notice' };
    }
    if (sending && out.primary) out.primary = prim('Sending to Eventbrite…', null, false, 'primary');   // a push in flight
    else if (pending && out.primary) out.primary = prim('Saving…', null, false, 'primary');   // no action to hold back → nothing to show
    return out;
  }

  // ---- change notice for registrants (date/time/venue only) ----
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function fmtDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(iso));
    if (!m) return str(iso);
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return DAYS[d.getUTCDay()] + ', ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate();
  }
  function fmtTime(t) {
    const m = /^(\d{1,2}):(\d{2})/.exec(str(t));
    if (!m) return str(t);
    const h = +m[1];
    return ((h % 12) || 12) + ':' + m[2] + ' ' + (h < 12 ? 'AM' : 'PM');
  }

  function changeNotice(before, after, ev) {
    before = before || {}; after = after || {};
    const defs = [
      ['date', 'Date', fmtDate, o => o.date],
      ['start', 'Start time', fmtTime, o => o.start],
      ['end', 'End time', fmtTime, o => o.end],
      ['venue', 'Where', v => str(v) || 'Online', o => o.venueName],
    ];
    const fields = [], lines = [];
    for (const [key, label, fmt, get] of defs) {
      const a = str(get(before)), b = str(get(after));
      if (a === b) continue;
      fields.push(key);
      lines.push(label + ': ' + fmt(a) + ' → ' + fmt(b));
    }
    const title = (ev && ev.title) || after.title || before.title || '';
    const date = after.date || (ev && ev.date) || before.date;
    return {
      subject: 'Update: ' + title + ' on ' + fmtDate(date),
      body: lines.join('\n') + (lines.length ? '\n\n' : '') + 'See you there!',
      fields,
    };
  }

  root.ListingRules = { stageOf, FIELDS, readiness, addressVisibilityDefault, syncStatus, unpushedFields, footerModel, changeNotice, fmtDate, fmtTime, EB_CONFLICT_NOTICE };
})(typeof globalThis !== 'undefined' ? globalThis : this);
