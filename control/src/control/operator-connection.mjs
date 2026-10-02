// One operator/role RPC connection on the controller's unix socket: exactly one newline-terminated request (at most
// 32 KiB), one JSON reply, then close.
//
// The timeout guards only the REQUEST, and it is an INACTIVITY timer (socket.setTimeout), not a wall-clock deadline: a
// client that goes silent for requestTimeoutMs before finishing its line is dropped, but one trickling bytes can keep a
// partial request open longer (bounded by the 32 KiB buffer; no total-duration cap -- as before this change). Nothing is
// dispatched until the line is complete. Once the request is complete the timer is cleared, because the handler may
// legitimately take longer (a Book observe crosses SSH and the Book daemon; the event loop can stall on the disk), and
// destroying the connection then does not stop the handler: it completes, but its reply has nowhere to go. The client
// saw an empty reply ("Unexpected end of JSON input") while the RPC succeeded -- for a mutating RPC, an action that
// happened while the caller was told nothing (P1 discovery, 26 Sep: observe ok after 64 s, connection destroyed at 30 s).
// Handlers keep their own bounds (transport timeouts, fences); the client keeps its own deadline. This change does not
// bound handlers: a handler that never settles keeps its socket, and cancelling one needs its own semantics (review note).
export const REQUEST_TIMEOUT_MS = 30000,
  MAX_REQUEST_BYTES = 32768;

/**
 * @param {{ dispatch: (request: any, timing: { acceptedAt: number, receivedAt: number }) => Promise<any>,
 *           operations: Set<Promise<void>>, errorFields?: (e: any) => object, requestTimeoutMs?: number }} options
 * @returns {(connection: import('node:net').Socket) => void}
 */
export function operatorConnection({
  dispatch,
  operations,
  errorFields = () => ({}),
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
}) {
  return (connection) => {
    const acceptedAt = performance.now();
    let bytes = Buffer.alloc(0),
      received = false;
    connection.setTimeout(requestTimeoutMs, () => connection.destroy());
    connection.on("error", () => {});
    connection.on("data", (chunk) => {
      if (received) {
        connection.destroy();
        return;
      }
      bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
      if (bytes.length > MAX_REQUEST_BYTES) {
        connection.destroy();
        return;
      }
      const end = bytes.indexOf(10);
      if (end < 0) return;
      received = true;
      connection.setTimeout(0);
      const receivedAt = performance.now();
      const operation = (async () => {
        try {
          if (bytes.subarray(end + 1).length) throw new Error("One request per connection");
          const result = await dispatch(JSON.parse(bytes.subarray(0, end).toString("utf8")), {
            acceptedAt,
            receivedAt,
          });
          connection.end(JSON.stringify({ result }) + "\n");
        } catch (e) {
          connection.end(JSON.stringify({ error: e.message, ...errorFields(e) }) + "\n");
        }
      })();
      operations.add(operation);
      operation.finally(() => operations.delete(operation));
    });
  };
}
