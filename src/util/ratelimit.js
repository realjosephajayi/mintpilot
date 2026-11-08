'use strict';
/** Fixed-window in-memory limiter. Fine for a single process; use Redis if you scale out. */
function createLimiter({ limit, windowSec, now = () => Date.now() / 1000 }) {
  const hits = new Map();
  return {
    /** returns true if allowed */
    allow(key) {
      const t = now();
      const e = hits.get(key);
      if (!e || t - e.start >= windowSec) {
        hits.set(key, { start: t, n: 1 });
        return true;
      }
      e.n += 1;
      return e.n <= limit;
    },
    sweep() {
      const t = now();
      for (const [k, e] of hits) if (t - e.start >= windowSec) hits.delete(k);
    }
  };
}
module.exports = { createLimiter };
