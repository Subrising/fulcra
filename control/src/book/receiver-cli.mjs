import { privateProfile } from "./transport.mjs";
import { secret, verify } from "./protocol.mjs";
import { Receiver, receive } from "./receiver.mjs";
import { connectBookNative } from "./native.mjs";
// Fixed authenticated SSH command, one bounded request. It is NOT an arbitrary agent.run proxy.
let native, receiver;
try {
  const p = privateProfile(process.argv[2]),
    key = secret(p.keyFile);
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 65536) throw Error("Receiver input exceeds bound");
    chunks.push(chunk);
  }
  const wire = JSON.parse(Buffer.concat(chunks).toString("utf8")),
    body = verify(wire, key);
  if (body.host !== "macbook" || body.controller !== p.controller)
    throw Error("Wrong receiver authority");
  // Revocation must work while the native provider is unavailable.
  native = ["revoke", "permission-cancel"].includes(body.action)
    ? { close: async () => {} }
    : await connectBookNative(p);
  receiver = new Receiver({ file: p.journal, native, controller: p.controller });
  process.stdout.write(JSON.stringify(await receive(receiver, wire, key)) + "\n");
} catch (e) {
  process.stderr.write("Book receiver failed: " + e.message + "\n");
  process.exitCode = 1;
} finally {
  receiver?.close();
  await native?.close?.();
}
