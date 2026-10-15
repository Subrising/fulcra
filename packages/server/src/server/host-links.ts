import { PERMISSION_NOTICE_GRACE_MS } from "./permission-notice.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  HostLinkConfigSchema,
  HostLinkDispatchSchema,
  HostLinkSpawnSchema,
  HostLinkJournalSchema,
  HostLinkReceiptSchema,
  HostLinkWireSchema,
  HostLinkWorkerRequestSchema,
  HostLinkWorkerNoticesSchema,
  HostLinkWorkerNoticeSchema,
  type HostLinkWorkerNotice,
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
import { HostAccountLimits } from "./host-account-limits.js";
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
  sessionId?: string | null;
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
export interface HostLinkFinishDelivery extends HostLinkDelivery {
  beforeHandoff: () => void;
  prepare?: () => Promise<boolean>;
  sourceSessionId: string | null;
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
  finish?: (input: HostLinkFinishDelivery) => Promise<void | "suppressed">;
  permissionPending?: (workerId: string, requestId: string) => boolean;
  noticeError?: (error: unknown) => void;
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
  private notificationsRecovered = false;
  private notificationsClosed = false;
  private notificationTimer?: ReturnType<typeof setTimeout>;
  private notificationsStopped = true;
  private notificationSync?: Promise<void>;
  private readonly notificationDeliveries = new Map<string, Promise<void>>();

  private readonly accountLimits: HostAccountLimits;
  private readonly sharedLimits = new Map<string, string>();
  constructor(private readonly deps: HostLinkDependencies) {
    this.accountLimits = new HostAccountLimits(deps.home, privateJson, () => this.now());
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
  /** Native tools supply the bound caller identity. No credential enters tool results. */
  async spawnForAgent(id: string, serverId: string, raw: unknown): Promise<HostLinkReceipt> {
    const input = HostLinkSpawnSchema.parse(raw);
    const cfg = this.requiredConfig();
    const grant = cfg.chats.find((item) => item.agentId === id);
    if (!grant) throw new HostLinkError("refused", "This chat has no host-link spawn grant.");
    this.live(grant);
    if (!grant.operations.includes("spawn"))
      throw new HostLinkError("refused", "This chat cannot create remote workers.");
    const candidates = cfg.outgoing.filter((item) => item.serverId === serverId);
    if (candidates.length !== 1)
      throw new HostLinkError("refused", "The requested host has no unique host link.");
    const link = this.outgoing(cfg, candidates[0]!.id);
    if (!grant.links.includes(link.id))
      throw new HostLinkError("refused", "This chat cannot use the requested host link.");
    if (input.workload !== "standard" && link.machine !== "pc")
      throw new HostLinkError("refused", "GPU and heavy workloads require the configured PC link.");
    const chat = await this.sourceChat(id);
    const current = this.requiredConfig().chats.find((item) => item.agentId === id);
    if (!current || digest(current) !== digest(grant))
      throw new HostLinkError("refused", "The source grant changed.");
    this.live(current);
    const receipt = await this.forward(link, chat, input, "explicit");
    if (input.notifyOnFinish) this.resumeNotificationRetries(`${id}:${input.messageId}`);
    return receipt;
  }

  private resumeNotificationRetries(key: string): void {
    const entry = this.journal(this.outboxFile)[key]!;
    let changed = false;
    if (entry.watch?.failures === 8) {
      entry.watch = { failures: 0, nextAt: 0 };
      changed = true;
    }
    for (const notice of entry.receivedNotices ?? []) {
      if (notice.state !== "exhausted") continue;
      Object.assign(notice, { state: "queued", attempts: 0, nextAt: 0 });
      changed = true;
    }
    if (changed) this.save(this.outboxFile, key, entry);
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
    if (
      input.kind === "spawn" &&
      input.notifyOnFinish &&
      (this.notificationsClosed || !this.deps.finish)
    )
      throw new HostLinkError(
        "unavailable",
        "Remote finish delivery is unavailable on the home host.",
      );
    const entry: HostLinkJournal[string] = {
      hash: digest(wire),
      grant: digest(link),
      sender: chat.id,
      linkId: link.id,
      sourceServerId: this.deps.serverId,
      profile: null,
      cwd: null,
      receipt: this.receipt(input.messageId, null),
      ...(input.kind === "spawn" && input.notifyOnFinish
        ? {
            wire,
            notifyOnFinish: true,
            sourceSessionId: chat.sessionId ?? null,
            sourceGrant: digest(
              this.requiredConfig().chats.find((grant) => grant.agentId === chat.id),
            ),
            watch: { failures: 0, nextAt: 0 },
            receivedNotices: [],
          }
        : {}),
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
    return this.retainForwardReceipt(key, receipt);
  }

  private retainForwardReceipt(key: string, receipt: HostLinkReceipt): HostLinkReceipt {
    const latest = this.journal(this.outboxFile)[key];
    if (!latest) throw new HostLinkError("refused", "The retained forwarding receipt is missing.");
    const finalReceipt =
      latest.receipt.state === "created" && receipt.state === "pending" ? latest.receipt : receipt;
    this.save(this.outboxFile, key, { ...latest, receipt: finalReceipt });
    if (latest.notifyOnFinish) this.scheduleNotifications(0);
    return finalReceipt;
  }
  /** Failed links retry on the next pass. Remote observations are never forwarded. */
  async shareAccountLimits(): Promise<{ delivered: number; failed: number }> {
    const cfg = this.config();
    const result = { delivered: 0, failed: 0 };
    if (!cfg || !cfg.outgoing.some((link) => link.shareLimits)) return result;
    this.requiredConfig();
    const observations = this.accountLimits.local();
    const currentKeys = new Set<string>();
    await Promise.all(
      cfg.outgoing.map(async (link) => {
        if (!link.shareLimits || link.revoked || link.expiresAt <= this.now()) return;
        const signal = AbortSignal.timeout(15000);
        for (const observation of observations) {
          const key = digest({ link, observation });
          currentKeys.add(key);
          if (this.sharedLimits.get(key) === "delivered") continue;
          const messageId = this.sharedLimits.get(key) ?? randomUUID();
          this.sharedLimits.set(key, messageId);
          try {
            const current = this.outgoing(this.requiredConfig(), link.id);
            if (digest(current) !== digest(link))
              throw new HostLinkError("refused", "The outbound link changed.");
            const response = await fetch(hostLinkUrl(link.url, "receive"), {
              method: "POST",
              redirect: "error",
              signal,
              headers: {
                authorization: `Bearer ${link.token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                kind: "account_limit",
                messageId,
                destination: link.serverId,
                ...observation,
              }),
            });
            if (!response.ok) throw new HostLinkError("unavailable", "Limit sharing failed.");
            const receipt = HostLinkReceiptSchema.parse(await response.json());
            if (receipt.serverId !== link.serverId || receipt.messageId !== messageId)
              throw new HostLinkError("uncertain", "The limit receipt does not match the request.");
            if (receipt.state !== "delivered" && receipt.state !== "suppressed")
              throw new HostLinkError("uncertain", "The limit observation was not acknowledged.");
            if (receipt.state === "delivered") this.sharedLimits.set(key, "delivered");
            result.delivered++;
          } catch {
            // Network and parser errors can contain private transport details.
            result.failed++;
          }
        }
      }),
    );
    for (const key of this.sharedLimits.keys())
      if (!currentKeys.has(key)) this.sharedLimits.delete(key);
    return result;
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
    if (wire.kind === "account_limit") {
      if (wire.destination !== this.deps.serverId || !link.operations.includes("limits"))
        throw new HostLinkError("refused", "The link cannot share account limits.");
      this.recheck(link);
      const { accountId, limitKind, resetAt, observedAt } = wire;
      const accepted = this.accountLimits.receive(link.serverId, {
        accountId,
        limitKind,
        resetAt,
        observedAt,
      });
      return {
        ...this.receipt(wire.messageId, null),
        state: accepted ? "delivered" : "suppressed",
      };
    }
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
    if (wire.kind === "spawn") {
      if (wire.notifyOnFinish && this.notificationsClosed)
        throw new HostLinkError("unavailable", "Remote worker notice recovery is unavailable.");
      this.prepareSpawn(link, wire, entry);
      if (wire.notifyOnFinish)
        Object.assign(entry, {
          notifyOnFinish: true,
          notices: [],
          started: false,
          complete: false,
        });
    }
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
    if (
      wire.expected &&
      (wire.expected.provider !== profile.provider ||
        (wire.expected.model !== undefined && wire.expected.model !== profile.model) ||
        (wire.expected.modeId !== undefined && wire.expected.modeId !== profile.modeId))
    )
      throw new HostLinkError(
        "refused",
        "The requested provider, model, or mode differs from the host-link profile.",
      );
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
    wire: Exclude<HostLinkWire, { kind: "account_limit" }>,
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
      // Stream events can commit while creation awaits the initial provider handoff.
      entry = this.journal(this.inboxFile)[key] ?? entry;
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
    const chat =
      input.kind === "notices"
        ? await this.deps.chat(input.agentId)
        : await this.sourceChat(input.agentId);
    if (!chat) throw new HostLinkError("refused", "The worker is unavailable.");
    if (
      chat.reportsTo !== `${entry.sender}@${entry.sourceServerId}` ||
      chat.provider !== entry.profile.provider ||
      chat.model !== entry.profile.model ||
      chat.modeId !== entry.profile.modeId
    )
      throw new HostLinkError("refused", "The worker identity or permission mode changed.");
    if (input.kind === "notices")
      return HostLinkWorkerNoticesSchema.parse({
        serverId: this.deps.serverId,
        agentId: input.agentId,
        complete: entry.complete ?? false,
        notices: this.availableWorkerNotices(entry, input.agentId),
      });
    if (input.kind === "inspect") return this.deps.inspect(input.agentId);
    return this.workerPrompt(link, entry, input);
  }
  private availableWorkerNotices(
    entry: HostLinkJournal[string],
    agentId: string,
  ): HostLinkWorkerNotice[] {
    return (entry.notices ?? [])
      .filter((notice) => {
        if (notice.kind !== "permission") return true;
        if (entry.complete || notice.resolved || (notice.notBefore ?? 0) > this.now()) return false;
        return this.deps.permissionPending?.(agentId, notice.permissionRequestId ?? "") ?? true;
      })
      .map(({ id, kind, text }) => ({ id, kind, text }));
  }

  resolveWorkerPermission(agentId: string, requestId: string): void {
    for (const [key, entry] of Object.entries(this.journal(this.inboxFile))) {
      if (entry.receipt.agentId !== agentId || !entry.profile || !entry.notifyOnFinish) continue;
      const pending = (entry.notices ?? []).filter(
        (notice) =>
          notice.kind === "permission" &&
          notice.permissionRequestId === requestId &&
          !notice.resolved,
      );
      if (!pending.length) continue;
      for (const notice of pending) notice.resolved = true;
      this.save(this.inboxFile, key, entry);
    }
  }

  pendingNoticeWorkers(): Array<{ agentId: string; started: boolean }> {
    return Object.values(this.journal(this.inboxFile))
      .filter((entry) => entry.profile && entry.notifyOnFinish && !entry.complete)
      .map((entry) => ({ agentId: entry.receipt.agentId!, started: entry.started === true }));
  }

  recordWorkerStarted(agentId: string): void {
    for (const [key, entry] of Object.entries(this.journal(this.inboxFile))) {
      if (
        entry.receipt.agentId !== agentId ||
        !entry.profile ||
        !entry.notifyOnFinish ||
        entry.started
      )
        continue;
      this.save(this.inboxFile, key, { ...entry, started: true });
    }
  }

  recordWorkerNotice(
    agentId: string,
    kind: HostLinkWorkerNotice["kind"],
    eventId: string,
    text: string,
  ): void {
    for (const [key, entry] of Object.entries(this.journal(this.inboxFile))) {
      if (
        entry.receipt.agentId !== agentId ||
        !entry.profile ||
        !entry.notifyOnFinish ||
        entry.complete
      )
        continue;
      const notice = HostLinkWorkerNoticeSchema.parse({
        id: digest([agentId, kind, eventId]),
        kind,
        text: text.slice(0, 4000),
      });
      const notices = entry.notices ?? [];
      if (notices.some((item) => item.id === notice.id)) continue;
      if (notices.length >= (kind === "permission" ? 127 : 128))
        throw new HostLinkError("unavailable", "The worker notice journal is full.");
      this.save(this.inboxFile, key, {
        ...entry,
        notices: [
          ...notices,
          kind === "permission"
            ? {
                ...notice,
                permissionRequestId: eventId,
                notBefore: this.now() + PERMISSION_NOTICE_GRACE_MS,
              }
            : notice,
        ],
        started: true,
        complete: kind !== "permission",
      });
    }
  }

  startNotifications(): void {
    if (process.platform === "win32" || this.notificationsClosed || !this.notificationsStopped)
      return;
    this.notificationsStopped = false;
    this.scheduleNotifications(0);
  }

  stopNotifications(): void {
    this.notificationsStopped = true;
    this.notificationsClosed = true;
    if (this.notificationTimer) clearTimeout(this.notificationTimer);
  }

  private scheduleNotifications(delay: number): void {
    if (this.notificationsStopped) return;
    if (this.notificationTimer) clearTimeout(this.notificationTimer);
    this.notificationTimer = setTimeout(() => {
      this.notificationTimer = undefined;
      void this.syncNotifications()
        .catch((error) => this.deps.noticeError?.(error))
        .finally(() => this.scheduleNextNotifications());
    }, delay);
    this.notificationTimer.unref?.();
  }

  private scheduleNextNotifications(): void {
    if (this.notificationsStopped) return;
    try {
      const due: number[] = [];
      for (const [key, entry] of Object.entries(this.journal(this.outboxFile))) {
        if (!entry.notifyOnFinish) continue;
        if (!entry.complete && (entry.watch?.failures ?? 0) < 8) due.push(entry.watch?.nextAt ?? 0);
        for (const notice of entry.receivedNotices ?? []) {
          if (notice.state === "queued" && !this.notificationDeliveries.has(`${key}:${notice.id}`))
            due.push(notice.nextAt);
        }
      }
      if (!due.length) {
        if (this.notificationTimer) clearTimeout(this.notificationTimer);
        this.notificationTimer = undefined;
        return;
      }
      this.scheduleNotifications(Math.max(100, Math.min(...due) - this.now()));
    } catch (error) {
      this.deps.noticeError?.(error);
    }
  }

  syncNotifications(): Promise<void> {
    if (this.notificationSync) return this.notificationSync;
    const run = this.syncNotificationEntries();
    this.notificationSync = run;
    void run
      .finally(() => {
        if (this.notificationSync === run) this.notificationSync = undefined;
      })
      .catch(() => {});
    return run;
  }

  private async syncNotificationEntries(): Promise<void> {
    if (this.notificationsClosed) return;
    const entries = Object.entries(this.journal(this.outboxFile)).filter(
      ([, entry]) => entry.notifyOnFinish,
    );
    if (!this.notificationsRecovered) {
      for (const [key, entry] of entries) {
        let changed = false;
        for (const notice of entry.receivedNotices ?? []) {
          if (notice.state === "sending") {
            notice.state = "uncertain";
            changed = true;
          }
        }
        if (changed) this.save(this.outboxFile, key, entry);
      }
      this.notificationsRecovered = true;
    }
    for (const [key, entry] of entries) this.kickNoticeDeliveries(key, entry);
    const due = entries
      .filter(
        ([, entry]) =>
          !entry.complete &&
          (entry.watch?.failures ?? 0) < 8 &&
          (entry.watch?.nextAt ?? 0) <= this.now(),
      )
      .slice(0, 4);
    await Promise.all(due.map(([key, entry]) => this.readWorkerNotices(key, entry)));
  }

  private async notificationSource(
    entry: HostLinkJournal[string],
  ): Promise<{ chat: HostLinkChat; link: OutgoingHostLink }> {
    if (this.notificationsClosed)
      throw new HostLinkError("refused", "Host-link notices are stopped.");
    const cfg = this.requiredConfig();
    const link = this.outgoing(cfg, entry.linkId);
    if (digest(link) !== entry.grant)
      throw new HostLinkError("refused", "The notification link grant changed.");
    const grant = cfg.chats.find((item) => item.agentId === entry.sender);
    if (!grant || !grant.links.includes(link.id) || !grant.operations.includes("spawn"))
      throw new HostLinkError("refused", "The calling lead no longer has the spawn grant.");
    this.live(grant);
    if (digest(grant) !== entry.sourceGrant)
      throw new HostLinkError("refused", "The calling lead's original grant changed.");
    const chat = await this.sourceChat(entry.sender);
    if ((chat.sessionId ?? null) !== (entry.sourceSessionId ?? null))
      throw new HostLinkError("refused", "The calling lead's session changed.");
    if (this.notificationsClosed)
      throw new HostLinkError("refused", "Host-link notices are stopped.");
    return { chat, link };
  }

  private async readWorkerNotices(key: string, captured: HostLinkJournal[string]): Promise<void> {
    try {
      const { chat, link } = await this.notificationSource(captured);
      if (captured.receipt.state === "pending" && captured.wire?.kind === "spawn") {
        await this.forward(link, chat, captured.wire, "explicit");
      }
      let entry = this.journal(this.outboxFile)[key]!;
      if (!entry.receipt.token || !entry.receipt.agentId || entry.receipt.state !== "created")
        throw new HostLinkError("uncertain", "Remote creation needs receipt reconciliation.");
      // Persist the next attempt before network I/O, including attempts interrupted by restart.
      const failures = (entry.watch?.failures ?? 0) + 1;
      this.save(this.outboxFile, key, {
        ...entry,
        watch: { failures, nextAt: this.now() + Math.min(60000, 1000 * 2 ** failures) },
      });
      const result = await this.fetchWorkerNotices(link, entry);
      await this.notificationSource(captured);
      entry = this.journal(this.outboxFile)[key]!;
      const received = this.mergeWorkerNotices(entry, result.notices);
      const next = {
        ...entry,
        receivedNotices: received,
        complete: result.complete,
        watch: { failures: 0, nextAt: this.now() + 10000 },
      };
      this.save(this.outboxFile, key, next);
      this.kickNoticeDeliveries(key, next);
    } catch (error) {
      if (this.notificationsClosed) return;
      // Admission failures also have a durable retry limit; a restart never resets it.
      const entry = this.journal(this.outboxFile)[key];
      if (entry && entry.watch?.nextAt === captured.watch?.nextAt) {
        const failures = Math.min(8, (entry.watch?.failures ?? 0) + 1);
        this.save(this.outboxFile, key, {
          ...entry,
          watch: { failures, nextAt: this.now() + Math.min(60000, 1000 * 2 ** failures) },
        });
      }
      this.deps.noticeError?.(error);
    }
  }

  private async fetchWorkerNotices(link: OutgoingHostLink, entry: HostLinkJournal[string]) {
    const response = await fetch(hostLinkUrl(link.url, "worker"), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        authorization: `Bearer ${entry.receipt.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ kind: "notices", agentId: entry.receipt.agentId }),
    });
    if (!response.ok)
      throw new HostLinkError("unavailable", "The remote worker notice request failed.");
    const result = HostLinkWorkerNoticesSchema.parse(await response.json());
    if (result.serverId !== link.serverId || result.agentId !== entry.receipt.agentId)
      throw new HostLinkError("refused", "The worker notice identity changed.");
    return result;
  }

  private async permissionNoticeCurrent(key: string, id: string): Promise<boolean> {
    const captured = this.journal(this.outboxFile)[key]!;
    const { link } = await this.notificationSource(captured);
    const result = await this.fetchWorkerNotices(link, captured);
    await this.notificationSource(captured);
    const current = this.journal(this.outboxFile)[key]!;
    const next = {
      ...current,
      receivedNotices: this.mergeWorkerNotices(current, result.notices),
      complete: result.complete,
    };
    this.save(this.outboxFile, key, next);
    this.kickNoticeDeliveries(key, next);
    return next.receivedNotices.find((notice) => notice.id === id)?.state === "queued";
  }

  private mergeWorkerNotices(entry: HostLinkJournal[string], notices: HostLinkWorkerNotice[]) {
    const received = entry.receivedNotices ?? [];
    for (const prior of received) {
      if (
        prior.kind === "permission" &&
        prior.state === "queued" &&
        !notices.some((notice) => notice.id === prior.id)
      )
        prior.state = "suppressed";
    }
    for (const notice of notices) {
      const prior = received.find((item) => item.id === notice.id);
      if (prior && digest({ id: prior.id, kind: prior.kind, text: prior.text }) !== digest(notice))
        throw new HostLinkError("conflict", "A retained worker notice changed.");
      if (!prior) received.push({ ...notice, state: "queued", attempts: 0, nextAt: 0 });
    }
    return received;
  }

  private kickNoticeDeliveries(key: string, entry: HostLinkJournal[string]): void {
    for (const notice of entry.receivedNotices ?? []) {
      const deliveryKey = `${key}:${notice.id}`;
      if (
        notice.state !== "queued" ||
        notice.nextAt > this.now() ||
        this.notificationDeliveries.has(deliveryKey)
      )
        continue;
      const run = this.deliverWorkerNotice(key, notice.id);
      this.notificationDeliveries.set(deliveryKey, run);
      void run
        .finally(() => {
          this.notificationDeliveries.delete(deliveryKey);
          this.scheduleNextNotifications();
        })
        .catch((error) => this.deps.noticeError?.(error));
    }
  }

  async flushNotificationDeliveries(): Promise<void> {
    await Promise.all(this.notificationDeliveries.values());
  }

  private updateNotice(
    key: string,
    id: string,
    update: (notice: NonNullable<HostLinkJournal[string]["receivedNotices"]>[number]) => void,
  ): void {
    const entry = this.journal(this.outboxFile)[key]!;
    const notice = entry.receivedNotices?.find((item) => item.id === id);
    if (!notice) throw new HostLinkError("refused", "The retained notice is missing.");
    update(notice);
    this.save(this.outboxFile, key, entry);
  }

  private async deliverWorkerNotice(key: string, id: string): Promise<void> {
    let handedOff = false;
    try {
      const entry = this.journal(this.outboxFile)[key]!;
      await this.notificationSource(entry);
      const notice = entry.receivedNotices!.find((item) => item.id === id)!;
      if (!this.deps.finish)
        throw new HostLinkError("unavailable", "Local finish delivery is unavailable.");
      const result = await this.deps.finish({
        ...(notice.kind === "permission"
          ? { prepare: () => this.permissionNoticeCurrent(key, id) }
          : {}),
        agentId: entry.sender,
        sourceSessionId: entry.sourceSessionId ?? null,
        text: `Remote agent ${entry.receipt.agentId}@${entry.receipt.serverId} ${notice.kind}:\n${notice.text}`,
        messageId: `${entry.receipt.messageId}:${notice.id}`,
        check: () => {
          if (this.notificationsClosed) throw new Error("Host-link notices are stopped");
          const current = this.requiredConfig();
          const link = this.outgoing(current, entry.linkId);
          const grant = current.chats.find((item) => item.agentId === entry.sender);
          if (
            digest(link) !== entry.grant ||
            !grant ||
            digest(grant) !== entry.sourceGrant ||
            !grant.links.includes(link.id) ||
            !grant.operations.includes("spawn")
          )
            throw new HostLinkError("refused", "The return notice grant changed.");
          this.live(grant);
        },
        beforeHandoff: () => {
          this.updateNotice(key, id, (current) => {
            if (current.state !== "queued") throw new Error("Notice already attempted");
            current.state = "sending";
          });
          handedOff = true;
        },
      });
      if (result === "suppressed") {
        this.updateNotice(key, id, (current) => {
          current.state = "suppressed";
        });
        return;
      }
      if (!handedOff) throw new Error("Remote notice has no provider handoff receipt");
      this.updateNotice(key, id, (current) => {
        current.state = "delivered";
      });
    } catch (error) {
      if (this.notificationsClosed) return;
      this.updateNotice(key, id, (notice) => {
        if (notice.state === "suppressed") return;
        notice.attempts = Math.min(8, notice.attempts + 1);
        notice.state = notice.attempts >= 8 ? "exhausted" : "queued";
        if (handedOff) notice.state = "uncertain";
        notice.nextAt = this.now() + Math.min(60000, 1000 * 2 ** notice.attempts);
      });
      this.deps.noticeError?.(error);
    }
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
    const entry: HostLinkJournal[string] = {
      hash: digest(input),
      grant: owner.grant,
      sender: owner.sender,
      linkId: owner.linkId,
      sourceServerId: owner.sourceServerId,
      profile: null,
      cwd: owner.cwd,
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
