import { checkReportPublication, carryReportPublication } from "../report-publication.js";
import { consumeManagementDispatch } from "./management.js";
import { randomUUID } from "node:crypto";
import type {
  ControllerManagementCommandV11,
  ManagementPrincipalV11,
  ControllerChildCommandV11,
  ControllerHostReplyV11,
} from "@getpaseo/protocol/controller-management";
import type { JsonValue, JsonObject, ProvenanceBindingV11 } from "@getpaseo/protocol/trusted-input";
import {
  ControllerFrameError,
  controllerEnvelope,
  parseControllerRequest,
  parseControllerCommand,
  parseControllerReply,
} from "./controller-frames.js";

/** V4 owns child creation/handshake. Construct only for a verified ready owned channel. */
export class ControllerChannel {
  readonly epoch = randomUUID();
  private live = true;
  private readonly requests = new Set<string>();
  private readonly commands = new Set<string>();
  constructor(
    private readonly options: {
      child: object;
      issue(binding: ProvenanceBindingV11): string;
      revoke(): void;
      rpc(frame: JsonObject): Promise<JsonValue>;
      reports?(request: JsonObject): Promise<JsonValue>;
      send(frame: ControllerChildCommandV11): Promise<unknown>;
      closeTransport?(): void;
    },
  ) {}
  async receive(child: object, input: unknown): Promise<ControllerHostReplyV11> {
    let envelope = controllerEnvelope(input);
    try {
      this.check(child);
      const frame = parseControllerRequest(input);
      envelope = frame;
      if (frame.epoch !== this.epoch) throw new ControllerFrameError("expired");
      this.claim(this.requests, frame.id);
      let result: JsonValue;
      if (frame.type === "issue-provenance") result = this.options.issue(frame.binding);
      else if (frame.type === "report-inbox") result = await this.reportRequest(frame.frame);
      else result = await this.options.rpc(frame.frame);
      this.check(child);
      checkReportPublication(result);
      return carryReportPublication(
        result,
        parseControllerReply({ id: frame.id, epoch: this.epoch, ok: true, result }),
      );
    } catch (error) {
      const code = error instanceof ControllerFrameError ? error.code : "unavailable";
      if (!envelope) throw new ControllerFrameError(code);
      return { id: envelope.id, epoch: this.epoch, ok: false, code };
    }
  }
  /** Host transport calls this synchronously immediately before its captured pipe write. */
  checkPublication(frame: unknown): void {
    this.check(this.options.child);
    checkReportPublication(frame);
  }
  private reportRequest(frame: JsonObject): Promise<JsonValue> {
    if (!this.options.reports) throw new ControllerFrameError("unavailable");
    return this.options.reports(frame);
  }
  async management(
    command: ControllerManagementCommandV11,
    principal: ManagementPrincipalV11,
    id = randomUUID(),
  ): Promise<JsonValue> {
    this.check(this.options.child);
    const frame = parseControllerCommand({
      id,
      epoch: this.epoch,
      type: "management",
      command,
      principal,
    });
    this.claim(this.commands, id);
    consumeManagementDispatch(command, principal);
    // Once handed to the owned transport a write may have executed. Never turn
    // a lost/invalid reply or revoked epoch into a refusal that invites replay.
    let reply: ControllerHostReplyV11;
    try {
      const result = await this.options.send(frame);
      this.check(this.options.child);
      reply = parseControllerReply(result);
      if (reply.id !== id || reply.epoch !== this.epoch) throw Error("Invalid reply correlation");
    } catch (error) {
      if (error instanceof ControllerFrameError && error.code === "uncertain") throw error;
      throw new ControllerFrameError("uncertain");
    }
    if (!reply.ok) throw new ControllerFrameError(reply.code, reply.message);
    return reply.result;
  }
  private claim(ids: Set<string>, id: string): void {
    // Bounded replay history: a full epoch refuses new work until V4 replaces it.
    if (ids.has(id) || ids.size >= 65536) throw new ControllerFrameError("expired");
    ids.add(id);
  }
  private check(child: object): void {
    if (child !== this.options.child) throw new ControllerFrameError("unauthorised");
    if (!this.live) throw new ControllerFrameError("unavailable");
  }
  close(): void {
    if (!this.live) return;
    this.live = false;
    this.options.revoke();
    this.options.closeTransport?.();
  }
  crash(): void {
    this.close();
  }
}
