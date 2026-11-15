/* coda-applied.js — honest-save poller.
   Coda writes are async (202 + requestId); a row is only changed once
   mutationStatus says completed (typically 13-30 s). waitApplied polls until then.
   Pure (no DOM, no fetch, no real timers): fetchStatus/sleep/now are injected, so it
   is node-tested (proxy/test/coda-applied.test.js). Attaches `CodaApplied` to globalThis.

   waitApplied(requestId, { fetchStatus, sleep, now, onSlow }) -> Promise<void>
     fetchStatus(requestId) -> Promise<{ status:number, completed?:boolean }>
     resolves on completed:true, on 404 (route missing during a deploy gap) and
     when requestId is falsy; rejects Error('save not confirmed') on 400 (with
     .status = 400) and once 120 s have elapsed (network errors are retried). */
(function (root) {
  const DEADLINE_MS = 120000;
  const SLOW_MS = 20000;

  async function waitApplied(requestId, { fetchStatus, sleep, now, onSlow } = {}) {
    if (!requestId) return;
    const start = now();
    let polls = 0, slowFired = false;
    for (;;) {
      let r = null;
      try { r = await fetchStatus(requestId); } catch (_) { /* network: retry until the deadline */ }
      if (r) {
        if (r.completed === true) return;
        if (r.status === 404) return;
        if (r.status === 400) {
          const e = new Error('save not confirmed');
          e.status = 400;
          throw e;
        }
      }
      const elapsed = now() - start;
      if (elapsed >= DEADLINE_MS) throw new Error('save not confirmed');
      if (elapsed >= SLOW_MS && !slowFired) {
        slowFired = true;
        if (onSlow) onSlow();
      }
      const delay = polls < 5 ? 1000 : elapsed < SLOW_MS ? 1500 : 2000;
      polls++;
      await sleep(delay);
    }
  }

  root.CodaApplied = { waitApplied };
})(typeof globalThis !== 'undefined' ? globalThis : this);
