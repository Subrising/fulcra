// Distribution-owned lifecycle. The caller supplies a verified immutable entry and
// the product's ControllerChannel; ordinary plugin code never receives this object.
export function createChildSupervisor({
  boot,
  spawn,
  createChannel,
  recover,
  // Clears files for a proved dead controller owner. Returns true after recovery.
  // Both the slow retry and explicit Retry use this after a refused exit recovery.
  recoverStale = () => false,
  onReady = () => {},
  schedule = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
  maxRestarts = 3,
  // Fulcra 0.2.13: after the quick restarts are used up, try again by itself: 30 s, 1, 2, 5 min, then every 5 min.
  // Before this a controller that failed three times (service handshake deadline exceeded, 10 Oct) stayed down
  // until the daemon restarted. A stable run or an explicit Retry starts the list again.
  slowRetryMs = [30000, 60000, 120000, 300000],
  now = () => Date.now(),
  stableMs = 60000,
  handshakeMs = 15000,
  startupMs = 180000,
  requestMs = 15000,
  // FU-766: a controller that stops answering (idle, not crashed) is stopped and replaced. healExpiries failed calls
  // within healWindowMs, with no answer between them, start one stop; at most healMaxRestarts stops per healRateMs.
  healExpiries = 5,
  healWindowMs = 60000,
  healMaxRestarts = 3,
  healRateMs = 600000,
  log = (reason) => console.error(`Controller lifecycle: ${reason}`),
}) {
  if (
    typeof boot !== "string" ||
    !boot ||
    typeof spawn !== "function" ||
    typeof createChannel !== "function" ||
    typeof recover !== "function"
  )
    throw Error("Verified distribution supervisor parameters required");
  if (!Number.isInteger(maxRestarts) || maxRestarts < 0 || maxRestarts > 5)
    throw Error("Invalid restart bound");
  let current = null,
    stopped = false,
    recoveryRefused = false,
    started = false,
    restarts = 0,
    slowRetries = 0,
    nextRetryAt = null,
    stopping = null,
    healStops = [],
    cancelRestart = () => {};
  const uncertain = () =>
    Object.assign(Error("Controller outcome uncertain; do not replay"), { code: "uncertain" });
  function revoke(owner) {
    if (owner.revoked) return;
    owner.revoked = true;
    owner.ready = false;
    owner.cancelHandshake();
    owner.cancelStable();
    owner.channel.close();
    for (const call of owner.pending.values()) {
      call.cancel();
      call.reject(uncertain());
    }
    owner.pending.clear();
  }
  function terminate(owner) {
    revoke(owner);
    if (owner.exited || owner.terminating) return;
    owner.terminating = true;
    owner.child.kill("SIGTERM");
    const cancel = schedule(() => {
      if (!owner.exited) owner.child.kill("SIGKILL");
    }, 5000);
    owner.child.once("exit", cancel);
  }
  // FU-766 self-heal. An "expired" refusal or a request timeout is a failed call; any answer from the controller resets.
  function noteAnswer(owner) {
    owner.failures.length = 0;
    rotateIfDue(owner);
  }
  // FU-766: the channel refuses all work once its id history is full. At 90% a planned restart starts a new epoch.
  function rotateIfDue(owner) {
    if (owner.rotating || current !== owner || owner.revoked || !owner.channel.rotationDue) return;
    owner.rotating = true;
    log(
      `INFO controller pid ${owner.child.pid} used ${owner.channel.commandCount + owner.channel.requestCount} ids (commands ${owner.channel.commandCount}, requests ${owner.channel.requestCount}); restarting for a new epoch before the id space is full`,
    );
    terminate(owner);
  }
  function noteFailure(owner, why) {
    if (current !== owner || owner.revoked || owner.terminating) return;
    const t = now();
    owner.failures.push(t);
    while (owner.failures.length && t - owner.failures[0] > healWindowMs) owner.failures.shift();
    if (owner.failures.length < healExpiries) return;
    healStops = healStops.filter((at) => t - at < healRateMs);
    if (healStops.length >= healMaxRestarts) {
      if (!owner.healRefusedLogged) {
        owner.healRefusedLogged = true;
        log(
          `ERROR controller pid ${owner.child.pid} not answering (${owner.failures.length} failed calls, last: ${why}); restart limit reached (${healMaxRestarts} per ${Math.round(healRateMs / 60000)} min), not restarting`,
        );
      }
      return;
    }
    healStops.push(t);
    const oldest = [...owner.pending.values()].reduce((a, c) => Math.min(a, c.at), t);
    log(
      `diagnostic controller pid ${owner.child.pid}: pending ${owner.pending.size}, oldest pending ${owner.pending.size ? t - oldest : 0} ms, up ${t - owner.startedAt} ms, ids used (commands ${owner.channel.commandCount ?? "?"}, requests ${owner.channel.requestCount ?? "?"}, full ${owner.channel.full === true})`,
    );
    log(
      `WARN controller pid ${owner.child.pid} not answering: ${owner.failures.length} failed calls within ${Math.round(healWindowMs / 1000)} s (last: ${why}); stopping it for a new controller (stop ${healStops.length} of ${healMaxRestarts})`,
    );
    owner.failures.length = 0;
    terminate(owner);
  }
  function launch() {
    if (stopped || current) return;
    nextRetryAt = null;
    const child = spawn();
    const owner = {
      child,
      ready: false,
      revoked: false,
      exited: false,
      terminating: false,
      pending: new Map(),
      failures: [],
      startedAt: now(),
      cancelHandshake: () => {},
      cancelStable: () => {},
    };
    try {
      owner.channel = createChannel(child, (frame) => {
        if (current !== owner || owner.revoked || !owner.ready)
          return Promise.reject(Error("Controller unavailable"));
        if (owner.pending.size >= 32 || owner.pending.has(frame.id))
          return Promise.reject(Error("Controller capacity reached"));
        return new Promise((resolve, reject) => {
          const cancel = schedule(() => {
            owner.pending.delete(frame.id);
            reject(uncertain());
            noteFailure(owner, "request timeout");
          }, requestMs);
          owner.pending.set(frame.id, { resolve, reject, cancel, at: now() });
          try {
            child.send(frame, (error) => {
              if (error) {
                terminate(owner);
              }
            });
          } catch {
            terminate(owner);
          }
        });
      });
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    }
    current = owner;
    child.on("message", async (frame) => {
      // A retained listener on an old child cannot write onto its replacement.
      const active = current;
      if (
        !active ||
        active.revoked ||
        child !== active.child ||
        !frame ||
        typeof frame !== "object"
      )
        return;
      const owner = active;
      if (frame.type === "service-ready") {
        if (
          Object.keys(frame).sort().join(",") !== "boot,contract,epoch,type" ||
          frame.boot !== boot ||
          frame.contract !== "1.1" ||
          frame.epoch !== owner.channel.epoch
        )
          return;
        if (owner.serviceReady) return;
        owner.serviceReady = true;
        owner.cancelHandshake();
        owner.cancelHandshake = schedule(() => {
          log("startup deadline exceeded");
          terminate(owner);
        }, startupMs);
        owner.channel.serviceReady?.();
        return;
      }
      if (frame.type === "ready") {
        if (
          Object.keys(frame).sort().join(",") !== "boot,contract,epoch,type" ||
          frame.boot !== boot ||
          frame.contract !== "1.1" ||
          frame.epoch !== owner.channel.epoch
        )
          return;
        if (owner.ready) return;
        try {
          onReady(child, owner.channel);
        } catch {
          terminate(owner);
          return;
        }
        owner.ready = true;
        owner.cancelHandshake();
        owner.cancelStable = schedule(() => {
          if (current === owner && owner.ready && !owner.revoked) {
            restarts = 0;
            slowRetries = 0;
          }
        }, stableMs);
        return;
      }
      if (!owner.ready && !owner.serviceReady) return;
      if (Object.hasOwn(frame, "ok")) {
        if (frame.epoch !== owner.channel.epoch) return;
        const call = owner.pending.get(frame.id);
        if (call) {
          owner.pending.delete(frame.id);
          call.cancel();
          if (frame.code !== "expired") noteAnswer(owner);
          call.resolve(frame);
        }
        return; // ControllerChannel validates the entire reply before exposing it.
      }
      try {
        const reply = await owner.channel.receive(child, frame);
        if (reply?.ok === false && reply.code === "expired") noteFailure(owner, "expired");
        else noteAnswer(owner);
        if (current === owner && !owner.revoked) child.send(reply);
      } catch {
        /* No trustworthy correlation means there is no reply destination. */
      }
    });
    child.once("disconnect", () => {
      log("owned transport closed");
      terminate(owner);
    });
    child.once("error", () => {
      terminate(owner);
    });
    child.once("exit", () => {
      owner.exited = true;
      revoke(owner);
      if (current !== owner) return;
      current = null;
      // Only an observed exit can authorise recovery. Unknown ownership fails shut.
      try {
        recover(child);
      } catch (error) {
        log(`recovery refused: ${String(error?.message ?? error).slice(0, 200)}`);
        stopped = true;
        recoveryRefused = true;
        scheduleStaleRecovery();
        return;
      }
      if (!stopped && restarts < maxRestarts) {
        const delay = 250 * 2 ** restarts++;
        cancelRestart = schedule(launch, delay);
      } else if (!stopped && slowRetryMs.length > 0) {
        const delay = slowRetryMs[Math.min(slowRetries, slowRetryMs.length - 1)];
        const attempt = ++slowRetries;
        nextRetryAt = now() + delay;
        log(
          `restart budget used; trying again in ${Math.round(delay / 1000)} s (retry ${attempt})`,
        );
        cancelRestart = schedule(() => {
          nextRetryAt = null;
          log(`retry ${attempt}: starting the controller`);
          launch();
        }, delay);
      }
    });
    owner.cancelHandshake = schedule(() => {
      log("service handshake deadline exceeded");
      terminate(owner);
    }, handshakeMs);
    try {
      child.send({ type: "boot", contract: "1.1", boot, epoch: owner.channel.epoch });
    } catch {
      terminate(owner);
    }
  }
  // FU-74: a refused recovery no longer waits for a person to press Retry. On the slow retry list it tries to clear the
  // stale controller files and starts the controller when that works. An explicit stop() ends these tries.
  function scheduleStaleRecovery() {
    if (slowRetryMs.length === 0) return;
    const delay = slowRetryMs[Math.min(slowRetries, slowRetryMs.length - 1)];
    const attempt = ++slowRetries;
    nextRetryAt = now() + delay;
    cancelRestart = schedule(() => {
      nextRetryAt = null;
      if (!recoveryRefused || stopping || current) return;
      if (!recoverStale()) {
        log(`retry ${attempt}: the controller files are still held; trying again later`);
        scheduleStaleRecovery();
        return;
      }
      stopped = false;
      recoveryRefused = false;
      log(`retry ${attempt}: stale controller files cleared; starting the controller`);
      launch();
    }, delay);
  }
  const isReady = () => Boolean(current?.ready && !current.revoked && !stopped);
  return {
    get ready() {
      return isReady();
    },
    get status() {
      return {
        state: isReady()
          ? "ready"
          : stopped
            ? "stopped"
            : current
              ? "starting"
              : started
                ? "failed"
                : "stopped",
        restarts,
        // Set while the supervisor waits to try again by itself.
        ...(nextRetryAt === null ? {} : { retryAttempt: slowRetries, nextRetryAt }),
      };
    },
    retry() {
      // A refused recovery stops the controller. A Retry may start it again only when the stale files are cleared now;
      // an explicit stop() is never undone here.
      if (stopped && recoveryRefused && !stopping && !current && recoverStale()) {
        stopped = false;
        recoveryRefused = false;
      }
      if (stopped) throw Error("Controller stopped; restart Command Centre in Settings");
      if (!current) {
        cancelRestart();
        restarts = 0;
        slowRetries = 0;
        nextRetryAt = null;
        started = true;
        launch();
      }
      return this.status;
    },
    start() {
      if (started || stopped) return;
      started = true;
      launch();
    },
    management(command, principal) {
      if (!isReady()) return Promise.reject(Error("Controller unavailable"));
      const owner = current;
      // A full id history makes the channel refuse every call as "expired" (FU-766): count it like a hang.
      return owner.channel.management(command, principal).then(
        (result) => {
          noteAnswer(owner);
          return result;
        },
        (error) => {
          if (error?.code === "expired") noteFailure(owner, "expired");
          throw error;
        },
      );
    },
    async stop() {
      if (stopping) return stopping;
      // An explicit stop also ends a waiting retry after a refused recovery.
      cancelRestart();
      nextRetryAt = null;
      if (stopped && !current) {
        recoveryRefused = false;
        return;
      }
      stopped = true;
      const owner = current;
      if (!owner) return;
      revoke(owner);
      // Resolve clean stop only after observed exit, never merely after kill().
      stopping = new Promise((resolve, reject) => {
        const cancelEscalation = schedule(() => {
          if (!owner.exited) owner.child.kill("SIGKILL");
        }, 5000);
        const cancelDeadline = schedule(() => reject(uncertain()), 10000);
        owner.child.once("exit", () => {
          cancelEscalation();
          cancelDeadline();
          resolve();
        });
        owner.child.kill("SIGTERM");
      });
      return stopping;
    },
  };
}
