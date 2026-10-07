import {
  PromoteReportPrimeSchema,
  DemoteReportPrimeSchema,
  TransferReportProjectSchema,
} from "@getpaseo/protocol/native-report-hierarchy";
import {
  NativeArtifactContentGrantSchema,
  SetNativeArtifactContentGrantSchema,
  NativeArtifactContentSelectionSchema,
  type NativeArtifactContentReadInput,
} from "@getpaseo/protocol/native-artifact-content";
import { SetNativeArtifactToolSchema } from "@getpaseo/protocol/native-evidence";
import { createNativeReportCreation } from "./report-origin.js";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { z } from "zod";
import { canonicalJson } from "@getpaseo/protocol/trusted-input";
import {
  AdoptReportParentSchema,
  NativeReportIdentitySchema,
  NativeReportScopeSchema,
  RegisterReportPrimeSchema,
  RevokeReportRegistrationSchema,
  type NativeReportIdentity,
  type NativeReportScope,
} from "@getpaseo/protocol/native-intercom";
import path from "node:path";
import { createNativeReportBatch, type ReportMember } from "./report-batch.js";
import { createReportReader } from "./report-reader.js";
import { writeJsonFileDurable } from "./atomic-file.js";
import type { OwnerManagementHandler } from "./plugins/management.js";

type OwnerGuard = Parameters<OwnerManagementHandler>[1];
interface MutationAuthority {
  creator: string;
  requireAuthority: () => void;
}
const registration = z
  .object({
    identity: NativeReportIdentitySchema,
    scopes: z.array(NativeReportScopeSchema).min(1).max(16),
    epoch: z.string().uuid(),
    creator: z.string().min(1).max(128),
    retirement: z
      .object({ id: z.string().uuid(), at: z.number().int().nonnegative() })
      .strict()
      .optional(),
    // Legacy registrations have no credential until explicit owner replacement/adoption.
    reportCredential: z
      .string()
      .regex(/^report1\.[A-Za-z0-9_-]{43}$/)
      .optional(),
  })
  .strict();
const link = registration.extend({
  parent: NativeReportIdentitySchema,
  parentEpoch: z.string().uuid(),
});
const stateSchema = z
  .object({
    version: z.literal(1),
    prime: registration.nullable(),
    // Prime role count is not capped. Encoded state/permanent operation bounds remain finite.
    primes: z.array(registration).optional(),
    projectOwners: z
      .array(
        z
          .object({
            projectId: z.string().uuid(),
            prime: NativeReportIdentitySchema,
            primeEpoch: z.string().uuid(),
            epoch: z.string().uuid(),
          })
          .strict(),
      )
      .optional(),
    links: z.array(link).max(128),
    contentGrants: z.array(NativeArtifactContentGrantSchema).max(64).optional(),
    artifactTools: z
      .array(
        z
          .object({
            identity: NativeReportIdentitySchema,
            scope: NativeReportScopeSchema,
            registrationEpoch: z.string().uuid(),
            permitId: z.string().uuid(),
            expiresAt: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(128)
      .optional(),
    operations: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            epoch: z.string().uuid(),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
type Registration = z.infer<typeof registration>;
type Link = z.infer<typeof link>;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const scopeKey = (scope: NativeReportScope) => `${scope.projectId}/${scope.taskId}`;

/** Private host authority metadata only. Delivery and report receipts belong to MessageReceipts. */
export class NativeReportRegistry {
  private state?: State;
  private tail: Promise<unknown> = Promise.resolve();
  private unhealthy = false;
  private updating = false;

  constructor(
    private readonly file: string,
    private readonly currentIdentity: (agentId: string) => NativeReportIdentity | null,
    private readonly operationLimit = 10000,
    private readonly grantDirectory?: string,
  ) {
    if (!Number.isSafeInteger(operationLimit) || operationLimit < 1 || operationLimit > 10000)
      throw new Error("Invalid finite report registration operation limit");
  }

  private live(identity: NativeReportIdentity): void {
    if (!same(this.currentIdentity(identity.agentId), identity))
      throw new Error("Registered native report identity replaced or unavailable");
  }

  private async initialize(requireOwner: () => void): Promise<void> {
    if (this.state) return;
    let file;
    try {
      requireOwner();
      file = await fs.open(
        this.file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      requireOwner();
      this.state = { version: 1, prime: null, links: [], operations: [] };
      return;
    }
    let loaded: State;
    try {
      requireOwner();
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_STATE_BYTES || (stat.mode & 0o077) !== 0)
        throw new Error("Unsafe native report registration store");
      requireOwner();
      loaded = stateSchema.parse(JSON.parse(await file.readFile("utf8")));
      if (loaded.operations.length > this.operationLimit)
        throw new Error("Report registration permanent-ID maintenance required");
      this.validateTree(loaded);
    } finally {
      await file.close();
    }
    requireOwner();
    this.state = loaded;
  }

  private validateTree(state: State): void {
    const ids = new Set<string>();
    for (const root of this.roots(state)) {
      if (ids.has(root.identity.agentId)) throw new Error("Duplicate native prime identity");
      ids.add(root.identity.agentId);
      if (new Set(root.scopes.map(scopeKey)).size !== root.scopes.length)
        throw new Error("Duplicate report read scope");
    }
    for (const item of state.links) {
      if (!this.roots(state).length || ids.has(item.identity.agentId))
        throw new Error("Invalid report registration tree");
      ids.add(item.identity.agentId);
    }
    if (new Set(state.operations.map((op) => op.id)).size !== state.operations.length)
      throw new Error("Invalid report registration operation ledger");
    for (const item of state.links) this.chain(state, item.identity.agentId, false);
    const projects = new Set<string>();
    for (const owner of state.projectOwners ?? []) {
      if (projects.has(owner.projectId)) throw new Error("Duplicate project owning prime");
      projects.add(owner.projectId);
      const prime = this.roots(state).find(
        (root) => same(root.identity, owner.prime) && root.epoch === owner.primeEpoch,
      );
      if (!prime || !prime.scopes.some((scope) => scope.projectId === owner.projectId))
        throw new Error("Stale project owning prime");
    }
    for (const item of state.links)
      for (const scope of item.scopes) {
        const owner = (state.projectOwners ?? []).find(
          (value) => value.projectId === scope.projectId,
        );
        if (
          owner &&
          this.rootOf(state, item.identity.agentId).identity.agentId !== owner.prime.agentId
        )
          throw new Error("Cross-project report hierarchy refused");
      }
  }

  private roots(state: State): Registration[] {
    return [...(state.prime ? [state.prime] : []), ...(state.primes ?? [])];
  }
  private find(state: State, agentId: string): Registration | Link | null {
    return (
      this.roots(state).find((item) => item.identity.agentId === agentId) ??
      state.links.find((item) => item.identity.agentId === agentId) ??
      null
    );
  }
  private rootOf(state: State, agentId: string): Registration {
    this.chain(state, agentId, false);
    let item = this.find(state, agentId)!;
    while ("parent" in item) item = this.find(state, item.parent.agentId)!;
    return item;
  }
  private replaceRoot(state: State, value: Registration): void {
    if (state.prime?.identity.agentId === value.identity.agentId) state.prime = value;
    else
      state.primes = [
        ...(state.primes ?? []).filter((item) => item.identity.agentId !== value.identity.agentId),
        value,
      ];
  }
  private removeRoot(state: State, id: string): void {
    if (state.prime?.identity.agentId === id) state.prime = null;
    state.primes = (state.primes ?? []).filter((item) => item.identity.agentId !== id);
  }
  private rotateChildren(state: State, identity: NativeReportIdentity, epoch: string): void {
    for (const child of state.links)
      if (child.parent.agentId === identity.agentId) {
        child.parent = structuredClone(identity);
        child.parentEpoch = epoch;
      }
  }

  private chain(state: State, agentId: string, fresh: boolean): Registration | Link {
    let item = this.find(state, agentId);
    if (!item) throw new Error("Unknown or legacy report registration");
    const result = item,
      seen = new Set<string>();
    while (item) {
      if (seen.has(item.identity.agentId)) throw new Error("Cyclic report parent link");
      seen.add(item.identity.agentId);
      if (fresh) {
        if (item.retirement) throw new Error("Retired report source cannot issue new reports");
        this.live(item.identity);
      }
      if (!("parent" in item)) {
        if (!this.roots(state).includes(item)) throw new Error("Unregistered report root");
        return result;
      }
      const parent = this.find(state, item.parent.agentId);
      if (!parent || parent.epoch !== item.parentEpoch || !same(parent.identity, item.parent))
        throw new Error("Stale report parent registration");
      const parentScopes = new Set(parent.scopes.map(scopeKey));
      if (
        new Set(item.scopes.map(scopeKey)).size !== item.scopes.length ||
        item.scopes.some((scope) => !parentScopes.has(scopeKey(scope)))
      )
        throw new Error("Report recipient read scope refused");
      item = parent;
    }
    throw new Error("Unknown report root");
  }

  private withoutDescendants(state: State, agentId: string): Link[] {
    const removed = new Set([agentId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of state.links)
        if (removed.has(item.parent.agentId) && !removed.has(item.identity.agentId)) {
          removed.add(item.identity.agentId);
          changed = true;
        }
    }
    return state.links.filter((item) => !removed.has(item.identity.agentId));
  }

  private mutate(
    id: string,
    body: unknown,
    authority: MutationAuthority,
    check: (state: State, duplicate: boolean) => void,
    apply: (state: State, epoch: string) => void,
  ) {
    const execute = async () => {
      if (this.unhealthy) throw new Error("Native report registration durability unavailable");
      authority.requireAuthority();
      try {
        await this.initialize(authority.requireAuthority);
      } catch (error) {
        this.unhealthy = true;
        throw error;
      }
      const current = this.state!;
      const fingerprint = createHash("sha256")
        .update(canonicalJson({ body, creator: authority.creator }))
        .digest("hex");
      const prior = current.operations.find((op) => op.id === id);
      const guard = () => {
        authority.requireAuthority();
        check(current, !!prior);
      };
      guard();
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new Error("Report registration ID/body conflict");
        guard();
        return {
          messageId: id,
          epoch: prior.epoch,
          duplicate: true,
          current:
            current.operations.length < this.operationLimit &&
            (!![...this.roots(current), ...current.links].find(
              (item) => item.epoch === prior.epoch,
            ) ||
              (current.projectOwners ?? []).some((item) => item.epoch === prior.epoch)),
          maintenanceRequired: current.operations.length >= this.operationLimit,
        };
      }
      if (current.operations.length >= this.operationLimit)
        throw new Error("Report registration permanent-ID maintenance required");
      const next = structuredClone(current),
        epoch = randomUUID();
      apply(next, epoch);
      next.operations.push({ id, fingerprint, epoch });
      this.validateTree(next);
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_STATE_BYTES)
        throw new Error("Report registration resource limit");
      try {
        this.updating = true; // Fence report effects while the durable epoch publication is in flight.
        await writeJsonFileDurable(this.file, next, guard);
        guard(); // Fresh authority/identity after all awaits, immediately before publication.
        this.state = next;
      } catch (error) {
        this.unhealthy = true;
        throw error;
      } finally {
        this.updating = false;
      }
      return {
        messageId: id,
        epoch,
        duplicate: false,
        current:
          next.operations.length < this.operationLimit &&
          (!![...this.roots(next), ...next.links].find((item) => item.epoch === epoch) ||
            (next.projectOwners ?? []).some((item) => item.epoch === epoch)),
        maintenanceRequired: next.operations.length >= this.operationLimit,
      };
    };
    const work = this.tail.catch(() => undefined).then(execute);
    this.tail = work;
    return work;
  }

  async setArtifactTool(raw: unknown, owner: OwnerGuard) {
    const input = SetNativeArtifactToolSchema.parse(structuredClone(raw));
    const guard = () => {
      owner.requireOwner();
      this.live(input.identity);
    };
    await this.mutate(
      input.messageId,
      input,
      { creator: owner.ownerId, requireAuthority: guard },
      (state) => {
        const item = this.chain(state, input.identity.agentId, true);
        if (
          !same(item.identity, input.identity) ||
          item.epoch !== input.expectedEpoch ||
          !item.scopes.some((scope) => same(scope, input.scope)) ||
          !("parent" in item)
        )
          throw new Error("Exact registered artifact source required");
        if (
          input.enabled &&
          (input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 6 * 60 * 60 * 1000)
        )
          throw new Error("Finite artifact tool expiry required");
      },
      (state, epoch) => {
        const retained = (state.artifactTools ?? []).filter(
          (item) =>
            item.identity.agentId !== input.identity.agentId || !same(item.scope, input.scope),
        );
        if (input.enabled)
          retained.push({
            identity: input.identity,
            scope: input.scope,
            registrationEpoch: input.expectedEpoch,
            permitId: epoch,
            expiresAt: input.expiresAt,
          });
        state.artifactTools = retained;
      },
    );
    guard();
    const enabled = input.enabled && this.artifactToolAvailable(input.identity, input.scope);
    return { messageId: input.messageId, enabled, expiresAt: enabled ? input.expiresAt : null };
  }
  artifactToolAvailable(identity: NativeReportIdentity, scope: NativeReportScope): boolean {
    try {
      this.captureArtifactTool(identity, scope)();
      return true;
    } catch {
      return false;
    }
  }
  captureArtifactTool(identity: NativeReportIdentity, scope: NativeReportScope): () => void {
    const relation = this.requireParent(identity, scope);
    const permit = this.state?.artifactTools?.find(
      (item) =>
        same(item.identity, identity) &&
        same(item.scope, scope) &&
        item.registrationEpoch === relation.sourceEpoch,
    );
    if (!permit) throw new Error("Explicit owner artifact tool enable required");
    const captured = structuredClone(permit);
    const guard = () => {
      if (
        !same(this.requireParent(identity, scope), relation) ||
        !this.state?.artifactTools?.some((item) => same(item, captured)) ||
        Date.now() >= captured.expiresAt
      )
        throw new Error("Artifact tool enable revoked or expired");
    };
    guard();
    return guard;
  }

  private hasContentRootProof(
    record: import("@getpaseo/protocol/native-evidence").ManagedArtifactJournal,
  ): boolean {
    return (
      record.artifactReference.rootDev !== undefined &&
      record.artifactReference.rootIno !== undefined &&
      record.artifactReference.parentDev !== undefined &&
      record.artifactReference.parentIno !== undefined
    );
  }

  private validateContentGrantSources(
    state: State,
    input: ReturnType<typeof SetNativeArtifactContentGrantSchema.parse>,
    capturedRecords: readonly import("@getpaseo/protocol/native-evidence").ManagedArtifactJournal[],
  ): void {
    if (input.enabled) {
      if (capturedRecords.length !== input.artifactIds.length)
        throw new Error("Enumerated committed artifacts required");
      for (const record of capturedRecords) {
        const source = this.chain(state, record.source.agentId, false);
        if (
          !("parent" in source) ||
          !same(source.identity, record.source) ||
          source.epoch !== record.sourceEpoch ||
          !same(source.parent, input.identity) ||
          source.parentEpoch !== input.expectedEpoch ||
          !same(record.entry.scope, input.scope) ||
          !input.artifactIds.includes(record.entry.id) ||
          record.entry.expiresAt <= Date.now() ||
          !this.hasContentRootProof(record) ||
          !source.scopes.some((scope) => same(scope, input.scope))
        )
          throw new Error("Committed content source scope changed");
        if (source.retirement) {
          if (record.entry.at > source.retirement.at)
            throw new Error("Unfrozen content source refused");
        } else this.live(source.identity);
      }
    }
  }

  async setArtifactContentGrant(
    raw: unknown,
    owner: OwnerGuard,
    records: readonly import("@getpaseo/protocol/native-evidence").ManagedArtifactJournal[],
  ) {
    const input = SetNativeArtifactContentGrantSchema.parse(structuredClone(raw));
    const capturedRecords = structuredClone(records);
    const guard = () => {
      owner.requireOwner();
      this.live(input.identity);
    };
    await this.mutate(
      input.messageId,
      input,
      { creator: owner.ownerId, requireAuthority: guard },
      (state) => {
        const recipient = this.chain(state, input.identity.agentId, true);
        if (
          !same(recipient.identity, input.identity) ||
          recipient.epoch !== input.expectedEpoch ||
          !recipient.scopes.some((scope) => same(scope, input.scope))
        )
          throw new Error("Exact content grant recipient scope required");
        this.validateContentGrantSources(state, input, capturedRecords);
        const previous = state.contentGrants?.find((grant) => grant.grantId === input.grantId);
        if ((previous?.revision ?? null) !== input.expectedGrantRevision)
          throw new Error("Content grant revision changed");
        if (
          previous &&
          (!same(previous.identity, input.identity) || !same(previous.scope, input.scope))
        )
          throw new Error("Content grant cannot retarget");
        if (
          input.enabled &&
          (input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 6 * 3600000)
        )
          throw new Error("Finite content grant expiry required");
        if (new Set(input.artifactIds).size !== input.artifactIds.length)
          throw new Error("Duplicate content artifact identities refused");
      },
      (state, revision) => {
        const retained = (state.contentGrants ?? []).filter(
          (grant) => grant.grantId !== input.grantId,
        );
        if (input.enabled && retained.length >= 64)
          throw new Error("Finite content grant capacity exhausted");
        if (input.enabled)
          retained.push(
            NativeArtifactContentGrantSchema.parse({
              grantId: input.grantId,
              revision,
              identity: input.identity,
              expectedEpoch: input.expectedEpoch,
              scope: input.scope,
              artifactIds: input.artifactIds,
              byteBudget: input.byteBudget,
              expiresAt: input.expiresAt,
            }),
          );
        state.contentGrants = retained;
      },
    );
    guard();
    return this.artifactContentGrants(
      { identity: input.identity, expectedEpoch: input.expectedEpoch, scope: input.scope },
      guard,
    );
  }

  async artifactContentGrants(raw: unknown, requireOwner: () => void) {
    const input = NativeArtifactContentSelectionSchema.parse(raw);
    const status = await this.ownerStatus(input.identity, requireOwner);
    requireOwner();
    if (
      !status ||
      status.epoch !== input.expectedEpoch ||
      !status.scopes.some((scope) => same(scope, input.scope))
    )
      throw new Error("Exact content grant registration required");
    return {
      grants: structuredClone(
        (this.state?.contentGrants ?? []).filter(
          (grant) =>
            same(grant.identity, input.identity) &&
            grant.expectedEpoch === input.expectedEpoch &&
            same(grant.scope, input.scope) &&
            grant.expiresAt > Date.now(),
        ),
      ),
    };
  }

  captureArtifactContentGrant(input: NativeArtifactContentReadInput) {
    const selected = this.state?.contentGrants?.find((grant) => grant.grantId === input.grantId);
    if (
      !selected ||
      selected.revision !== input.grantRevision ||
      !same(selected.identity, input.identity) ||
      selected.expectedEpoch !== input.expectedEpoch ||
      !same(selected.scope, input.scope) ||
      !selected.artifactIds.includes(input.artifactId)
    )
      throw new Error("Enumerated content grant required");
    const grant = structuredClone(selected);
    let expired = false;
    const check = () => {
      if (!this.state || this.unhealthy || this.updating)
        throw new Error("Content authority unavailable");
      const recipient = this.chain(this.state, input.identity.agentId, true);
      expired ||= Date.now() >= grant.expiresAt;
      if (
        expired ||
        recipient.epoch !== input.expectedEpoch ||
        !same(recipient.identity, input.identity) ||
        !this.state.contentGrants?.some((current) => same(current, grant))
      )
        throw new Error("Content grant expired, revoked or changed");
    };
    check();
    return { grant, check };
  }

  /** Captured before create preparation. Labels, query caller IDs and report tokens cannot mint this. */
  captureCreation(parentIdentity: NativeReportIdentity, requireCreator: () => void) {
    if (!this.state || this.unhealthy || this.updating)
      throw new Error("Native report creation registration unavailable");
    requireCreator();
    const parent = structuredClone(this.chain(this.state, parentIdentity.agentId, true));
    if (!same(parent.identity, parentIdentity)) throw new Error("Exact native creator required");
    const id = randomUUID();
    return createNativeReportCreation(async (child) => {
      const guard = () => {
        requireCreator();
        this.live(child);
        if (!this.state || !same(this.chain(this.state, parentIdentity.agentId, true), parent))
          throw new Error("Native report creator registration changed");
      };
      const receipt = await this.mutate(
        id,
        { method: "host-created", child, parent: parent.identity, parentEpoch: parent.epoch },
        { creator: parent.identity.agentId, requireAuthority: guard },
        (state) => {
          guard();
          if (this.find(state, child.agentId) || child.agentId === parent.identity.agentId)
            throw new Error(
              "Native report creation cannot adopt or replace existing registrations",
            );
        },
        (state, epoch) => {
          if (state.links.length >= 128) throw new Error("Report registration resource limit");
          state.links.push({
            identity: child,
            parent: parent.identity,
            parentEpoch: parent.epoch,
            scopes: structuredClone(parent.scopes),
            epoch,
            creator: parent.identity.agentId,
            reportCredential: `report1.${randomBytes(32).toString("base64url")}`,
          });
        },
      );
      await this.publishGrant(child, receipt.epoch, guard);
    });
  }

  /** Host launch witness selects only report read/consume; never ordinary action or owner routes. */
  readerForNativeIdentity(identity: NativeReportIdentity) {
    if (!this.state || this.unhealthy || this.updating)
      throw new Error("Report authority unavailable");
    const current = this.chain(this.state, identity.agentId, true);
    if (!same(current.identity, identity) || !current.reportCredential)
      throw new Error("Exact registered report reader required");
    return this.authenticateReportReader(identity.agentId, current.reportCredential);
  }

  registerPrime(input: unknown, owner: OwnerGuard) {
    const a = RegisterReportPrimeSchema.parse(input);
    return this.mutate(
      a.messageId,
      { method: "prime", input: a },
      { creator: owner.ownerId, requireAuthority: owner.requireOwner },
      (state, duplicate) => {
        this.live(a.identity);
        if (new Set(a.scopes.map(scopeKey)).size !== a.scopes.length)
          throw new Error("Duplicate report read scope");
        if (!duplicate && (this.find(state, a.identity.agentId)?.epoch ?? null) !== a.expectedEpoch)
          throw new Error("Prime registration epoch changed");
      },
      (state, epoch) => {
        if (state.links.some((item) => item.identity.agentId === a.identity.agentId))
          throw new Error("Use explicit prime promotion for registered children");
        this.replaceRoot(state, {
          identity: a.identity,
          scopes: a.scopes,
          epoch,
          creator: owner.ownerId,
          reportCredential: `report1.${randomBytes(32).toString("base64url")}`,
        });
        this.rotateChildren(state, a.identity, epoch);
        for (const project of state.projectOwners ?? [])
          if (project.prime.agentId === a.identity.agentId) {
            project.prime = structuredClone(a.identity);
            project.primeEpoch = epoch;
            project.epoch = epoch;
          }
      },
    );
  }

  private projectState(state: State, projectId: string) {
    return (state.projectOwners ?? []).find((item) => item.projectId === projectId) ?? null;
  }
  private guardProjectIdentities(state: State, projects: readonly string[]): void {
    for (const item of [...this.roots(state), ...state.links])
      if (item.scopes.some((scope) => projects.includes(scope.projectId))) {
        this.chain(state, item.identity.agentId, false);
        if (!item.retirement) this.live(item.identity);
      }
  }
  private projectExpectation(
    state: State,
    changes: readonly { projectId: string; expectedOwnerEpoch: string | null }[],
    projects: readonly string[],
  ): void {
    if (
      new Set(changes.map((item) => item.projectId)).size !== changes.length ||
      !same(changes.map((item) => item.projectId).sort(), [...new Set(projects)].sort())
    )
      throw new Error("Explicit exact project ownership disposition required");
    for (const change of changes)
      if ((this.projectState(state, change.projectId)?.epoch ?? null) !== change.expectedOwnerEpoch)
        throw new Error("Project ownership epoch changed");
  }
  private rotateSubtree(state: State, id: string, epoch: string): void {
    const pending = [id];
    for (let index = 0; index < pending.length; index++) {
      const current = this.find(state, pending[index]!)!;
      current.epoch = epoch;
      current.reportCredential = `report1.${randomBytes(32).toString("base64url")}`;
      for (const child of state.links)
        if (child.parent.agentId === current.identity.agentId) {
          child.parentEpoch = epoch;
          pending.push(child.identity.agentId);
        }
    }
  }
  private hierarchyReceipt(
    receipt: Awaited<ReturnType<NativeReportRegistry["registerPrime"]>>,
    current: boolean,
  ) {
    return { ...receipt, current, pendingDisposition: "fenced-retained-no-retarget" as const };
  }
  /** Explicit owner promotion; moving project ownership is part of this same audited transaction. */
  async promotePrime(raw: unknown, owner: OwnerGuard) {
    const a = PromoteReportPrimeSchema.parse(structuredClone(raw));
    const receipt = await this.mutate(
      a.messageId,
      { method: "prime-promote", input: a },
      { creator: owner.ownerId, requireAuthority: owner.requireOwner },
      (state, duplicate) => {
        this.live(a.identity);
        this.guardProjectIdentities(
          state,
          a.scopes.map((scope) => scope.projectId),
        );
        const old = this.find(state, a.identity.agentId);
        if (!duplicate && (old?.epoch ?? null) !== a.expectedEpoch)
          throw new Error("Prime promotion epoch changed");
        if (old && !same(old.identity, a.identity))
          throw new Error("Exact prime promotion identity required");
        if (!duplicate)
          this.projectExpectation(
            state,
            a.projects,
            a.scopes.map((scope) => scope.projectId),
          );
      },
      (state, epoch) => {
        const previousRoot = this.find(state, a.identity.agentId)
          ? this.rootOf(state, a.identity.agentId)
          : null;
        state.links = state.links.filter((item) => item.identity.agentId !== a.identity.agentId);
        this.replaceRoot(state, {
          identity: a.identity,
          scopes: a.scopes,
          epoch,
          creator: owner.ownerId,
          reportCredential: `report1.${randomBytes(32).toString("base64url")}`,
        });
        this.rotateSubtree(state, a.identity.agentId, epoch);
        for (const change of a.projects) {
          const old = this.projectState(state, change.projectId);
          // Moving a project cannot strand sibling subtrees under its previous prime.
          for (const child of state.links)
            if (
              child.parent.agentId === (old?.prime.agentId ?? previousRoot?.identity.agentId) &&
              child.scopes.some((scope) => scope.projectId === change.projectId)
            ) {
              if (child.scopes.some((scope) => scope.projectId !== change.projectId))
                throw new Error("Mixed-project subtree transfer refused");
              child.parent = structuredClone(a.identity);
              child.parentEpoch = epoch;
              this.rotateSubtree(state, child.identity.agentId, epoch);
            }
          state.projectOwners = [
            ...(state.projectOwners ?? []).filter((item) => item.projectId !== change.projectId),
            { projectId: change.projectId, prime: a.identity, primeEpoch: epoch, epoch },
          ];
        }
      },
    );
    owner.requireOwner();
    return this.hierarchyReceipt(
      receipt,
      !!this.state &&
        this.roots(this.state).some(
          (item) => same(item.identity, a.identity) && item.epoch === receipt.epoch,
        ),
    );
  }
  /** Explicit upward disposition. No demotion may leave children under an unregistered root. */
  async demotePrime(raw: unknown, owner: OwnerGuard) {
    const a = DemoteReportPrimeSchema.parse(structuredClone(raw));
    const receipt = await this.mutate(
      a.messageId,
      { method: "prime-demote", input: a },
      { creator: owner.ownerId, requireAuthority: owner.requireOwner },
      (state, duplicate) => {
        this.live(a.identity);
        this.live(a.parent);
        this.guardProjectIdentities(
          state,
          a.projects.map((project) => project.projectId),
        );
        const root = this.roots(state).find((item) => same(item.identity, a.identity));
        const parent = this.chain(state, a.parent.agentId, true);
        if (
          !same(parent.identity, a.parent) ||
          parent.epoch !== a.expectedParentEpoch ||
          a.parent.agentId === a.identity.agentId
        )
          throw new Error("Exact distinct upward report parent required");
        if (duplicate) return;
        if (!root || root.epoch !== a.expectedEpoch)
          throw new Error("Prime demotion epoch changed");
        if (this.rootOf(state, a.parent.agentId).identity.agentId === a.identity.agentId)
          throw new Error("Cyclic prime demotion refused");
        if (root.scopes.some((scope) => !parent.scopes.some((available) => same(scope, available))))
          throw new Error("Upward parent read scope refused");
        this.projectExpectation(
          state,
          a.projects,
          (state.projectOwners ?? [])
            .filter((project) => project.prime.agentId === a.identity.agentId)
            .map((project) => project.projectId),
        );
      },
      (state, epoch) => {
        const old = this.find(state, a.identity.agentId)!;
        const parent = this.find(state, a.parent.agentId)!;
        const owningPrime = this.rootOf(state, parent.identity.agentId);
        this.removeRoot(state, a.identity.agentId);
        state.links.push({
          ...old,
          epoch,
          reportCredential: `report1.${randomBytes(32).toString("base64url")}`,
          parent: structuredClone(parent.identity),
          parentEpoch: parent.epoch,
        });
        // Children reparent upward, while the demoted session remains an ordinary scoped receiver.
        for (const child of state.links)
          if (child.parent.agentId === a.identity.agentId) {
            child.parent = structuredClone(parent.identity);
            child.parentEpoch = parent.epoch;
            this.rotateSubtree(state, child.identity.agentId, epoch);
          }
        for (const project of state.projectOwners ?? [])
          if (project.prime.agentId === a.identity.agentId) {
            project.prime = structuredClone(owningPrime.identity);
            project.primeEpoch = owningPrime.epoch;
            project.epoch = epoch;
          }
      },
    );
    owner.requireOwner();
    return this.hierarchyReceipt(
      receipt,
      !!this.state &&
        this.state.links.some(
          (item) => same(item.identity, a.identity) && item.epoch === receipt.epoch,
        ),
    );
  }
  /** One explicit owning prime per project, moved with its recorded children in one durable publication. */
  async transferProject(raw: unknown, owner: OwnerGuard) {
    const a = TransferReportProjectSchema.parse(structuredClone(raw));
    const receipt = await this.mutate(
      a.messageId,
      { method: "project-transfer", input: a },
      { creator: owner.ownerId, requireAuthority: owner.requireOwner },
      (state, duplicate) => {
        this.live(a.to);
        this.guardProjectIdentities(state, [a.projectId]);
        const target = this.roots(state).find((item) => same(item.identity, a.to));
        if (
          !target ||
          target.epoch !== a.expectedToEpoch ||
          !target.scopes.some((scope) => scope.projectId === a.projectId)
        )
          throw new Error("Exact project recipient prime and read scope required");
        if (duplicate) return;
        const current = this.projectState(state, a.projectId);
        if (
          (current?.epoch ?? null) !== a.expectedOwnerEpoch ||
          !same(current?.prime ?? null, a.from) ||
          (current?.primeEpoch ?? null) !== a.expectedFromEpoch
        )
          throw new Error("Exact original project owner required");
        if (a.from) this.live(a.from);
        if (
          !current &&
          state.links.some(
            (item) =>
              item.scopes.some((scope) => scope.projectId === a.projectId) &&
              this.rootOf(state, item.identity.agentId).identity.agentId !== a.to.agentId,
          )
        )
          throw new Error("Legacy project requires exact recorded origin before transfer");
      },
      (state, epoch) => {
        for (const child of state.links)
          if (
            a.from &&
            child.parent.agentId === a.from.agentId &&
            child.scopes.some((scope) => scope.projectId === a.projectId)
          ) {
            if (child.scopes.some((scope) => scope.projectId !== a.projectId))
              throw new Error("Mixed-project subtree transfer refused");
            child.parent = structuredClone(a.to);
            child.parentEpoch = a.expectedToEpoch;
            this.rotateSubtree(state, child.identity.agentId, epoch);
          }
        state.projectOwners = [
          ...(state.projectOwners ?? []).filter((item) => item.projectId !== a.projectId),
          {
            projectId: a.projectId,
            prime: structuredClone(a.to),
            primeEpoch: a.expectedToEpoch,
            epoch,
          },
        ];
      },
    );
    owner.requireOwner();
    return this.hierarchyReceipt(
      receipt,
      !!this.state && this.projectState(this.state, a.projectId)?.epoch === receipt.epoch,
    );
  }

  adoptParent(input: unknown, owner: OwnerGuard) {
    const a = AdoptReportParentSchema.parse(input);
    return this.mutate(
      a.messageId,
      { method: "adopt", input: a },
      { creator: owner.ownerId, requireAuthority: owner.requireOwner },
      (state, duplicate) => {
        this.live(a.child);
        this.live(a.parent);
        if (
          a.child.agentId === a.parent.agentId ||
          this.roots(state).some((root) => root.identity.agentId === a.child.agentId)
        )
          throw new Error("Self or cyclic report parent refused");
        const parent = this.chain(state, a.parent.agentId, true);
        if (!same(parent.identity, a.parent))
          throw new Error("Exact report parent identity required");
        const available = new Set(parent.scopes.map(scopeKey));
        if (
          new Set(a.scopes.map(scopeKey)).size !== a.scopes.length ||
          a.scopes.some((s) => !available.has(scopeKey(s)))
        )
          throw new Error("Report recipient read scope refused");
        const old = this.find(state, a.child.agentId);
        if (!duplicate && (old?.epoch ?? null) !== a.expectedEpoch)
          throw new Error("Report adoption epoch changed");
        if (
          this.withoutDescendants(state, a.child.agentId).every(
            (item) => item.identity.agentId !== a.parent.agentId,
          ) &&
          !this.roots(state).some((root) => root.identity.agentId === a.parent.agentId)
        )
          throw new Error("Cyclic report parent refused");
      },
      (state, epoch) => {
        const parent = this.find(state, a.parent.agentId)!;
        state.links = state.links.filter((item) => item.identity.agentId !== a.child.agentId);
        if (state.links.length >= 128) throw new Error("Report registration resource limit");
        state.links.push({
          identity: a.child,
          parent: a.parent,
          parentEpoch: parent.epoch,
          scopes: a.scopes,
          epoch,
          creator: owner.ownerId,
          reportCredential: `report1.${randomBytes(32).toString("base64url")}`,
        });
        this.rotateSubtree(state, a.child.agentId, epoch);
      },
    );
  }

  revoke(input: unknown, owner: OwnerGuard) {
    const a = RevokeReportRegistrationSchema.parse(input);
    return this.mutate(
      a.messageId,
      { method: "revoke", input: a },
      { creator: owner.ownerId, requireAuthority: owner.requireOwner },
      (state, duplicate) => {
        if (duplicate) return;
        const current = this.find(state, a.identity.agentId);
        if (!current || current.epoch !== a.expectedEpoch || !same(current.identity, a.identity))
          throw new Error("Exact registered report identity and epoch required");
      },
      (state) => {
        if (this.roots(state).some((root) => root.identity.agentId === a.identity.agentId)) {
          if (
            state.links.some((item) => item.parent.agentId === a.identity.agentId) ||
            (state.projectOwners ?? []).some(
              (project) => project.prime.agentId === a.identity.agentId,
            )
          )
            throw new Error("Demote or transfer before revoking a prime with children/projects");
          this.removeRoot(state, a.identity.agentId);
        } else state.links = this.withoutDescendants(state, a.identity.agentId);
      },
    );
  }

  /** Publish only current credentials rotated by this durable hierarchy operation; no wire issuance selector. */
  async publishHierarchyGrants(epoch: string, owner: OwnerGuard): Promise<void> {
    owner.requireOwner();
    if (!this.state || this.unhealthy || this.updating)
      throw new Error("Hierarchy publication unavailable");
    const snapshot = [...this.roots(this.state), ...this.state.links]
      .filter((item) => item.epoch === epoch && !item.retirement)
      .map((item) => structuredClone(item.identity));
    for (const identity of snapshot) {
      owner.requireOwner();
      await this.publishGrant(identity, epoch, owner.requireOwner);
    }
    owner.requireOwner();
  }

  /** Host owner adapter only. Never return credentials in a registration RPC receipt. */
  async publishReportGrant(
    identity: NativeReportIdentity,
    epoch: string,
    owner: OwnerGuard,
  ): Promise<void> {
    await this.publishGrant(identity, epoch, owner.requireOwner);
  }

  private async publishGrant(
    identity: NativeReportIdentity,
    epoch: string,
    requireAuthority: () => void,
  ): Promise<void> {
    if (!this.grantDirectory) return;
    const guard = () => {
      requireAuthority();
      if (this.unhealthy || this.updating || !this.state)
        throw new Error("Report authority unavailable");
      const current = this.chain(this.state, identity.agentId, true);
      if (current.epoch !== epoch || !same(current.identity, identity) || !current.reportCredential)
        throw new Error("Exact report grant registration required");
      return current;
    };
    const initial = guard();
    const grant = {
      sessionId: identity.agentId,
      capability: initial.reportCredential,
      kind: "report",
      epoch,
    };
    await writeJsonFileDurable(
      path.join(this.grantDirectory, `${identity.agentId}.json`),
      grant,
      () => {
        guard();
      },
    );
    guard();
  }

  /** Separate credential domain, checked before ordinary action/leadership routing. */
  authenticateReportReader(agentId: string, credential: string) {
    if (this.unhealthy || this.updating || !this.state)
      throw new Error("Report authority unavailable");
    const snapshot = structuredClone(this.chain(this.state, agentId, true));
    const stored = snapshot.reportCredential;
    if (
      !stored ||
      typeof credential !== "string" ||
      credential.length !== stored.length ||
      !timingSafeEqual(Buffer.from(credential), Buffer.from(stored))
    )
      throw new Error("Report credential refused");
    const guard = () => {
      if (this.unhealthy || this.updating || !this.state)
        throw new Error("Report authority unavailable");
      const current = this.chain(this.state, agentId, true);
      if (!same(current, snapshot)) throw new Error("Report credential epoch or scope changed");
    };
    guard();
    return createReportReader(
      snapshot.identity,
      snapshot.epoch,
      snapshot.scopes,
      guard,
      (member) => {
        guard();
        const parentLink = member.retirement
          ? this.requireRetiredParent(member)
          : this.requireParent(member.source, member.scope);
        const recipient = member.route
          ? this.requireOwningPrime(member)
          : { parent: parentLink.parent, parentEpoch: parentLink.parentEpoch };
        if (
          parentLink.sourceEpoch !== member.sourceEpoch ||
          recipient.parentEpoch !== snapshot.epoch ||
          !same(recipient.parent, snapshot.identity)
        )
          throw new Error("Report lifecycle/link changed");
      },
    );
  }

  /** One-use exact native self-relaunch. The host supplies the authenticated admission revision, never a wire exemption. */
  captureRelaunch(source: NativeReportIdentity, revision: string) {
    return this.captureReplacement(source, revision, false);
  }
  /** Original host-owned intent permits one fresh native context under the same managed identity. */
  /** Whether this agent has a report registration to move; "unknown" while the registry cannot be read. */
  async registrationOf(agentId: string): Promise<"registered" | "unregistered" | "unknown"> {
    try {
      await this.initialize(() => {});
    } catch {
      return "unknown";
    }
    if (!this.state || this.unhealthy || this.updating) return "unknown";
    return this.find(this.state, agentId) ? "registered" : "unregistered";
  }
  captureContextRotation(source: NativeReportIdentity, revision: string) {
    return this.captureReplacement(source, revision, true);
  }
  private captureReplacement(
    source: NativeReportIdentity,
    revision: string,
    contextRotation: boolean,
  ) {
    if (
      !this.state ||
      this.unhealthy ||
      this.updating ||
      !revision ||
      ["unmanaged", "unavailable"].includes(revision) ||
      revision.length > 4096
    )
      throw new Error("Authenticated native relaunch intent required");
    const old = structuredClone(this.chain(this.state, source.agentId, true));
    if (!same(old.identity, source)) throw new Error("Exact relaunch source required");
    const id = randomUUID();
    let attempted = false;
    return async (nextIdentity: NativeReportIdentity, requireIntent: () => void) => {
      if (attempted) throw new Error("Native relaunch intent already attempted");
      attempted = true;
      if (
        nextIdentity.agentId !== source.agentId ||
        (contextRotation
          ? nextIdentity.sessionId === source.sessionId
          : nextIdentity.sessionId !== source.sessionId) ||
        nextIdentity.boot !== source.boot ||
        nextIdentity.instanceId === source.instanceId
      )
        throw new Error("Exact old/new native relaunch identity required");
      const guard = () => {
        requireIntent();
        if (!this.state || !same(this.find(this.state, source.agentId), old))
          throw new Error("Native relaunch registration changed");
        if ("parent" in old) {
          const parent = this.chain(this.state, old.parent.agentId, true);
          if (!same(parent.identity, old.parent) || parent.epoch !== old.parentEpoch)
            throw new Error("Native relaunch parent changed");
        }
      };
      const receipt = await this.mutate(
        id,
        {
          method: contextRotation ? "context-rotation" : "self-relaunch",
          old: source,
          next: nextIdentity,
          revision,
        },
        { creator: source.agentId, requireAuthority: guard },
        () => guard(),
        (state, epoch) => {
          const current = this.find(state, source.agentId)!;
          current.identity = structuredClone(nextIdentity);
          current.epoch = epoch;
          current.reportCredential = `report1.${randomBytes(32).toString("base64url")}`;
          for (const child of state.links)
            if (same(child.parent, source) && child.parentEpoch === old.epoch) {
              child.parent = structuredClone(nextIdentity);
              child.parentEpoch = epoch;
            }
          for (const project of state.projectOwners ?? [])
            if (same(project.prime, source) && project.primeEpoch === old.epoch) {
              project.prime = structuredClone(nextIdentity);
              project.primeEpoch = epoch;
              project.epoch = epoch;
            }
        },
      );
      // Fresh host intent at every private credential publication boundary, after registry publication.
      await this.publishGrant(nextIdentity, receipt.epoch, requireIntent);
      return receipt;
    };
  }

  /** Capture while the host owns the live source; commit only its observed completed close. */
  captureRetirement(source: NativeReportIdentity) {
    if (!this.state || this.unhealthy || this.updating)
      throw new Error("Report authority unavailable");
    const captured = structuredClone(this.chain(this.state, source.agentId, true));
    if (!("parent" in captured) || !same(captured.identity, source))
      throw new Error("Verified retiring native child required");
    const id = randomUUID();
    let used = false;
    return async (requireClosed: () => void) => {
      if (used) throw new Error("Native retirement already attempted");
      used = true;
      const at = Date.now();
      const guard = () => {
        requireClosed();
        if (!this.state || !same(this.find(this.state, source.agentId), captured))
          throw new Error("Retiring report registration changed");
        const parent = this.chain(this.state, captured.parent.agentId, true);
        if (parent.epoch !== captured.parentEpoch || !same(parent.identity, captured.parent))
          throw new Error("Retiring report parent changed");
      };
      await this.mutate(
        id,
        { method: "host-retired", source, epoch: captured.epoch, at },
        { creator: source.agentId, requireAuthority: guard },
        () => guard(),
        (state) => {
          this.find(state, source.agentId)!.retirement = { id, at };
        },
      );
      return captured.scopes.flatMap((scope) => {
        const member: ReportMember = {
          id: deterministicId({ retirement: id, scope }),
          source,
          scope,
          sourceEpoch: captured.epoch,
          retirement: id,
          kind: "ended",
          at,
        };
        const check = () => {
          this.requireRetiredParent(member);
        };
        check();
        const detail = createNativeReportBatch(
          { parent: captured.parent, parentEpoch: captured.parentEpoch, members: [member] },
          check,
        );
        const owner = this.projectState(this.state!, scope.projectId);
        if (!owner || owner.prime.agentId === captured.parent.agentId) return [detail];
        const rollup = {
          ...member,
          id: deterministicId({
            id: member.id,
            routing: "owning-prime-rollup",
          }),
          route: { ownerEpoch: owner.epoch },
        };
        // Frozen retirement identity is identical; only the recipient-specific immutable membership ID differs.
        const requireRollup = () => {
          check();
          this.requireOwningPrime(rollup);
        };
        return [
          detail,
          createNativeReportBatch(
            { parent: owner.prime, parentEpoch: owner.primeEpoch, members: [rollup] },
            requireRollup,
          ),
        ];
      });
    };
  }

  private requireRetiredParent(member: ReportMember) {
    if (!this.state || this.unhealthy || this.updating)
      throw new Error("Report authority unavailable");
    const source = this.find(this.state, member.source.agentId);
    if (
      !source ||
      !("parent" in source) ||
      !source.retirement ||
      !same(source.identity, member.source) ||
      source.epoch !== member.sourceEpoch ||
      source.retirement.id !== member.retirement ||
      source.retirement.at !== member.at ||
      member.kind !== "ended" ||
      member.id !==
        (member.route
          ? deterministicId({
              id: deterministicId({ retirement: member.retirement, scope: member.scope }),
              routing: "owning-prime-rollup",
            })
          : deterministicId({ retirement: member.retirement, scope: member.scope })) ||
      !source.scopes.some((scope) => same(scope, member.scope))
    )
      throw new Error("Frozen native retirement fact required");
    const parent = this.chain(this.state, source.parent.agentId, true);
    if (parent.epoch !== source.parentEpoch || !same(parent.identity, source.parent))
      throw new Error("Retired report parent changed");
    return { sourceEpoch: source.epoch, parent: source.parent, parentEpoch: source.parentEpoch };
  }

  private requireOwningPrime(member: ReportMember) {
    if (!this.state || this.unhealthy || this.updating || !member.route)
      throw new Error("Owning prime report unavailable");
    const relation = member.retirement
      ? this.requireRetiredParent(member)
      : this.requireParent(member.source, member.scope);
    const owner = this.projectState(this.state, member.scope.projectId);
    if (
      !owner ||
      owner.epoch !== member.route.ownerEpoch ||
      relation.sourceEpoch !== member.sourceEpoch ||
      this.rootOf(this.state, member.source.agentId).identity.agentId !== owner.prime.agentId
    )
      throw new Error("Recorded owning prime changed");
    const root = this.chain(this.state, owner.prime.agentId, true);
    if (root.epoch !== owner.primeEpoch || !same(root.identity, owner.prime))
      throw new Error("Owning prime epoch changed");
    return { parent: owner.prime, parentEpoch: owner.primeEpoch };
  }

  /** Native host lifecycle owner only; the sender never supplies a recipient. */
  captureLifecycleReports(
    source: NativeReportIdentity,
    kind: ReportMember["kind"],
    lifecycleId: string,
    at: number,
  ) {
    if (!this.state || this.unhealthy || this.updating || !lifecycleId || lifecycleId.length > 200)
      throw new Error("Native lifecycle report registration unavailable");
    const sourceRegistration = this.chain(this.state, source.agentId, true);
    if (!("parent" in sourceRegistration) || !same(sourceRegistration.identity, source))
      throw new Error("Verified native lifecycle source required");
    return sourceRegistration.scopes.flatMap((scope) => {
      const hex = createHash("sha256")
        .update(
          canonicalJson({
            source,
            kind,
            lifecycleId,
            scope,
          }),
        )
        .digest("hex");
      const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      const origin = { lifecycleId };
      const detail = this.captureReportBatch([{ id, source, scope, kind, at, origin }]);
      const owner = this.projectState(this.state!, scope.projectId);
      if (!owner || owner.prime.agentId === sourceRegistration.parent.agentId) return [detail];
      const route = { ownerEpoch: owner.epoch };
      const event = {
        id: deterministicId({ id, routing: "owning-prime-rollup" }),
        source,
        scope,
        kind,
        at,
        sourceEpoch: sourceRegistration.epoch,
        origin,
        route,
      };
      const captured = structuredClone({ owner, parent: this.requireParent(source, scope) });
      const guard = () => {
        if (
          !this.state ||
          this.unhealthy ||
          this.updating ||
          !same(this.projectState(this.state, scope.projectId), captured.owner) ||
          !same(this.requireParent(source, scope), captured.parent)
        )
          throw new Error("Owning prime report routing changed");
        const root = this.chain(this.state, owner.prime.agentId, true);
        if (root.epoch !== owner.primeEpoch || !same(root.identity, owner.prime))
          throw new Error("Owning prime report epoch changed");
      };
      guard();
      return [
        detail,
        createNativeReportBatch(
          { parent: owner.prime, parentEpoch: owner.primeEpoch, members: [event] },
          guard,
        ),
      ];
    });
  }

  /** Native host lifecycle owner only; the sender never supplies a recipient. */
  captureReportBatch(events: readonly Omit<ReportMember, "sourceEpoch">[]) {
    const snapshot = structuredClone(events);
    if (!snapshot.length || snapshot.length > 8) throw new Error("Bounded report members required");
    const links = snapshot.map((event) => this.requireParent(event.source, event.scope));
    const parent = links[0]!.parent,
      parentEpoch = links[0]!.parentEpoch;
    if (
      links.some(
        (parentLink) => !same(parentLink.parent, parent) || parentLink.parentEpoch !== parentEpoch,
      )
    )
      throw new Error("Single verified report recipient required");
    const guard = () => {
      snapshot.forEach((event, index) => {
        if (!same(this.requireParent(event.source, event.scope), links[index]))
          throw new Error("Report parent or scope changed");
      });
    };
    guard();
    return createNativeReportBatch(
      {
        parent,
        parentEpoch,
        members: snapshot.map((event, index) =>
          Object.assign(
            {
              id: event.id,
              source: event.source,
              scope: event.scope,
              kind: event.kind,
              at: event.at,
              sourceEpoch: links[index]!.sourceEpoch,
            },
            event.origin ? { origin: event.origin } : {},
          ),
        ),
      },
      guard,
    );
  }

  /** Owner-only administration view; credentials/operation bodies are never published. */
  ownerStatus(identity: NativeReportIdentity, requireOwner: () => void) {
    const captured = structuredClone(identity);
    const guard = () => {
      requireOwner();
      this.live(captured);
    };
    const execute = async () => {
      if (this.unhealthy || this.updating) throw new Error("Report authority unavailable");
      guard();
      await this.initialize(guard);
      guard();
      const item = this.find(this.state!, captured.agentId);
      return item
        ? structuredClone({
            epoch: item.epoch,
            parent: "parent" in item ? item.parent : null,
            scopes: item.scopes,
            primeRole: !("parent" in item),
            owningProjects: (this.state!.projectOwners ?? [])
              .filter((project) => project.prime.agentId === item.identity.agentId)
              .map((project) => ({ projectId: project.projectId, epoch: project.epoch })),
          })
        : null;
    };
    const result = this.tail.catch(() => undefined).then(execute);
    this.tail = result;
    return result;
  }

  /** Only a fully current verified link can own an ordinary finish notification. */
  ownsFinish(source: NativeReportIdentity, parentAgentId: string): boolean {
    try {
      if (!this.state) return false;
      const item = this.chain(this.state, source.agentId, true);
      if (!("parent" in item) || !same(item.identity, source)) return false;
      return item.scopes.every(
        (scope) => this.requireParent(source, scope).parent.agentId === parentAgentId,
      );
    } catch {
      return false;
    }
  }

  captureEvidenceScope(source: NativeReportIdentity) {
    if (!this.state || this.unhealthy || this.updating)
      throw new Error("Native evidence registration unavailable");
    const capturedRegistration = this.chain(this.state, source.agentId, true);
    if (!same(capturedRegistration.identity, source))
      throw new Error("Exact native evidence source required");
    if (!("parent" in capturedRegistration)) return [];
    return capturedRegistration.scopes.map((scope) =>
      Object.assign({ scope: structuredClone(scope) }, this.requireParent(source, scope)),
    );
  }

  requireCommittedEvidence(
    source: NativeReportIdentity,
    sourceEpoch: string,
    recipient: NativeReportIdentity,
    recipientEpoch: string,
    scope: NativeReportScope,
    at: number,
  ): void {
    if (!this.state || this.unhealthy || this.updating)
      throw new Error("Native evidence read unavailable");
    const item = this.chain(this.state, source.agentId, false);
    if (
      !("parent" in item) ||
      !same(item.identity, source) ||
      item.epoch !== sourceEpoch ||
      !same(item.parent, recipient) ||
      item.parentEpoch !== recipientEpoch ||
      !item.scopes.some((s) => same(s, scope))
    )
      throw new Error("Native evidence source linkage changed");
    if (item.retirement) {
      if (at > item.retirement.at)
        throw new Error("Native evidence is not a frozen committed fact");
    } else this.live(source);
    const parent = this.chain(this.state, recipient.agentId, true);
    if (parent.epoch !== recipientEpoch || !same(parent.identity, recipient))
      throw new Error("Native evidence recipient changed");
  }

  /** Synchronous final fence for a host report; callers cannot select a recipient. */
  requireParent(
    source: NativeReportIdentity,
    scope: NativeReportScope,
  ): Readonly<{
    sourceEpoch: string;
    parent: NativeReportIdentity;
    parentEpoch: string;
  }> {
    if (this.unhealthy || this.updating || !this.state)
      throw new Error("Native report registration unavailable");
    if (this.state.operations.length >= this.operationLimit)
      throw new Error("Report registration permanent-ID maintenance required");
    const sourceRegistration = this.chain(this.state, source.agentId, true);
    if (
      !("parent" in sourceRegistration) ||
      !same(sourceRegistration.identity, source) ||
      !sourceRegistration.scopes.some((s) => scopeKey(s) === scopeKey(scope))
    )
      throw new Error("Verified scoped report parent required");
    return Object.freeze({
      sourceEpoch: sourceRegistration.epoch,
      parent: Object.freeze({ ...sourceRegistration.parent }),
      parentEpoch: sourceRegistration.parentEpoch,
    });
  }
}

function deterministicId(body: unknown): string {
  const hex = createHash("sha256").update(canonicalJson(body)).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
