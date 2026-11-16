/* listing-preview.js — the listing preview before an event is on Eventbrite (R26).
   Pure (no DOM): node-tested in proxy/test/listing-preview.test.js. Attaches
   `ListingPreview` to globalThis (same shape as save-queue.js).

   fromForm(ev, {timezone, venue}) -> model
     Maps the plan app's own fields (a readForm() event) to the same shape the
     Worker's previewModel (proxy/src/publish.js) builds from Eventbrite, so one
     renderer draws both. `local: true` marks it as built here. The app has no
     street addresses (the Worker keeps them), so a Public venue shows its name
     and a note; Registrants only shows just the area, as the Worker lists it.
     `venue` ({type}) applies the private-home default when nothing is chosen (R14).
   textToHtml(text) -> string
     Plain text to escaped HTML: blank lines split paragraphs, other newlines <br>. */
(function (root) {
  const AREA = 'Nashville, TN';   // the Worker's default area for a Registrants-only venue
  const str = v => (v == null ? '' : String(v).trim());
  const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function textToHtml(text) {
    const paras = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split(/\n\s*\n/)
      .map(p => p.trim()).filter(Boolean);
    return paras.map(p => '<p>' + p.split('\n').map(l => escHtml(l.trim())).join('<br>') + '</p>').join('');
  }

  function fromForm(ev, opts) {
    ev = ev || {}; opts = opts || {};
    const exact = (ev.scheduling || 'exact') === 'exact';
    const date = exact ? str(ev.date) : '';
    const timed = date && !ev.allDay;
    const at = t => (timed && str(t) ? date + 'T' + str(t) + ':00' : '');
    const venueName = str(ev.venueName) || str(ev.venueOther);
    let vis = str(ev.addressVisibility);
    if (!vis && opts.venue && opts.venue.type === 'Home') vis = 'Registrants only';
    const location = !venueName ? { online: true, name: '', displayAddress: '' }
      : vis === 'Registrants only'
        ? { online: false, name: '', displayAddress: AREA, note: 'Full address shown to registrants only' }
        : { online: false, name: venueName, displayAddress: '', note: 'Full address shown on Eventbrite' };
    const cap = str(ev.capacity), n = /^\d+$/.test(cap) ? Number(cap) : 0;
    return {
      local: true,
      name: str(ev.title),
      summary: str(ev.publicSummary),
      descriptionHtml: textToHtml(ev.publicDescription),
      startLocal: timed ? at(ev.start) : date,
      endLocal: at(ev.end),
      timezone: opts.timezone || '',
      status: 'draft',
      location,
      tickets: n >= 1 ? [{ name: 'General Admission', free: true, quantityTotal: n }] : [],
      logoUrl: null,
    };
  }

  root.ListingPreview = { fromForm, textToHtml, AREA };
})(typeof globalThis !== 'undefined' ? globalThis : this);
