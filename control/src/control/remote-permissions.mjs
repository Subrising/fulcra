import { automaticMode } from "./automatic-permission.mjs";
import { authorityKey } from "./authority.mjs";
import { canonical, digest } from "./permission-policy.mjs";
import { permissionProjection } from "./permission-projection.mjs";
const hash = (value) => digest(canonical(value));
export class RemotePermissions {
  constructor(native) {
    this.native = native;
  }
  wire(id, body, intentId) {
    const route = this.native.route(id);
    return {
      sessionId: id,
      intentId,
      generation: body.generation,
      binding: JSON.parse(route.binding),
      nativeId: body.nativeId,
      origin: body.origin,
      grantEpoch: body.grantEpoch,
      expectedLastUserAt: body.expectedLastUserAt,
      requestId: body.requestId,
      requestDigest: body.requestDigest,
    };
  }
  check(id, wire, result, proof) {
    const route = this.native.route(id),
      expected = {
        sessionId: id,
        intentId: wire.intentId,
        agentId: route.agent,
        generation: wire.generation,
        nativeId: wire.nativeId,
        boot: wire.binding.boot,
        origin: wire.origin,
        requestDigest: wire.requestDigest,
        proofDigest: hash(proof),
      };
    if (canonical(result?.identity) !== canonical(expected))
      throw Error("Remote permission receipt identity changed");
  }
  async root(id) {
    const route = this.native.route(id),
      s = this.native.store.get(id),
      out = await this.native.call("permission-root", { sessionId: id, generation: s.generation });
    if (
      out?.sessionId !== id ||
      out.agentId !== route.agent ||
      out.generation !== s.generation ||
      out.cwd !== s.cwd ||
      canonical(this.native.route(id)) !== canonical(route)
    )
      throw Error("Remote routine root changed");
  }
  async proof(id, request, body, intentId) {
    const wire = this.wire(id, body, intentId),
      result = await this.native.call("permission-proof", wire);
    if (result?.policyError)
      throw Object.assign(Error(result.policyError), { permissionPolicy: true });
    const p = result?.proof,
      s = this.native.store.get(id);
    if (p?.kind === "automatic-tool") {
      if (
        !automaticMode(request.provider, p.modeId) ||
        p.root !== s.cwd ||
        p.inputHash !== hash(request.input ?? {}) ||
        Object.keys(p).sort().join() !== "inputHash,kind,modeId,root"
      )
        throw Error("Invalid remote automatic proof");
      // The receiver evaluates paths and git branches on its own host and repeats
      // that policy at admission; the coordinator binds its authenticated proof.
      this.check(id, wire, result, p);
      return p;
    }
    if (
      !p ||
      p.root !== s.cwd ||
      p.file !== request.input?.file_path ||
      p.inputHash !== hash(request.input) ||
      !/^[a-f0-9]{64}$/.test(p.expectedHash) ||
      !Number.isSafeInteger(p.expectedBytes) ||
      p.expectedBytes < 0 ||
      p.expectedBytes > 262144 ||
      !Array.isArray(p.parents)
    )
      throw Error("Invalid remote file proof");
    this.check(id, wire, result, p);
    return p;
  }
  async respond(id, intentId) {
    const n = this.native,
      c = n.control,
      initial = c.permissions.binding(id);
    if (initial.supervision) await c.inspect(initial.supervision.supervisor);
    await c.inspect(id);
    if (authorityKey(await c.authority(initial.s.task)) !== initial.s.authority)
      throw Error("Orca native permission refused: task authority changed");
    const b = c.permissions.binding(id),
      row = n.db
        .prepare("SELECT * FROM permission_intents WHERE id=? AND session=?")
        .get(intentId, id),
      body = row && JSON.parse(row.body),
      r = n.route(id);
    if (
      !row ||
      row.state !== "intent" ||
      r.phase !== "active" ||
      r.generation !== b.s.generation ||
      body.generation !== b.s.generation ||
      body.grantEpoch !== b.g.epoch ||
      body.origin !== b.s.expected ||
      body.authority !== b.s.authority ||
      body.boot !== b.s.boot ||
      canonical(body.supervision) !== canonical(b.supervision)
    )
      throw Error("Orca native permission refused: remote grant changed");
    const wire = { ...this.wire(id, body, intentId), proofDigest: hash(body.proof) },
      reply = await n.call("permission-respond", wire);
    if (reply?.state === "cancelled")
      throw Error("Orca native permission refused: Book ticket cancelled");
    this.check(id, wire, reply, body.proof);
    if (
      reply.state !== "acknowledged" ||
      reply.receipt?.agentId !== r.agent ||
      reply.receipt.requestId !== "orca-permission:" + intentId ||
      canonical(reply.receipt.resolution) !== '{"behavior":"allow"}'
    )
      throw Error("Remote permission response uncertain; no replay");
    return { ...reply.receipt, agentId: id };
  }
  async result(id, intentId) {
    const row = this.native.db
        .prepare("SELECT * FROM permission_intents WHERE id=? AND session=?")
        .get(intentId, id),
      body = JSON.parse(row.body),
      wire = this.wire(id, body, intentId);
    const reply = await this.native.call("permission-result", { sessionId: id, intentId });
    this.check(id, wire, reply, body.proof);
    const tool = reply.tool,
      output = reply.output;
    if (
      !tool ||
      !["pending", "completed", "failed", "error"].includes(tool.state) ||
      (tool.state !== "pending" && tool.callId !== body.toolUseId)
    )
      throw Error("Remote tool result uncorrelated");
    if (
      tool.state === "completed" &&
      body.proof.kind === "automatic-tool" &&
      canonical(output) !== '{"toolCompleted":true}'
    )
      throw Error("Remote automatic completion differs from the admitted tool");
    if (
      tool.state === "completed" &&
      body.proof.kind !== "automatic-tool" &&
      (!output ||
        output.file !== body.proof.file ||
        output.sha256 !== body.proof.expectedHash ||
        output.bytes !== body.proof.expectedBytes ||
        output.links !== 1 ||
        !Number.isSafeInteger(output.ino) ||
        !Number.isSafeInteger(output.dev))
    )
      throw Error("Remote output verification differs from approved file");
    return { ...tool, output };
  }
  async cancel(id, intentId) {
    const result = await this.native.call("permission-cancel", { sessionId: id, intentId });
    if (
      result?.sessionId !== id ||
      result.intentId !== intentId ||
      !["cancelled", "consumed"].includes(result.state)
    )
      throw Error("Remote permission cancellation unconfirmed");
    return result;
  }
  waiting(id, request) {
    const digestNow = hash(permissionProjection(request));
    return this.native.db
      .prepare(
        "SELECT body FROM permission_intents WHERE session=? AND state IN ('intent','acknowledged','uncertain')",
      )
      .all(id)
      .some((r) => {
        const b = JSON.parse(r.body),
          s = this.native.store.get(id);
        return (
          b.generation === s.generation &&
          b.origin === s.expected &&
          b.requestId === request.id &&
          b.requestDigest === digestNow
        );
      });
  }
}
