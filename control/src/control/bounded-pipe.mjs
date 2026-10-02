// Dedicated stream framing: reject the declared length before allocating the body.
export function readFrames(stream, { maxBytes, onFrame, onError }) {
  let header = Buffer.alloc(4),
    headerUsed = 0,
    body = null,
    used = 0,
    failed = false;
  const fail = (error) => {
    if (failed) return;
    failed = true;
    body = null;
    stream.destroy();
    onError(error);
  };
  stream.on("data", (chunk) => {
    if (failed) return;
    try {
      let offset = 0;
      while (offset < chunk.length && !failed) {
        if (!body) {
          const count = Math.min(4 - headerUsed, chunk.length - offset);
          chunk.copy(header, headerUsed, offset, offset + count);
          headerUsed += count;
          offset += count;
          if (headerUsed < 4) continue;
          const length = header.readUInt32BE(0);
          if (!length || length > maxBytes) throw Error("Controller frame byte bound exceeded");
          body = Buffer.allocUnsafe(length);
          used = 0;
        }
        const count = Math.min(body.length - used, chunk.length - offset);
        chunk.copy(body, used, offset, offset + count);
        used += count;
        offset += count;
        if (used === body.length) {
          const value = JSON.parse(body.toString("utf8"));
          body = null;
          headerUsed = 0;
          onFrame(value);
        }
      }
    } catch (error) {
      fail(error);
    }
  });
  stream.on("error", fail);
  stream.on("end", () =>
    fail(Error(body || headerUsed ? "Truncated controller frame" : "Controller pipe closed")),
  );
}
export function writeFrames(stream, { maxBytes, maxQueuedBytes = maxBytes, onError, beforeWrite }) {
  let bytes = 0,
    count = 0;
  return (frame, callback = () => {}) => {
    const body = Buffer.from(JSON.stringify(frame)),
      size = body.length + 4;
    if (!body.length || body.length > maxBytes || bytes + size > maxQueuedBytes || count >= 64)
      throw Error("Controller output byte bound exceeded");
    const packet = Buffer.allocUnsafe(size);
    packet.writeUInt32BE(body.length);
    body.copy(packet, 4);
    bytes += size;
    count++;
    let completed = false;
    const done = (error) => {
      if (completed) return;
      completed = true;
      bytes -= size;
      count--;
      if (error) onError(error);
      callback(error ?? null);
    };
    try {
      beforeWrite?.(frame);
      return stream.write(packet, done);
    } catch (error) {
      done(error);
      throw error;
    }
  };
}
