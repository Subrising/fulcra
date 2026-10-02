export function permissionChannel(daemon, timeout = 10000) {
  let ready = false,
    owned = null,
    unobserve = () => {},
    closed = false;
  const waiting = new Set();
  const accept = () => {
    if (!daemon.isConnected) return;
    ready = true;
    for (const w of waiting) w.resolve();
  };
  const begin = () => {
    if (closed || owned || !daemon.observeEvents) return;
    owned = daemon.observeEvents(["agent_permission_resolved"]);
    unobserve = owned.subscribe({
      snapshot: () => {
        if (daemon.getLastServerInfoMessage()?.features?.explicitEventSubscriptions === true)
          accept();
      },
      update() {},
      error: () => {
        ready = false;
        owned = null;
        unobserve();
        for (const w of waiting) w.reject(Error("Permission subscription failed"));
      },
    });
  };
  const state = daemon.subscribeConnectionStatus((s) => {
    if (s.status !== "connected") {
      ready = false;
      for (const w of waiting) w.reject(Error("Permission event connection changed"));
    } else begin();
  });
  const acknowledged = daemon.observeEvents
    ? () => {}
    : daemon.on("session.events.set_subscription.response", accept);
  // Register before connecting: every restored event subscription includes this interest.
  const interest = daemon.observeEvents
    ? () => {}
    : daemon.on("agent_permission_resolved", () => {});
  begin();
  return {
    ready: () => {
      if (closed) return Promise.reject(Error("Permission channel closed"));
      begin();
      return ready && daemon.isConnected
        ? Promise.resolve()
        : new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => finish(reject, Error("Permission event subscription not acknowledged")),
              timeout,
            );
            const finish = (callback, value) => {
              clearTimeout(timer);
              waiting.delete(waiter);
              callback(value);
            };
            const waiter = { resolve: () => finish(resolve), reject: (e) => finish(reject, e) };
            waiting.add(waiter);
          });
    },
    close: async () => {
      closed = true;
      ready = false;
      state();
      acknowledged();
      interest();
      unobserve();
      for (const w of waiting) w.reject(Error("Permission channel closed"));
      await owned?.release();
    },
  };
}
