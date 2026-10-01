import { CONTROLLER_SERVICE_MAX_BYTES } from '@getpaseo/protocol/controller-service';

/** Finite owned-host output backlog, including sends awaiting their IPC callback. */
export function createBoundedOutput({ send, fail }) {
  let count = 0, bytes = 0, closed = false;
  const close = () => { if (!closed) { closed = true; fail(); } };
  return frame => {
    if (closed) return;
    const size = Buffer.byteLength(JSON.stringify(frame));
    if (count >= 64 || bytes + size > CONTROLLER_SERVICE_MAX_BYTES) { close(); return; }
    count++; bytes += size;
    let completed = false;
    const done = error => {
      if (completed) return;
      completed = true; count--; bytes -= size;
      if (error) close();
    };
    try { send(frame, done); } catch (error) { done(error); }
  };
}
