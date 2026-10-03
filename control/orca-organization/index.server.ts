import { contributeWorkspaceOrganization } from "./server/organization/index";
import { radiusScratchSimulateRpc, radiusScratchPruneSimulateRpc } from "./shared/radius-scratch";
import {
  withManagementInvocation,
  invocationReadOnly,
  invokeManagement,
} from "./server/management-context.mjs";
import {
  receiptMaintenanceRpc,
  artifactToolSetRpc,
  artifactContentGrantSetRpc,
  artifactContentGrantListRpc,
  reportPrimeRegisterRpc,
  reportPrimePromoteRpc,
  reportPrimeDemoteRpc,
  reportProjectTransferRpc,
  reportParentAdoptRpc,
  reportRegistrationRevokeRpc,
  intercomRateSettingsRpc,
  intercomRateSettingsGetRpc,
  intercomStatusRpc,
} from "./shared/intercom";
import {
  cleanupPreviewRpc,
  cleanupApplyRpc,
  cleanupRetentionRpc,
} from "./shared/worktree-lifecycle";
import { historyRpc } from "./shared/history";
import { readHistory } from "./server/history";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { organizationSnapshot, createSnapshotReader, readBoard } from "./server/organization";
import { snapshotRpc } from "./shared/organization";
import { managementRpc, taskManagementRpc } from "./shared/management";
import { createManagement, createTaskManagement, localCall } from "./server/management";
import { operatorInvokeRpc } from "./shared/operator-invoke";
import { operatorInvoke } from "./server/operator-invoke.mjs";
import { taskCatalogRpc, usageRpc } from "./shared/tasks";
import { readTaskCatalog, taskPage, singleFlight, createUsageReader } from "./server/tasks";
import { outcomeRpc, outcomeArtifactRpc } from "./shared/outcomes";
import {
  createOutcomeAccess,
  createOutcomeReader,
  readOutcome,
  OUTCOME_ROOT,
} from "./server/outcomes";
import {
  inboxRpc,
  decisionRpc,
  decisionChooseRpc,
  reviewRecordRpc,
  heldMessageRpc,
  heldReadRpc,
  heldReplyRpc,
  heldReleaseRpc,
  digestRpc,
} from "./shared/cc/decision";
import { createInbox, outcomeDirectory } from "./server/inbox";
import {
  environmentsRpc,
  environmentProposeRpc,
  promotionCreateRpc,
  promotionCancelRpc,
} from "./shared/cc/environment";
import { createEnvironments } from "./server/environments";
import {
  devicesRpc,
  devicePairOpenRpc,
  devicePairCompleteRpc,
  devicePairApproveRpc,
  deviceRevokeRpc,
} from "./shared/cc/devices";
import { createDevices } from "./server/devices";
import {
  channelsRpc,
  channelPairOpenRpc,
  channelPauseRpc,
  channelRevokeRpc,
} from "./shared/cc/channels";
import { createChannels, startPush } from "./server/channels";
import {
  remitsRpc,
  remitAssignRpc,
  remitMoveRpc,
  remitEndRpc,
  projectDomainSetRpc,
} from "./shared/cc/remit";
import { projectBriefRpc } from "./shared/cc/brief";
import { createOrganisation } from "./server/organisation";
import { fleetRpc, activityRpc, fleetHostsRpc } from "./shared/fleet";
import { readFleet, readActivity, enrollment, bounded, readFleetHosts } from "./server/fleet";
import { sessionFileHistoryRpc, sessionStepRpc, sessionTurnsRpc } from "./shared/session-steps";
import { createSessionSteps } from "./server/session-steps";
import { projectsRpc } from "./shared/projects";
import { sessionDefaultsRpc } from "./shared/session-defaults";
import { createSessionDefaultsReader, roleDefaultsHook } from "./server/session-defaults";
import {
  accountsRpc,
  accountAddRpc,
  accountUpdateRpc,
  poolSettingsRpc,
  sessionAccountsRpc,
  accountSwitchRpc,
  accountTakeoverRpc,
} from "./shared/accounts";
import { createAccountHandlers, controllerTakeOver } from "./server/accounts-rpc";
import { portable } from "./server/portable";
import { orchestrationHook } from "./server/orchestration";
import { sessionOpenHook } from "./server/accounts.mjs";
import { loadConfig } from "./server/config.mjs";
import { readProjects } from "./server/projects";
import { briefingRpc } from "./shared/briefing";
import { createBriefingReader } from "./server/briefing";
import {
  projectRequestSessionRpc,
  roleAdoptRpc,
  roleAllowanceSetRpc,
  roleAllowancesRpc,
  roleAssignRpc,
  roleDirectoryRpc,
  roleProjectRpc,
  sessionOwnershipRpc,
  sessionRequestsRpc,
} from "./shared/roles";
import type { Contract, ContractInput, ContractOutput } from "./shared/rpc-contract";
import { workMapProjectRpc, workMapRpc } from "./shared/work-map";
import {
  boardIssueProvider,
  createIssueResolver,
  createWorkMapProjectReader,
  createWorkMapReader,
} from "./server/work-map";
import {
  createAllowanceSet,
  createAllowancesReader,
  createRoleAdopt,
  createRoleAssign,
  createRoleDirectoryReader,
  createRoleProjectReader,
  createSessionOwnershipReader,
  createSessionRequest,
  createSessionRequestsReader,
} from "./server/roles";
import {
  trackersRpc,
  trackerDirectoryRpc,
  trackerResolveRpc,
  trackerMapRpc,
  trackerUnmapRpc,
  trackerLinkRpc,
  trackerUnlinkRpc,
} from "./shared/trackers";
import { createTrackerService } from "./server/trackers/service.mjs";
import { createGithubConnector } from "./server/trackers/github.mjs";
import { createGhRunner } from "./server/trackers/gh-runner.mjs";
import { createJiraConnector } from "./server/trackers/jira.mjs";
import { createBitbucketConnector } from "./server/trackers/bitbucket.mjs";
import fsp from "node:fs/promises";
import {
  integrationsRpc,
  trackerMappingsRpc,
  trackerMappingResolveRpc,
  trackerMappingMapRpc,
  trackerMappingUnmapRpc,
  trackerViewRpc,
  trackerRefreshRpc,
} from "./shared/cc/connectors";
import { linkSetRpc, linkRemoveRpc, linksRpc } from "./shared/cc/links";
import { createConnectorService } from "./server/connectors/service.mjs";
import { createRegistry } from "./server/connectors/registry.mjs";
import {
  createGithubConnector as createGithubTracker,
  createGhHttp,
  assertGhArgs as assertTrackerGhArgs,
} from "./server/connectors/github.mjs";
import { createJiraConnector as createJiraTracker } from "./server/connectors/jira.mjs";
import { createBitbucketConnector as createBitbucketTracker } from "./server/connectors/bitbucket.mjs";
import { accountHttp, type HostRequest } from "./server/connectors/http.mjs";
import { createGitRunner } from "./server/connectors/git.mjs";
import { scanProject } from "./server/connectors/provenance.mjs";
import { listAgents } from "./server/fleet";
// J3: tracker credentials come only from the host's per-plugin keychain namespace. A host that predates
// ctx.secrets has none, so keychain mode reports auth-required; the opt-in gh mode still works.
const noSecrets = {
  read: async (): Promise<string | null> => {
    throw new Error("Plugin secrets are not available on this host");
  },
};
import { contributeRecovery } from "./server/recovery";
import { READ_DEADLINE_MS, TRACKER_REFRESH_DEADLINE_MS, withDeadline } from "./server/deadline";
export default function contribute(
  server: PluginServerContext,
  options: { readDeadlineMs?: number } = {},
): () => void {
  const readDeadlineMs = options.readDeadlineMs ?? READ_DEADLINE_MS;
  // `server.handle` carries the same `extends ZodType` constraint as `defineRpc`, which zod 4.6.2
  // cannot satisfy; see shared/rpc-contract.ts. Same method at runtime, bound once here.
  const registered: string[] = [];
  // D13: `hostRead` declares the method to the host as callable by a read-only device. It is `readOnly` for reads; manage and
  // task-manage add it because every effect they have goes through controller management, which the host runs
  // read-only for such a device (so only their health/list reads can succeed).
  const register = (
    contract: { name: string },
    handler: any,
    readOnly = false,
    hostRead = readOnly,
  ) => {
    registered.push(contract.name);
    // D13: a read is declared to the host (options.readOnly), which lets a read-only device call it and nothing else.
    return (
      server.handle as unknown as (c: unknown, h: unknown, o?: { readOnly?: boolean }) => void
    )(
      contract,
      (input: unknown, context: unknown) =>
        withManagementInvocation(context, invocationReadOnly(readOnly, context), () =>
          handler(input, context),
        ),
      hostRead ? { readOnly: true } : undefined,
    );
  };
  const handle = register as unknown as <I, O>(
    contract: Contract<I, O>,
    handler: (
      input: ContractInput<Contract<I, O>>,
      context: { paseo: any },
    ) => ContractOutput<Contract<I, O>> | Promise<ContractOutput<Contract<I, O>>>,
  ) => void;
  // J6: reads answer before the host's own 30 s timeout (server/deadline.ts). Mutations keep `handle`.
  const handleRead = ((
    contract: { name: string },
    handler: (input: unknown, context: unknown) => unknown,
  ) =>
    register(
      contract,
      (input: unknown, context: unknown) =>
        withDeadline(() => handler(input, context), readDeadlineMs, contract.name),
      true,
    )) as unknown as typeof handle;
  // Deliberately not handleRead: only the native owner's live invocation may see global counts.
  handle(artifactContentGrantSetRpc, (input) =>
    invokeManagement("artifact-content-owner-set", input),
  );
  handle(artifactContentGrantListRpc, (input) =>
    invokeManagement("artifact-content-owner-list", input),
  );
  // Mutating host scratch operations: never handleRead or a generic controller fallback.
  handle(radiusScratchSimulateRpc, (input) => invokeManagement("radius-scratch-simulate", input));
  handle(radiusScratchPruneSimulateRpc, (input) =>
    invokeManagement("radius-scratch-prune-and-simulate", input),
  );
  handle(artifactToolSetRpc, (input) => invokeManagement("artifact-tool-owner-set", input));
  handle(receiptMaintenanceRpc, () => invokeManagement("intercom-receipt-maintenance"));
  handle(reportPrimeRegisterRpc, (input) => invokeManagement("report-prime-register", input));
  handle(reportPrimePromoteRpc, (input) => invokeManagement("report-prime-promote", input));
  handle(reportPrimeDemoteRpc, (input) => invokeManagement("report-prime-demote", input));
  handle(reportProjectTransferRpc, (input) => invokeManagement("report-project-transfer", input));
  // Protected owner reads, deliberately never the delegated handleRead path.
  handle(intercomRateSettingsGetRpc, () => invokeManagement("intercom-rate-settings-get"));
  handle(intercomStatusRpc, (input) => invokeManagement("intercom-status", input));
  handle(intercomRateSettingsRpc, (input) => invokeManagement("intercom-rate-settings-set", input));
  handle(reportParentAdoptRpc, (input) => invokeManagement("report-parent-adopt", input));
  handle(reportRegistrationRevokeRpc, (input) =>
    invokeManagement("report-registration-revoke", input),
  );
  const manage = createManagement(),
    taskManage = createTaskManagement(),
    catalog = singleFlight(() => readTaskCatalog());
  let authError: string | undefined = undefined;
  // Availability is checked on every invocation, including cached reads; read contexts permit only read commands.
  handleRead(cleanupPreviewRpc, (input) => {
    if (authError) throw new Error(authError);
    return localCall("worktree-lifecycle-preview", input);
  });
  handle(cleanupApplyRpc, (input) => {
    if (authError) throw new Error(authError);
    return localCall("worktree-lifecycle-apply", input);
  });
  handle(cleanupRetentionRpc, (input) => {
    if (authError) throw new Error(authError);
    return localCall("worktree-lifecycle-retention", input);
  });
  let fleet: (() => Promise<Awaited<ReturnType<typeof readFleet>>>) | undefined;
  let projects: (() => Promise<Awaited<ReturnType<typeof readProjects>>>) | undefined;
  handleRead(projectsRpc, () => {
    if (authError) throw new Error(authError);
    projects ??= singleFlight(() => readProjects());
    return projects();
  });
  handleRead(fleetRpc, (input, { paseo }) => {
    if (authError) throw new Error(authError);
    if (Object.keys(input).length)
      return readFleet(paseo, undefined, undefined, undefined, undefined, input);
    fleet ??= singleFlight(() => readFleet(paseo), Date.now, 10000);
    return fleet();
  });
  handleRead(activityRpc, (input, { paseo }) => {
    if (authError) throw new Error(authError);
    return readActivity(input, paseo);
  });
  handleRead(fleetHostsRpc, () => {
    if (authError) throw new Error(authError);
    return readFleetHosts();
  });
  handleRead(historyRpc, (input, { paseo }) => {
    if (authError) throw new Error(authError);
    return readHistory(input, paseo);
  });
  // J6 step-through: reads over the host's timeline turn index, answered in plain words ("unsupported" on an
  // older host). Enrollment decides which sessions can be read, exactly as for activity history.
  const sessionSteps = createSessionSteps({
    call: localCall,
    enrollment,
    bounded,
    projects: () => {
      projects ??= singleFlight(() => readProjects());
      return projects();
    },
  });
  handleRead(sessionTurnsRpc, (input, { paseo }) => {
    if (authError) throw new Error(authError);
    return sessionSteps.turns(input, paseo);
  });
  handleRead(sessionStepRpc, (input, { paseo }) => {
    if (authError) throw new Error(authError);
    return sessionSteps.step(input, paseo);
  });
  handleRead(sessionFileHistoryRpc, (input, { paseo }) => {
    if (authError) throw new Error(authError);
    return sessionSteps.fileHistory(input, paseo);
  });
  const allowedOutcome = createOutcomeAccess(taskManage, () => authError);
  const outcomes = createOutcomeReader(allowedOutcome);
  const briefing = createBriefingReader(
    catalog,
    () => {
      projects ??= singleFlight(() => readProjects());
      return projects();
    },
    allowedOutcome,
  );
  handleRead(briefingRpc, (input) => {
    if (authError) throw new Error(authError);
    return briefing(input);
  });
  // Role seats are read even while management authentication is degraded: an unreadable binding
  // table must report itself unreadable rather than disappear into "no orchestrator assigned".
  const roleDirectory = createRoleDirectoryReader(),
    roleProject = createRoleProjectReader(),
    roleAssign = createRoleAssign();
  const sessionRequests = createSessionRequestsReader(),
    requestSession = createSessionRequest();
  const allowances = createAllowancesReader(),
    allowanceSet = createAllowanceSet(),
    adopt = createRoleAdopt();
  handleRead(roleDirectoryRpc, () => roleDirectory());
  handleRead(roleProjectRpc, (input) => roleProject(input));
  // A write still requires the verified daemon, exactly like every other management action.
  handle(roleAssignRpc, (input) =>
    authError
      ? {
          status: "error" as const,
          message: authError,
          observedAt: new Date().toISOString(),
          role: null,
          seat: null,
          revision: null,
          sessionId: null,
          previousSessionId: null,
          grantsAuthority: false as const,
        }
      : roleAssign(input),
  );
  handleRead(sessionRequestsRpc, () => sessionRequests());
  handleRead(roleAllowancesRpc, () => allowances());
  // Adoption and allowance grants are control mutations: verified daemon required.
  handle(roleAdoptRpc, (input) =>
    authError
      ? {
          status: "unavailable" as const,
          message: authError,
          observedAt: new Date().toISOString(),
          sessionId: null,
          seat: null,
          remaining: null,
          grantsAuthority: false as const,
        }
      : adopt(input),
  );
  handle(roleAllowanceSetRpc, (input) =>
    authError
      ? {
          status: "unavailable" as const,
          message: authError,
          observedAt: new Date().toISOString(),
          seat: null,
          maxSessions: null,
          remaining: null,
          grantsAuthority: false as const,
        }
      : allowanceSet(input),
  );
  // Asking a seat for a session is a control mutation: it needs the verified daemon.
  handle(projectRequestSessionRpc, (input) =>
    authError
      ? {
          status: "unavailable" as const,
          message: authError,
          observedAt: new Date().toISOString(),
          requestId: null,
          state: null,
          grantsAuthority: false as const,
        }
      : requestSession(input),
  );
  // Fulcra work map: two reads, no writes. Gated like every other management read; the fleet and
  // project directory are the single-flighted readers above, so the map adds no second copy of them.
  const issues = createIssueResolver([boardIssueProvider()]);
  let workMap:
    | (() => Promise<Awaited<ReturnType<ReturnType<typeof createWorkMapReader>>>>)
    | undefined;
  const workMapProjects = new Map<
    string,
    () => Promise<Awaited<ReturnType<ReturnType<typeof createWorkMapProjectReader>>>>
  >();
  handleRead(workMapRpc, (_input, { paseo }) => {
    if (authError) throw new Error(authError);
    const sharedFleet = () => {
      fleet ??= singleFlight(() => readFleet(paseo), Date.now, 10000);
      return fleet();
    };
    workMap ??= singleFlight(
      createWorkMapReader({
        fleet: sharedFleet,
        projects: () => {
          projects ??= singleFlight(() => readProjects());
          return projects();
        },
      }),
      Date.now,
      10000,
    );
    return workMap();
  });
  handleRead(workMapProjectRpc, (input, { paseo }) => {
    if (authError) throw new Error(authError);
    let read = workMapProjects.get(input.projectId);
    if (!read) {
      if (workMapProjects.size >= 128) workMapProjects.delete(workMapProjects.keys().next().value!);
      const sharedFleet = () => {
        fleet ??= singleFlight(() => readFleet(paseo), Date.now, 10000);
        return fleet();
      };
      const reader = createWorkMapProjectReader({ fleet: sharedFleet, issues });
      read = singleFlight(() => reader({ projectId: input.projectId }), Date.now, 15000);
      workMapProjects.set(input.projectId, read);
    }
    return read();
  });
  handleRead(sessionOwnershipRpc, (input, { paseo }) => {
    if (authError)
      return { ownership: Object.fromEntries((input.agentIds ?? []).map((id) => [id, null])) };
    const read = createSessionOwnershipReader(
      undefined,
      async () => {
        fleet ??= singleFlight(() => readFleet(paseo), Date.now, 10000);
        const f = await fleet();
        return {
          nodes: f.nodes.map((n) => ({
            id: n.id,
            agentId: n.agentId ?? null,
            task: n.task,
            title: n.title,
          })),
          tasks: f.tasks.map((t) => ({ id: t.id, title: t.title })),
        };
      },
      () => {
        projects ??= singleFlight(() => readProjects());
        return projects();
      },
    );
    return read(input);
  });
  // DESIGN-NEXT-BUILD A3.3/A3.4: the Role picker's table, and role defaults for creations labelled with a role. The hook
  // reads installation config only (hooks have no management invocation) and never refuses a creation.
  const sessionDefaults = createSessionDefaultsReader();
  handleRead(sessionDefaultsRpc, () => {
    if (authError) throw new Error(authError);
    return sessionDefaults();
  });
  // Update-7: one agent.create hook: the role's model and effort, then a lead role's orchestration instruction (and the
  // optional subagent guard). Composed here so the order never depends on how the host chains hooks.
  const roleHook = roleDefaultsHook() as any,
    leadHook = orchestrationHook() as any;
  const stopRoleDefaults: unknown =
    typeof server.before === "function"
      ? server.before("agent.create", (async (input: any, context: any) => {
          const withDefaults = (await roleHook(input, context)) ?? input.request;
          return (await leadHook({ request: withDefaults }, context)) ?? withDefaults;
        }) as any)
      : undefined;
  // Update-7: the account pool. Every launch (create, resume, refresh, import) of a pooled provider takes its account's
  // credential for that launch only; no pool leaves the launch exactly as before.
  const poolRoot = () => (loadConfig() as { home: string }).home;
  const stopPool: unknown =
    typeof server.before === "function"
      ? server.before("agent.session_open", sessionOpenHook({ root: poolRoot }) as any)
      : undefined;
  // W1 x W2: a switch continues the running session on the chosen account through the controller's fenced
  // session-takeover (owner/lead-authorised; it writes the assignment and the one history record).
  const accounts = createAccountHandlers({
    root: poolRoot,
    configRoles: () => (loadConfig() as { defaults?: { roles?: unknown } }).defaults?.roles ?? null,
    configModes: () => (loadConfig() as { defaults?: { modes?: unknown } }).defaults?.modes ?? null,
    takeOver: controllerTakeOver(localCall),
    host: () => portable.localHost.name,
  });
  handleRead(accountsRpc, (_input, { paseo }) => {
    if (authError) throw new Error(authError);
    return accounts.read(paseo);
  });
  handle(accountAddRpc, (input) => {
    if (authError) throw new Error(authError);
    return accounts.add(input);
  });
  handle(accountUpdateRpc, (input) => {
    if (authError) throw new Error(authError);
    return accounts.update(input as any);
  });
  handle(poolSettingsRpc, (input, context) => {
    if (authError) throw new Error(authError);
    return accounts.settings(input as any, context.paseo, invocationReadOnly(false, context));
  });
  // W1: "Switch account…" for one session. The switch is a write: owner-initiated from the app, never a read-only device.
  handleRead(sessionAccountsRpc, (input, { paseo }) => {
    if (authError) throw new Error(authError);
    return accounts.session(input as any, paseo);
  });
  handle(accountSwitchRpc, (input, { paseo }) => {
    if (authError) throw new Error(authError);
    return accounts.switch(input as any, paseo);
  });
  handle(accountTakeoverRpc, (input, { paseo }) => {
    if (authError) throw new Error(authError);
    return accounts.takeover(input as any, paseo);
  });
  handleRead(outcomeRpc, (input) => outcomes.snapshot(input));
  handleRead(outcomeArtifactRpc, (input) => outcomes.artifact(input));
  register(
    managementRpc,
    (input: any) =>
      authError
        ? { status: "error", message: authError, observedAt: new Date().toISOString() }
        : manage(input),
    false,
    true,
  );
  // DESIGN-R R2: the recovery surface registers its own RPCs on the server it is handed.
  const recovery = contributeRecovery(server, () => authError, undefined, readDeadlineMs);
  // Cutover A2: the conversation client's writes (9-method allowlist) through this admitted session's management context.
  handle(operatorInvokeRpc, (input) =>
    authError
      ? {
          ok: false as const,
          code: "management_unavailable",
          dispatched: false,
          message: authError,
        }
      : operatorInvoke(input),
  );
  register(
    taskManagementRpc,
    (input: any) =>
      authError
        ? { status: "error", message: authError, observedAt: new Date().toISOString() }
        : taskManage(input),
    false,
    true,
  );
  handleRead(taskCatalogRpc, async (input) => {
    if (authError) throw new Error(authError);
    return taskPage(await catalog(), input.cursor);
  });
  let usage: ReturnType<typeof createUsageReader> | undefined;
  handleRead(usageRpc, (_input, { paseo }) => {
    if (authError) throw new Error(authError);
    usage ??= createUsageReader(paseo);
    return usage();
  });
  // Structural read so this compiles against SDKs with and without ctx.secrets; the plugin and the host ship separately.
  const secrets =
    (server as { secrets?: { read(name: string): Promise<string | null> } }).secrets ?? noSecrets;
  const trackers = createTrackerService({
    controller: localCall,
    connectors: {
      github: createGithubConnector({ fetcher: fetch, secrets, gh: createGhRunner() }),
      jira: createJiraConnector({ fetcher: fetch, secrets }),
      bitbucket: createBitbucketConnector({ fetcher: fetch, secrets }),
    },
  });
  const gated = <T>(run: () => T): T => {
    if (authError) throw new Error(authError);
    return run();
  };
  handleRead(trackersRpc, (input) => gated(() => trackers.read(input)));
  handleRead(trackerDirectoryRpc, () => gated(() => trackers.directory()));
  handleRead(trackerResolveRpc, (input) => gated(() => trackers.resolve(input)));
  handle(trackerMapRpc, (input) => gated(() => trackers.map(input)));
  handle(trackerUnmapRpc, (input) => gated(() => trackers.unmap(input)));
  handle(trackerLinkRpc, (input) => gated(() => trackers.link(input)));
  handle(trackerUnlinkRpc, (input) => gated(() => trackers.unlink(input)));
  // Fulcra J4 connectors (CONTRACTS §2.2, §7). A connector is handed an `http` bound to one account: for a connected
  // account it is the host's `credentials.request` (J5b P1), which adds the authentication itself and reaches only
  // that provider's API base, so the plugin never holds a token; for the opt-in `gh` login it is the gh CLI. A host
  // without the store, or one that has not granted this plugin the connector, degrades to "needs host update P1";
  // the J3 path above keeps working either way.
  const hostCredentials = (
    server as {
      credentials?: {
        request: HostRequest;
        importLegacy(input: {
          secretName: string;
          connector: string;
          site?: string | null;
          email?: string | null;
        }): Promise<{ accountId: string; imported: boolean }>;
      };
    }
  ).credentials;
  const gh = createGhHttp(createGhRunner({ assert: assertTrackerGhArgs }));
  const registry = createRegistry([
    createGithubTracker(),
    createJiraTracker({ id: "jira" }),
    createJiraTracker({ id: "jira-dc" }),
    createBitbucketTracker({ id: "bitbucket" }),
    createBitbucketTracker({ id: "bitbucket-dc" }),
  ]);
  let currentPaseo: any = null;
  const agents = async () =>
    currentPaseo
      ? (await listAgents(currentPaseo, 8000)).entries.map((e: any) => e.agent).filter(Boolean)
      : [];
  const connectors = createConnectorService({
    controller: localCall,
    registry,
    http: (m) =>
      m.accountId === null
        ? m.connector === "github"
          ? gh
          : null
        : hostCredentials?.request
          ? accountHttp({
              request: (accountId, connector, input) =>
                hostCredentials.request(accountId, connector, input),
              accountId: m.accountId,
              connector: m.connector,
            })
          : null,
    importLegacy: hostCredentials ? (input) => hostCredentials.importLegacy(input) : null,
    hostAccounts: async () => {
      const listing = currentPaseo?.credentials ? await currentPaseo.credentials.list() : null;
      return listing
        ? { hostApi: true, accounts: listing.accounts ?? [], providers: listing.providers ?? [] }
        : { hostApi: false, accounts: [], providers: [] };
    },
    names: async () => {
      const [list, tasks] = await Promise.allSettled([agents(), catalog()]);
      return {
        sessions: new Map(
          list.status === "fulfilled" ? list.value.map((a: any) => [a.id, a.title ?? ""]) : [],
        ),
        tasks: new Map(
          tasks.status === "fulfilled" ? tasks.value.tasks.map((t) => [t.id, t.title]) : [],
        ),
      };
    },
    // Commit provenance: the project's member sessions' folders, read with read-only git. Paths are used here
    // only, never stored or returned.
    scan: async (projectId, mappings) => {
      const [directory, rows, hosted] = await Promise.all([
        localCall("trackers-directory"),
        localCall("list"),
        agents().catch(() => []),
      ]);
      const project = directory.projects.find((p: { id: string }) => p.id === projectId);
      if (!project || !Array.isArray(rows)) return null;
      const sessions = rows
        .filter((r: any) => project.tasks.includes(r.task))
        .slice(0, 64)
        .map((r: any) => ({ id: r.id, task: r.task, cwd: r.cwd }));
      const windows = new Map<string, { from: number; to: number }>();
      for (const a of hosted) {
        const from = Date.parse(a.createdAt ?? ""),
          to = ["running", "initializing"].includes(a.status)
            ? Date.now()
            : Date.parse(a.updatedAt ?? a.lastActivityAt ?? "");
        if (Number.isFinite(from) && Number.isFinite(to)) windows.set(a.id, { from, to });
      }
      return scanProject({
        projectId,
        sessions,
        windows,
        mappings,
        registry,
        git: createGitRunner(),
        fs: fsp,
        knownSessions: new Set([...rows.map((r: any) => r.id), ...hosted.map((a: any) => a.id)]),
        knownTasks: new Set([
          ...rows.map((r: any) => r.task),
          ...directory.projects.flatMap((p: { tasks: string[] }) => p.tasks),
        ]),
      });
    },
  });
  const withPaseo = <T>(paseo: unknown, run: () => T): T => {
    currentPaseo = paseo ?? currentPaseo;
    return gated(run);
  };
  handleRead(integrationsRpc, (_input, { paseo }) =>
    withPaseo(paseo, () => connectors.integrations()),
  );
  handleRead(trackerMappingsRpc, (input, { paseo }) =>
    withPaseo(paseo, () => connectors.mappings(input, { persist: false })),
  );
  handleRead(trackerMappingResolveRpc, (input, { paseo }) =>
    withPaseo(paseo, () => connectors.resolve(input)),
  );
  handle(trackerMappingMapRpc, (input, { paseo }) => withPaseo(paseo, () => connectors.map(input)));
  handle(trackerMappingUnmapRpc, (input, { paseo }) =>
    withPaseo(paseo, () => connectors.unmap(input)),
  );
  handleRead(trackerViewRpc, (input, { paseo }) =>
    withPaseo(paseo, () => connectors.view(input, { persist: false })),
  );
  // L36: fetch and store (persist). A write invocation (tracker items are recorded), answered before the host's 30 s limit.
  handle(trackerRefreshRpc, (input, { paseo }) =>
    withPaseo(paseo, () =>
      withDeadline(
        () => connectors.view(input, { persist: true }),
        TRACKER_REFRESH_DEADLINE_MS,
        trackerRefreshRpc.name,
      ),
    ),
  );
  handle(linkSetRpc, (input) => gated(() => connectors.linkSet(input)));
  handle(linkRemoveRpc, (input) => gated(() => connectors.linkRemove(input)));
  handleRead(linksRpc, (input) => gated(() => connectors.links(input)));
  // Fulcra J3 Inbox: decisions, approvals, held messages and the daily digest. The controller decides every
  // rule; a published outcome that still needs a decision is listed read-only, gated like the Outcomes view.
  const inbox = createInbox({
    call: localCall,
    outcomes: outcomeDirectory(OUTCOME_ROOT, readOutcome),
    allowed: allowedOutcome,
  });
  handleRead(inboxRpc, () => gated(() => inbox.inbox()));
  handleRead(decisionRpc, (input) => gated(() => inbox.decision(input)));
  handle(decisionChooseRpc, (input) => gated(() => inbox.choose(input)));
  handle(reviewRecordRpc, (input) => gated(() => inbox.recordReview(input)));
  handleRead(heldMessageRpc, (input) => gated(() => inbox.held(input)));
  handle(heldReadRpc, (input) => gated(() => inbox.heldRead(input)));
  handle(heldReplyRpc, (input) => gated(() => inbox.heldReply(input)));
  handle(heldReleaseRpc, (input) => gated(() => inbox.heldRelease(input)));
  handleRead(digestRpc, (input) => gated(() => inbox.digest(input)));
  // Fulcra J8 Environments (CONTRACTS §6). Read, propose, prepare and cancel. Nothing here runs a promotion.
  const environments = createEnvironments({ call: localCall });
  handleRead(environmentsRpc, (input) => gated(() => environments.view(input)));
  handle(environmentProposeRpc, (input) => gated(() => environments.propose(input)));
  handle(promotionCreateRpc, (input) => gated(() => environments.create(input)));
  handle(promotionCancelRpc, (input) => gated(() => environments.cancel(input)));
  // §3.6 paired devices (v1.6, prime decision S-1): the controller verifies every device signature.
  const devices = createDevices({
    call: localCall,
    hostDevice: (server as { device?: unknown }).device !== undefined,
  });
  handleRead(devicesRpc, () => gated(() => devices.list()));
  handle(devicePairOpenRpc, (input) => gated(() => devices.open(input)));
  handle(devicePairCompleteRpc, (input) => gated(() => devices.complete(input)));
  handle(devicePairApproveRpc, (input) => gated(() => devices.approve(input)));
  handle(deviceRevokeRpc, (input) => gated(() => devices.revoke(input)));
  // J3b channels (CONTRACTS §3.5) and title-only push for "now" items (§3.4), only when the host offers notify.
  const channels = createChannels({ call: localCall });
  handleRead(channelsRpc, () => gated(() => channels.list()));
  handle(channelPairOpenRpc, (input) => gated(() => channels.open(input)));
  handle(channelPauseRpc, (input) => gated(() => channels.pause(input)));
  handle(channelRevokeRpc, (input) => gated(() => channels.revoke(input)));
  const hostNotify = (server as { notify?: (n: { title: string; key: string }) => unknown }).notify;
  const stopPush = authError
    ? () => {}
    : startPush({
        notify: hostNotify ? (n) => hostNotify.call(server, n) : undefined,
        read: () => inbox.inbox(),
      });
  // Fulcra J1 Organisation: remits (which prime owns which project) and project stories. The controller decides
  // every rule; the fleet and project directory are the single-flighted readers above.
  const organisation = (paseo: any) =>
    createOrganisation({
      call: localCall,
      fleet: () => {
        fleet ??= singleFlight(() => readFleet(paseo), Date.now, 10000);
        return fleet();
      },
      projects: () => {
        projects ??= singleFlight(() => readProjects());
        return projects();
      },
    });
  let org: ReturnType<typeof createOrganisation> | undefined;
  const orgFor = (paseo: any) => (org ??= organisation(paseo));
  handleRead(remitsRpc, (_input, { paseo }) => gated(() => orgFor(paseo).remits()));
  handle(remitAssignRpc, (input, { paseo }) => gated(() => orgFor(paseo).assign(input)));
  handle(remitMoveRpc, (input, { paseo }) => gated(() => orgFor(paseo).move(input)));
  handle(remitEndRpc, (input, { paseo }) => gated(() => orgFor(paseo).end(input)));
  handle(projectDomainSetRpc, (input, { paseo }) => gated(() => orgFor(paseo).domainSet(input)));
  handleRead(projectBriefRpc, (input, { paseo }) => gated(() => orgFor(paseo).brief(input)));
  const readers = new Map<string, ReturnType<typeof createSnapshotReader>>();
  handleRead(snapshotRpc, async (input, { paseo }) => {
    if (input.taskId) {
      if (authError) throw new Error(authError);
      if (!(await catalog()).tasks.some((task) => task.id === input.taskId)) {
        const checked = await taskManage({ taskId: input.taskId, command: { action: "list" } });
        if (
          !checked.taskAuthority?.allowed &&
          !checked.sessions?.length &&
          !checked.deliveries?.length
        )
          throw new Error("Task is neither authorized nor retained");
      }
    }
    const key = input.taskId ?? "legacy";
    if (!readers.has(key)) {
      if (readers.size >= 32) readers.delete(readers.keys().next().value!);
      readers.set(
        key,
        createSnapshotReader(async () => {
          const rows = input.taskId ? await localCall("list") : undefined;
          if (rows && (!Array.isArray(rows) || rows.length > 2048))
            throw new Error("Enrollment coverage unavailable");
          const membership = rows
            ? new Set<string>(
                rows.filter((row: any) => row.task === input.taskId).map((row: any) => row.id),
              )
            : undefined;
          return organizationSnapshot(paseo, () => readBoard(undefined, input.taskId), membership);
        }),
      );
    }
    return readers.get(key)!();
  });
  const stopWorkspaceOrganization = contributeWorkspaceOrganization(handle);
  // Non-UI startup signal. A caller using a method this plugin does not register never reaches
  // any handler here, so that mismatch is invisible from inside this tree - printing the exact
  // registered names is the only way it becomes checkable against a caller's literal.
  console.warn(
    `[orca-organization] registered ${registered.length} RPC methods: ${registered.join(", ")}`,
  );
  return () => {
    stopWorkspaceOrganization();
    stopPush();
    recovery();
    if (typeof stopRoleDefaults === "function") stopRoleDefaults();
    if (typeof stopPool === "function") stopPool();
    org = undefined;
    readers.clear();
    workMapProjects.clear();
    workMap = undefined;
    usage = undefined;
    fleet = undefined;
    projects = undefined;
  };
}
