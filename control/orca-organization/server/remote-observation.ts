type Call = (method: string, input?: unknown) => Promise<any>;
type Row = { id: string; task: string; host: string; generation: number; remote?: { host?: string; agentId: string; generation?: number } };
export const remoteIdentity = (row: Row) => JSON.stringify([row.id, row.task, row.host, row.generation, row.remote?.host, row.remote?.agentId, row.remote?.generation]);

// A display deadline does not cancel the controller/receiver call. Keep its slot
// until the original promise settles, including across later fleet refreshes.
export function createRemoteObserver(call: Call, budgetMs = 12000) {
  const flights = new Map<string, Promise<any>>();
  let lastStarted: string | undefined;
  return async (rows: Row[], budget = budgetMs) => {
    const deadline = Date.now() + Math.min(budget, budgetMs), values = new Map<string, any>(), requested = new Set<string>();
    const offset = rows.findIndex(row => remoteIdentity(row) === lastStarted) + 1;
    const ordered = [...rows.slice(offset), ...rows.slice(0, offset)];
    let open = true;
    try {
      while (Date.now() < deadline && values.size < rows.length) {
        for (const row of ordered) {
          const key = remoteIdentity(row);
          if (requested.has(key) || Date.now() >= deadline) continue;
          let flight = flights.get(key);
          if (!flight && flights.size < 4) {
            flight = Promise.resolve().then(() => call("observe", row.id)).catch(() => null).finally(() => flights.delete(key));
            flights.set(key, flight); lastStarted = key;
          }
          if (flight) {
            requested.add(key);
            void flight.then(value => { if (open) values.set(row.id, value); });
          }
        }
        if (values.size === rows.length || !flights.size) break;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([Promise.race(flights.values()), new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); })]); }
        finally { clearTimeout(timer); }
      }
    } finally { open = false; }
    return { values: new Map(values), pending: new Set(rows.filter(row => requested.has(remoteIdentity(row)) && !values.has(row.id)).map(row => row.id)) };
  };
}
const observers = new WeakMap<Call, ReturnType<typeof createRemoteObserver>>();
export function observeRemotes(call: Call, rows: Row[], budget?: number) {
  let observe = observers.get(call);
  if (!observe) { observe = createRemoteObserver(call); observers.set(call, observe); }
  return observe(rows, budget);
}
