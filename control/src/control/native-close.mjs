// stop() must reach store.close() on a daemon shutdown. There the DaemonClient's close releases each subscription with a
// correlated request the stopping host no longer answers, so native.close() never settles and the supervisor SIGKILLs
// the child at 5 s (W1 rebuild scratch home). The host drops those subscriptions with the connection anyway.
export const NATIVE_CLOSE_MS = 2000;

// Resolves true once close settles (fulfilled or rejected), false at the deadline. The timer stays referenced so the
// process cannot drain its loop and exit before the caller's store.close().
export function closeWithin(close, ms = NATIVE_CLOSE_MS) {
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(resolve, ms, false); });
  return Promise.race([Promise.resolve().then(close).then(() => true, () => true), deadline]).finally(() => clearTimeout(timer));
}
