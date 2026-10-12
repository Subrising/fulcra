import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  HostLinkConfigSchema,
  HostLinkDispatchSchema,
  HostLinkJournalSchema,
  HostLinkReceiptSchema,
  HostLinkWireSchema,
  HostLinkWorkerRequestSchema,
  type HostLinkConfig,
  type HostLinkDispatch,
  type HostLinkJournal,
  type HostLinkNoticeKind,
  type HostLinkProfile,
  type HostLinkReceipt,
  type HostLinkWire,
  type HostLinkWorkerRequest,
  type IncomingHostLink,
  type OutgoingHostLink,
} from "./host-link-contracts.js";
import { matchesHostLinkCredential } from "./host-link-credential.js";
import { writePrivateFileAtomicSync } from "./private-files.js";
import { childModeClass } from "./agent/create-agent-mode.js";
import { noteAgentMessage } from "./agent-message-log.js";

export class HostLinkError extends Error {
  constructor(
    readonly code: "refused" | "conflict" | "uncertain" | "unavailable",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HostLinkError";
  }
}
export interface HostLinkChat {
  id: string;
  provider: string;
  modeId: string | null;
  model: string | null;
  archived: boolean;
  reportsTo: string | null;
  isLead: boolean;
}
export interface HostLinkCreate {
  agentId: string;
  cwd: string;
  profile: HostLinkProfile;
  title: string;
  prompt: string;
  parent: string;
  messageId: string;
  check: () => void;
}
export interface HostLinkDelivery {
  agentId: string;
  text: string;
  messageId: string;
  check: () => void;
}
export interface HostLinkRoleNotice extends HostLinkDelivery {
  currentTarget: () => string | null;
  checkTarget: (id: string) => void;
}
export interface HostLinkDependencies {
  home: string;
  serverId: string;
  protected: () => boolean;
  chat: (id: string) => Promise<HostLinkChat | null>;
  mainAssistant: () => string | null;
  create: (input: HostLinkCreate) => Promise<void>;
  notice: (input: HostLinkRoleNotice) => Promise<string>;
  prompt: (input: HostLinkDelivery) => Promise<void>;
  inspect: (id: string) => Promise<unknown>;
  workerCurrent: (id: string, profile: HostLinkProfile, parent: string) => void;
  now?: () => number;
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function privateJson(file: string): unknown | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    const wrongMode =
      process.platform !== "win32" &&
      ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.());
    if (!stat.isFile() || wrongMode || stat.size > 8 * 1024 * 1024)
      throw new HostLinkError("refused", "A private host-link file is required.");
    const contents = readFileSync(fd, "utf8");
    try {
      return JSON.parse(contents);
    } catch {
      throw new HostLinkError("unavailable", "Host-link private data requires repair.");
    }
  } finally {
    closeSync(fd);
  }
}
/** Fixed HTTPS endpoints; literal loopback HTTP is safe for isolated daemon tests. */
export function hostLinkUrl(raw: string, operation: "receive" | "worker"): string {
  const url = new URL(raw);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  )
    throw new HostLinkError("refused", "Host links require HTTPS or literal loopback HTTP.");
  url.pathname = `/api/host-links/${operation}`;
  return url.href;
}
export function assertHostLinkMode(
  chat: Pick<HostLinkChat, "provider" | "modeId">,
  profile: HostLinkProfile,
): void {
  const parentClass = childModeClass(chat.provider, chat.modeId);
  const childClass = childModeClass(profile.provider, profile.modeId);
  const sameRestriction = chat.provider === profile.provider && chat.modeId === profile.modeId;
  if (
    parentClass === "unknown" ||
    childClass === "unknown" ||
    (parentClass === "restricted" && !sameRestriction) ||
    !profile.parents.includes(`${chat.provider}:${chat.modeId}`)
  )
    throw new HostLinkError(
      "refused",
      "The worker profile does not preserve the lead's permission mode.",
    );
}

export class HostLinks {
  private readonly configFile: string;
  private readonly inboxFile: string;
  private readonly outboxFile: string;
  constructor(private readonly deps: HostLinkDependencies) {
    this.configFile = path.join(deps.home, "host-links.json");
    this.inboxFile = path.join(deps.home, "host-links-inbox.json");
    this.outboxFile = path.join(deps.home, "host-links-outbox.json");
  }
  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  private config(): HostLinkConfig | null {
    const raw = privateJson(this.configFile);
    if (raw === null) return null;
    const parsed = HostLinkConfigSchema.safeParse(raw);
    if (!parsed.success)
      throw new HostLinkError("unavailable", "Host-link configuration is invalid.");
    const cfg = parsed.data;
    for (const entries of [cfg.incoming, cfg.outgoing, cfg.chats]) {
      const ids = entries.map((entry) => ("id" in entry ? entry.id : entry.agentId));
      if (new Set(ids).size !== ids.length)
        throw new HostLinkError("unavailable", "Host-link identities must be unique.");
      const tokens = entries.map((entry) => entry.token);
      if (new Set(tokens).size !== tokens.length)
        throw new HostLinkError(
          "unavailable",
          "Each host-link identity requires a separate credential.",
        );
    }
    return cfg;
  }
  private requiredConfig(): HostLinkConfig {
    if (process.platform === "win32")
      throw new HostLinkError(
        "unavailable",
        "Durable host-link operations are unavailable on Windows.",
      );
    const cfg = this.config();
    if (!cfg) throw new HostLinkError("unavailable", "Host links are not configured.");
    if (!this.deps.protected())
      throw new HostLinkError("refused", "Host links require daemon authentication.");
    return cfg;
  }
  private live(grant: { revoked: boolean; expiresAt: number }): void {
    if (grant.revoked || grant.expiresAt <= this.now())
      throw new HostLinkError("refused", "The host-link grant is inactive.");
  }
  private journal(file: string): HostLinkJournal {
    const raw = privateJson(file);
    if (raw === null) return {};
    const result = HostLinkJournalSchema.safeParse(raw);
    if (!result.success)
      throw new HostLinkError("unavailable", "Host-link receipts require repair.");
    return result.data;
  }
  private save(file: string, key: string, entry: HostLinkJournal[string]): void {
    const journal = this.journal(file);
    if (!Object.hasOwn(journal, key) && Object.keys(journal).length >= 1000)
      throw new HostLinkError("refused", "Host-link receipt capacity is full.");
    journal[key] = entry;
    const data = JSON.stringify(journal);
    if (Buffer.byteLength(data) > 8 * 1024 * 1024)
      throw new HostLinkError("refused", "Host-link receipt storage is full.");
    writePrivateFileAtomicSync(file, data, { durable: true });
  }
  private incoming(token: string | null): IncomingHostLink {
    const link = this.requiredConfig().incoming.find((item) =>
      matchesHostLinkCredential(item.token, token),
    );
    if (!link) throw new HostLinkError("refused", "The link credential is invalid.");
    this.live(link);
    return link;
  }
  private recheck(link: IncomingHostLink): void {
    const current = this.incoming(link.token);
    if (digest(current) !== digest(link))
      throw new HostLinkError("refused", "The host-link grant changed.");
  }
  private receipt(messageId: string, agentId: string | null): HostLinkReceipt {
    return {
      serverId: this.deps.serverId,
      messageId,
      state: "pending",
      agentId,
      token: null,
      endpoint: null,
    };
  }
  private async sourceChat(id: string): Promise<HostLinkChat> {
    const chat = await this.deps.chat(id);
    if (!chat || chat.archived)
      throw new HostLinkError("refused", "The source chat is not active.");
    return { ...chat, modeId: chat.modeId ?? "unknown" };
  }
  private outgoing(cfg: HostLinkConfig, id: string | undefined): OutgoingHostLink {
    const link = cfg.outgoing.find((item) => item.id === id);
    if (!link) throw new HostLinkError("refused", "The workload or role has no host-link route.");
    this.live(link);
    hostLinkUrl(link.url, "receive");
    return link;
  }
  async dispatch(token: string | null, raw: unknown): Promise<HostLinkReceipt> {
    const input = HostLinkDispatchSchema.parse(raw);
    const cfg = this.requiredConfig();
    const grant = cfg.chats.find((item) => matchesHostLinkCredential(item.token, token));
    if (!grant) throw new HostLinkError("refused", "The chat credential is invalid.");
    this.live(grant);
    if (!grant.operations.includes(input.kind))
      throw new HostLinkError("refused", "The chat cannot use this operation.");
    const chat = await this.sourceChat(grant.agentId);
    const route = input.kind === "spawn" ? cfg.routes[input.workload] : cfg.routes.mainAssistant;
    const link = this.outgoing(cfg, route);
    if (!grant.links.includes(link.id))
      throw new HostLinkError("refused", "The chat cannot use this link.");
    if (input.kind === "spawn" && input.workload !== "standard" && link.machine !== "pc")
      throw new HostLinkError("refused", "GPU and heavy workloads require the configured PC link.");
    if (input.kind === "notice" && chat.reportsTo !== "role:main-assistant")
      throw new HostLinkError("refused", "The chat does not report to the main assistant.");
    const current = this.requiredConfig().chats.find((item) => item.agentId === chat.id);
    if (!current || digest(current) !== digest(grant))
      throw new HostLinkError("refused", "The source grant changed.");
    this.live(current);
    if (input.kind === "notice") noteAgentMessage(chat.id, "role:main-assistant");
    return this.forward(link, chat, input, "explicit");
  }
  async remoteNotice(id: string, text: string, kind: HostLinkNoticeKind): Promise<boolean> {
    const cfg = this.config();
    if (!cfg) return false;
    const chat = await this.sourceChat(id);
    if (chat.reportsTo !== "role:main-assistant" || this.deps.mainAssistant() !== null)
      return false;
    const link = this.outgoing(this.requiredConfig(), cfg.routes.mainAssistant);
    if (!link.reporters.includes(id))
      throw new HostLinkError("refused", "The chat cannot report through this link.");
    if (kind === "finished" && this.isLead(chat)) return true;
    await this.forward(link, chat, { kind: "notice", messageId: randomUUID(), text }, kind);
    return true;
  }
  private async forward(
    link: OutgoingHostLink,
    chat: HostLinkChat,
    input: HostLinkDispatch,
    noticeKind: HostLinkNoticeKind,
  ): Promise<HostLinkReceipt> {
    const origin = {
      destination: link.serverId,
      sender: chat.id,
      sourceProvider: chat.provider,
      sourceMode: chat.modeId,
    };
    const wire = HostLinkWireSchema.parse({
      ...input,
      ...origin,
      ...(input.kind === "notice" ? { noticeKind, isLead: this.isLead(chat) } : {}),
    });
    const key = `${chat.id}:${input.messageId}`;
    const entry: HostLinkJournal[string] = {
      hash: digest(wire),
      grant: digest(link),
      sender: chat.id,
      linkId: link.id,
      sourceServerId: this.deps.serverId,
      profile: null,
      cwd: null,
      receipt: this.receipt(input.messageId, null),
    };
    const retained = this.journal(this.outboxFile)[key];
    if (retained && (retained.hash !== entry.hash || retained.grant !== entry.grant))
      throw new HostLinkError("conflict", "The retained request or destination changed.");
    this.save(this.outboxFile, key, retained ?? entry);
    const current = this.outgoing(this.requiredConfig(), link.id);
    if (digest(current) !== entry.grant)
      throw new HostLinkError("refused", "The outbound link changed.");
    let response: Response;
    try {
      response = await fetch(hostLinkUrl(link.url, "receive"), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${link.token}`, "content-type": "application/json" },
        body: JSON.stringify(wire),
      });
    } catch (error) {
      throw new HostLinkError(
        "uncertain",
        `Host-link delivery is uncertain. Retain message ${input.messageId}.`,
        { cause: error },
      );
    }
    if (!response.ok)
      throw new HostLinkError("refused", "The destination refused the host-link request.");
    const receipt = HostLinkReceiptSchema.parse(await response.json());
    if (receipt.serverId !== link.serverId || receipt.messageId !== input.messageId)
      throw new HostLinkError("uncertain", "The destination receipt does not match the request.");
    receipt.endpoint = link.url;
    this.save(this.outboxFile, key, { ...entry, receipt });
    return receipt;
  }
  private isLead(chat: HostLinkChat): boolean {
    if (chat.isLead) return true;
    return Object.values(this.journal(this.outboxFile)).some(
      (entry) => entry.sender === chat.id && entry.receipt.state === "created",
    );
  }
  async receive(token: string | null, raw: unknown): Promise<HostLinkReceipt> {
    const link = this.incoming(token);
    const wire = HostLinkWireSchema.parse(raw);
    if (
      wire.destination !== this.deps.serverId ||
      !link.leads.includes(wire.sender) ||
      !link.operations.includes(wire.kind)
    )
      throw new HostLinkError(
        "refused",
        "The link cannot admit this destination, lead, or operation.",
      );
    const key = `${link.id}:${wire.sender}:${wire.messageId}`;
    const retained = this.journal(this.inboxFile)[key];
    if (retained) {
      if (retained.hash !== digest(wire) || retained.grant !== digest(link))
        throw new HostLinkError("conflict", "The retained request changed.");
      // A prior rename may have succeeded while its directory flush failed.
      this.save(this.inboxFile, key, retained);
      return retained.receipt;
    }
    const agentId = wire.kind === "spawn" ? randomUUID() : this.deps.mainAssistant();
    if (!agentId) throw new HostLinkError("refused", "The main assistant has no chat.");
    const entry: HostLinkJournal[string] = {
      hash: digest(wire),
      grant: digest(link),
      sender: wire.sender,
      linkId: link.id,
      sourceServerId: link.serverId,
      profile: null,
      cwd: null,
      receipt: this.receipt(wire.messageId, agentId),
    };
    if (wire.kind === "spawn") this.prepareSpawn(link, wire, entry);
    this.save(this.inboxFile, key, entry);
    return this.admit(link, wire, key, entry);
  }
  private prepareSpawn(
    link: IncomingHostLink,
    wire: Extract<HostLinkWire, { kind: "spawn" }>,
    entry: HostLinkJournal[string],
  ): void {
    const cfg = this.requiredConfig();
    if (
      !link.workloads.includes(wire.workload) ||
      (wire.workload !== "standard" && cfg.machine !== "pc")
    )
      throw new HostLinkError("refused", "The destination cannot run this workload.");
    if (
      !Object.hasOwn(link.workspaces, wire.workspace) ||
      !Object.hasOwn(link.profiles, wire.profile)
    )
      throw new HostLinkError("refused", "The workspace or profile is not granted.");
    const cwd = link.workspaces[wire.workspace]!;
    if (!path.isAbsolute(cwd) || realpathSync(cwd) !== cwd)
      throw new HostLinkError("refused", "The granted workspace path changed.");
    const profile = link.profiles[wire.profile]!;
    assertHostLinkMode({ provider: wire.sourceProvider, modeId: wire.sourceMode }, profile);
    const workers = Object.values(this.journal(this.inboxFile)).filter(
      (item) => item.linkId === link.id && item.profile !== null,
    );
    if (workers.length >= link.maxWorkers)
      throw new HostLinkError("refused", "The link worker limit is full.");
    entry.cwd = cwd;
    entry.profile = profile;
  }
  private async admit(
    link: IncomingHostLink,
    wire: HostLinkWire,
    key: string,
    entry: HostLinkJournal[string],
  ): Promise<HostLinkReceipt> {
    const agentId = entry.receipt.agentId!;
    const check = () => this.recheck(link);
    if (wire.kind === "spawn") {
      await this.deps.create({
        agentId,
        cwd: entry.cwd!,
        profile: entry.profile!,
        title: wire.title,
        prompt: wire.prompt,
        parent: `${wire.sender}@${link.serverId}`,
        messageId: wire.messageId,
        check,
      });
      entry.receipt.state = "created";
      entry.receipt.token = `hworker1.${randomBytes(32).toString("base64url")}`;
    } else if (wire.noticeKind === "finished" && wire.isLead) {
      entry.receipt.state = "suppressed";
    } else {
      const deliveryCheck = (currentTarget: string) => {
        check();
        if (this.deps.mainAssistant() !== currentTarget)
          throw new HostLinkError("refused", "The main assistant changed before delivery.");
      };
      try {
        entry.receipt.agentId = await this.deps.notice({
          agentId,
          text: `Host notice from ${wire.sender}@${link.serverId}:\n${wire.text}`,
          messageId: wire.messageId,
          check,
          currentTarget: this.deps.mainAssistant,
          checkTarget: deliveryCheck,
        });
        entry.receipt.state = "delivered";
      } catch (error) {
        entry.receipt.state = "refused";
        this.save(this.inboxFile, key, entry);
        throw error;
      }
    }
    check();
    this.save(this.inboxFile, key, entry);
    return entry.receipt;
  }
  async worker(token: string | null, raw: unknown): Promise<unknown> {
    const input = HostLinkWorkerRequestSchema.parse(raw);
    const entries = Object.values(this.journal(this.inboxFile));
    const entry = entries.find(
      (item) => item.receipt.token !== null && matchesHostLinkCredential(item.receipt.token, token),
    );
    if (!entry || entry.receipt.agentId !== input.agentId || !entry.profile)
      throw new HostLinkError("refused", "The worker credential is invalid.");
    const link = this.requiredConfig().incoming.find((item) => item.id === entry.linkId);
    if (!link || digest(link) !== entry.grant)
      throw new HostLinkError("refused", "The worker grant changed.");
    this.recheck(link);
    const chat = await this.sourceChat(input.agentId);
    if (
      chat.reportsTo !== `${entry.sender}@${entry.sourceServerId}` ||
      chat.provider !== entry.profile.provider ||
      chat.model !== entry.profile.model ||
      chat.modeId !== entry.profile.modeId
    )
      throw new HostLinkError("refused", "The worker identity or permission mode changed.");
    if (input.kind === "inspect") return this.deps.inspect(input.agentId);
    return this.workerPrompt(link, entry, input);
  }
  private async workerPrompt(
    link: IncomingHostLink,
    owner: HostLinkJournal[string],
    input: Extract<HostLinkWorkerRequest, { kind: "prompt" }>,
  ): Promise<HostLinkReceipt> {
    const key = `${link.id}:${input.agentId}:${input.messageId}`;
    const retained = this.journal(this.inboxFile)[key];
    if (retained) {
      if (retained.hash !== digest(input) || retained.grant !== owner.grant)
        throw new HostLinkError("conflict", "The retained prompt changed.");
      return retained.receipt;
    }
    const entry = {
      ...owner,
      hash: digest(input),
      profile: null,
      receipt: this.receipt(input.messageId, input.agentId),
    };
    this.save(this.inboxFile, key, entry);
    const check = () => {
      this.recheck(link);
      this.deps.workerCurrent(
        input.agentId,
        owner.profile!,
        `${owner.sender}@${owner.sourceServerId}`,
      );
    };
    await this.deps.prompt({
      agentId: input.agentId,
      text: input.prompt,
      messageId: input.messageId,
      check,
    });
    entry.receipt.state = "admitted";
    this.save(this.inboxFile, key, entry);
    return entry.receipt;
  }
}
