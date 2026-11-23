/* save-queue.js — the planning editor's per-event save queue.
   Pure (no DOM, no fetch): the app passes write(id, cells) → Promise, where cells
   are Coda cells [{column, value}]. Shared by the app (window.SaveQueue) and its
   node tests (proxy/test/save-queue.test.js).

   Each event gets its own queue:
   - one write in flight at a time; edits staged meanwhile go out together next,
     latest value per column — so a slow save never reorders a column's writes;
   - a failed write keeps its cells and sends them with the next one (newer values
     for the same column win). If nothing newer was staged it stops and reports
     'error' rather than retrying on its own;
   - events never share a slot;
   - a write that resolved but later turned out not to have saved (an overlaid
     write whose background confirm failed) goes back through fail(token): its
     cells return to the error state, minus columns written again since.
   Only the cells handed to stage() are written — the app stages changedCells()
   so a save never rewrites a column the user didn't touch.
   tracker() counts unsettled promises per event (the app's _confirming). */
(function (root) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // The cells in `after` whose value differs from the same column in `before`.
  function changedCells(before, after) {
    const prev = new Map((before || []).map(c => [c.column, c.value]));
    return (after || []).filter(c => !prev.has(c.column) || !same(prev.get(c.column), c.value));
  }

  // opts.write(id, cells, token) → Promise (token: for fail()); opts.onState(id, 'saving'|'saved'|'error', err);
  // opts.onError(e) receives anything onState throws (default console.error) — a
  // broken callback must never jam the queue.
  function create(opts) {
    const write = opts.write;
    const onState = opts.onState || function () {};
    const onError = opts.onError || (e => { if (typeof console !== 'undefined') console.error(e); });
    const recs = new Map();   // id → { pending: Map(column → value), inflight, newer, error, epoch, seq, sent: Map(column → seq), waiters, drains }
    function emit(id, st, err) { try { onState(id, st, err); } catch (e) { onError(e); } }

    function rec(id) {
      let r = recs.get(id);
      if (!r) { r = { pending: new Map(), inflight: false, newer: false, error: null, epoch: 0, seq: 0, sent: new Map(), waiters: [], drains: [] }; recs.set(id, r); }
      return r;
    }
    function release(r, err) { for (const w of r.waiters.splice(0)) err ? w.reject(err) : w.resolve(); }

    function pump(id) {
      const r = rec(id);
      if (r.inflight || !r.pending.size) return;
      const batch = r.pending, epoch = r.epoch, seq = ++r.seq;
      r.pending = new Map(); r.inflight = true; r.newer = false; r.error = null;
      for (const column of batch.keys()) r.sent.set(column, seq);   // the latest write of each column
      emit(id, 'saving');
      let p;
      try { p = Promise.resolve(write(id, [...batch].map(([column, value]) => ({ column, value })), { id, epoch, seq, batch })); }
      catch (e) { p = Promise.reject(e); }
      p.then(() => done(id, epoch, batch, null), err => done(id, epoch, batch, err || new Error('save failed')));
    }

    function done(id, epoch, batch, err) {
      const r = rec(id);
      r.inflight = false;
      if (epoch !== r.epoch) {                  // discarded while in flight: its outcome no longer matters
        for (const f of r.drains.splice(0)) f();
        if (r.pending.size) pump(id);           // edits staged since the discard
        else release(r, null);                  // settle() calls made since the discard
        return;
      }
      if (err) {
        for (const [column, value] of batch) if (!r.pending.has(column)) r.pending.set(column, value);   // newer values win
        if (r.newer) { pump(id); return; }      // the user kept editing: send it all again now
        r.error = err;
        release(r, err);                        // waiters hear the real error — before onState can discard
        emit(id, 'error', err);
        return;
      }
      if (r.pending.size) { pump(id); return; }
      emit(id, 'saved');
      release(r, null);
    }

    // Queue cells for the event and write them as soon as nothing is in flight.
    function stage(id, cells) {
      if (!cells || !cells.length) return;
      const r = rec(id);
      for (const c of cells) r.pending.set(c.column, c.value);
      if (r.inflight) r.newer = true;
      pump(id);
    }

    // Resolves once everything staged so far is written; rejects if a write fails.
    // After an error it sends the failed cells again.
    function settle(id) {
      const r = rec(id);
      if (!r.inflight && !r.pending.size) return Promise.resolve();
      const p = new Promise((resolve, reject) => r.waiters.push({ resolve, reject }));
      pump(id);
      return p;
    }

    // Drop the event's queued (and failed) edits; the outcome of a write in flight
    // is ignored, and anyone waiting on settle() is told the edits were dropped.
    // Resolves once no write is in flight.
    function discard(id) {
      const r = rec(id);
      r.pending.clear(); r.error = null; r.newer = false; r.epoch++;
      release(r, new Error('discarded'));
      if (!r.inflight) return Promise.resolve();
      return new Promise(resolve => r.drains.push(resolve));
    }

    // A write that resolved didn't save after all (token: the one write() was given).
    // Its cells go back as a failed write's do: columns written again since, or with a
    // newer value staged, are left out; with a write in flight they ride along with
    // it, otherwise the event reports 'error' (settle() re-sends them). Ignored once
    // the edits were discarded. Returns whether anything was put back.
    function fail(token, err) {
      const r = token && recs.get(token.id);
      if (!r || token.epoch !== r.epoch) return false;
      let back = 0;
      for (const [column, value] of token.batch)
        if (r.sent.get(column) === token.seq && !r.pending.has(column)) { r.pending.set(column, value); back++; }
      if (!back) return false;
      if (r.inflight) { r.newer = true; return true; }
      r.error = err || new Error('save failed');
      emit(token.id, 'error', r.error);
      return true;
    }

    function status(id) {
      const r = recs.get(id);
      return !r ? 'idle' : r.inflight ? 'saving' : r.error ? 'error' : 'idle';
    }

    return { stage, settle, discard, fail, status };
  }

  // Promises in flight per event: track(id, p) counts p until it settles and passes
  // its outcome through; has(id) / count(id) answer while any is unsettled. The app
  // keeps the background confirms of overlaid writes in one (_confirming, save.js).
  function tracker() {
    const n = new Map();   // id → unsettled count
    const done = id => { const k = (n.get(id) || 0) - 1; if (k > 0) n.set(id, k); else n.delete(id); };
    return {
      track(id, p) { n.set(id, (n.get(id) || 0) + 1); return Promise.resolve(p).finally(() => done(id)); },
      has: id => (n.get(id) || 0) > 0,
      count: id => n.get(id) || 0,
    };
  }

  root.SaveQueue = { create, changedCells, tracker };
})(typeof globalThis !== 'undefined' ? globalThis : this);
