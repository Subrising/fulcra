// One SDK-owned observation per connection lifetime; ordinary watchdog reads do
// not create additional subscriptions. The SDK restores this handle on reconnect.
export function agentWatch(client) {
  let active = null, starting = null, closed = false, unsubscribe = () => {};
  return {
    watch() {
      if (closed) return Promise.reject(Error('Agent observer closed'));
      if (active) return client.agents.list({ page: { limit: 100 } });
      return starting ??= client.agents.list({ page: { limit: 100 }, subscribe: {} }).then(result => {
        active = result.subscription;
        unsubscribe = active.subscribe({ snapshot() {}, update() {}, error() { active = null; unsubscribe(); } });
        return result;
      }).finally(() => { starting = null; });
    },
    async close() { closed = true; await starting?.catch(() => {}); unsubscribe(); await active?.release(); active = null; },
  };
}
