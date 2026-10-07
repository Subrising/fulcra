import type { ConnectionOffer } from "@getpaseo/protocol/connection-offer";
import {
  normalizeHostPort,
  shouldUseTlsForDefaultHostedRelay,
} from "@getpaseo/protocol/daemon-endpoints";
import {
  DirectTcpHostConnectionSchema,
  type DirectTcpHostConnection as WireDirectTcpHostConnection,
} from "@getpaseo/protocol/host-connection-schema";
import {
  DEFAULT_SSH_DAEMON_PORT,
  validatePort,
  validateSshHost,
} from "@getpaseo/protocol/ssh-transport";
import {
  type HostAppearance,
  defaultHostAppearance,
  HostAppearanceSchema,
} from "@/hosts/appearance";
import { z } from "zod";

export { DirectTcpHostConnectionSchema };
export type DirectTcpHostConnection = Omit<WireDirectTcpHostConnection, "password">;

export interface DirectSocketHostConnection {
  id: string;
  type: "directSocket";
  path: string;
}

export interface DirectPipeHostConnection {
  id: string;
  type: "directPipe";
  path: string;
}

export interface RemoteSshHostConnection {
  id: string;
  type: "remoteSsh";
  host: string;
  sshPort?: number;
  daemonPort?: number;
}

export interface RelayHostConnection {
  id: string;
  type: "relay";
  relayEndpoint: string;
  useTls?: boolean;
  daemonPublicKeyB64: string;
  deviceId?: string;
}

export type HostConnection =
  | DirectTcpHostConnection
  | DirectSocketHostConnection
  | DirectPipeHostConnection
  | RemoteSshHostConnection
  | RelayHostConnection;

export type HostLifecycle = Record<string, never>;

export type HostPairingReason = "pairing-upgraded" | "device-removed";

export interface HostProfile {
  pairingRequired?: HostPairingReason;
  serverId: string;
  password?: string;
  label: string;
  appearance: HostAppearance;
  lifecycle: HostLifecycle;
  connections: HostConnection[];
  preferredConnectionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function defaultLifecycle(): HostLifecycle {
  return {};
}

export function normalizeHostLabel(value: string | null | undefined, serverId: string): string {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : serverId;
}

export function orderHostsLocalFirst<T extends { serverId: string }>(
  hosts: T[],
  localServerId: string | null,
): T[] {
  if (!localServerId) {
    return hosts;
  }
  const localIndex = hosts.findIndex((host) => host.serverId === localServerId);
  if (localIndex <= 0) {
    return hosts;
  }
  const ordered = hosts.slice();
  const [local] = ordered.splice(localIndex, 1);
  if (local) {
    ordered.unshift(local);
  }
  return ordered;
}

/**
 * Resolves which host a settings host section should target: the picker
 * selection, else the local daemon, else the first connected host.
 *
 * Only a serverId that names a currently connected host is used. Both the
 * selection and the local daemon can name a host that isn't connected (a stale
 * selection, or a local daemon whose id persists in storage while it's stopped);
 * using one would resolve the section to an unknown id and render "host not found".
 */
export function resolveActiveHostServerId(params: {
  selectedServerId: string | null;
  localServerId: string | null;
  hosts: readonly { serverId: string }[];
  orderedHosts: readonly { serverId: string }[];
}): string | null {
  const { selectedServerId, localServerId, hosts, orderedHosts } = params;
  const connected = (serverId: string | null): string | null =>
    serverId && hosts.some((host) => host.serverId === serverId) ? serverId : null;
  return (
    connected(selectedServerId) ?? connected(localServerId) ?? orderedHosts[0]?.serverId ?? null
  );
}

function hostConnectionEquals(left: HostConnection, right: HostConnection): boolean {
  if (left.type !== right.type || left.id !== right.id) {
    return false;
  }

  if (left.type === "directTcp" && right.type === "directTcp") {
    return left.endpoint === right.endpoint && (left.useTls ?? false) === (right.useTls ?? false);
  }
  if (left.type === "directSocket" && right.type === "directSocket") {
    return left.path === right.path;
  }
  if (left.type === "directPipe" && right.type === "directPipe") {
    return left.path === right.path;
  }
  if (left.type === "remoteSsh" && right.type === "remoteSsh") {
    return remoteSshConnectionEquals(left, right);
  }
  if (left.type === "relay" && right.type === "relay") {
    return (
      left.relayEndpoint === right.relayEndpoint &&
      left.useTls === right.useTls &&
      left.daemonPublicKeyB64 === right.daemonPublicKeyB64 &&
      left.deviceId === right.deviceId
    );
  }

  return false;
}

function remoteSshConnectionEquals(
  left: RemoteSshHostConnection,
  right: RemoteSshHostConnection,
): boolean {
  return (
    left.host === right.host &&
    left.sshPort === right.sshPort &&
    left.daemonPort === right.daemonPort
  );
}

function hostLifecycleEquals(left: HostLifecycle, right: HostLifecycle): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function upsertHostConnectionById(
  connections: HostConnection[],
  connection: HostConnection,
): HostConnection[] {
  const next: HostConnection[] = [];
  let replaced = false;
  for (const existing of connections) {
    if (existing.id !== connection.id) {
      next.push(existing);
      continue;
    }

    if (replaced) continue;
    next.push(connection);
    replaced = true;
  }
  if (!replaced) next.push(connection);
  return next;
}

/**
 * Keeps the previous preferred connection while it still exists; otherwise the new connection.
 * An explicit preferConnection makes the new connection preferred.
 */
function preferredConnectionAfter(
  previous: HostProfile["preferredConnectionId"],
  connections: HostConnection[],
  fallback: string,
  preferFallback?: boolean,
): HostProfile["preferredConnectionId"] {
  if (preferFallback) return fallback;
  return previous && connections.some((connection) => connection.id === previous)
    ? previous
    : fallback;
}

function connectionsDiffer(previous: HostConnection[], next: HostConnection[]): boolean {
  return (
    next.length !== previous.length ||
    next.some((connection, index) => {
      const previousConnection = previous[index];
      return !previousConnection || !hostConnectionEquals(connection, previousConnection);
    })
  );
}

function hasProfileChanged(input: {
  previous: HostProfile;
  pairedRelay: boolean;
  matchingCount: number;
  serverId: string;
  password?: string;
  createdAt: string;
  label: string;
  preferredConnectionId: HostProfile["preferredConnectionId"];
  lifecycle: HostLifecycle;
  connections: HostConnection[];
}): boolean {
  const {
    previous,
    pairedRelay,
    matchingCount,
    serverId,
    password,
    createdAt,
    label,
    preferredConnectionId,
    lifecycle,
    connections,
  } = input;
  return (
    (pairedRelay && Boolean(previous.pairingRequired)) ||
    matchingCount > 1 ||
    previous.serverId !== serverId ||
    createdAt !== previous.createdAt ||
    label !== previous.label ||
    preferredConnectionId !== previous.preferredConnectionId ||
    !hostLifecycleEquals(previous.lifecycle, lifecycle) ||
    (password !== undefined && password !== previous.password) ||
    connectionsDiffer(previous.connections, connections)
  );
}

export function upsertHostConnectionInProfiles(input: {
  profiles: HostProfile[];
  serverId: string;
  label?: string;
  connection: HostConnection;
  password?: string;
  now?: string;
  preferConnection?: boolean;
}): HostProfile[] {
  const serverId = input.serverId.trim();
  if (!serverId) {
    throw new Error("serverId is required");
  }

  const now = input.now ?? new Date().toISOString();
  const password = input.password;
  const normalizedConnection = input.connection;
  const labelTrimmed = input.label?.trim() ?? "";
  const derivedLabel = labelTrimmed || serverId;
  const existing = input.profiles;
  const matchingIndexes = existing.reduce<number[]>((matches, daemon, index) => {
    if (
      daemon.serverId === serverId ||
      daemon.connections.some((existingConnection) =>
        hostConnectionEquals(existingConnection, normalizedConnection),
      )
    ) {
      matches.push(index);
    }
    return matches;
  }, []);

  if (matchingIndexes.length === 0) {
    const profile: HostProfile = {
      serverId,
      ...(password ? { password } : {}),
      label: derivedLabel,
      appearance: defaultHostAppearance(),
      lifecycle: defaultLifecycle(),
      connections: [normalizedConnection],
      preferredConnectionId: normalizedConnection.id,
      createdAt: now,
      updatedAt: now,
    };
    return [...existing, profile];
  }

  const matchedProfiles = matchingIndexes.map((index) => existing[index]);
  const prev = matchedProfiles.find((daemon) => daemon.serverId === serverId) ?? matchedProfiles[0];
  const pairedRelay = input.connection.type === "relay" && Boolean(input.connection.deviceId);
  const nextConnections = upsertHostConnectionById(
    matchedProfiles
      .flatMap((daemon) => daemon.connections)
      .filter((connection) => !pairedRelay || connection.type !== "relay"),
    input.connection,
  );
  const nextLifecycle = prev.lifecycle;
  const nextLabel = prev.label === prev.serverId ? derivedLabel : prev.label;
  const nextPreferredConnectionId = preferredConnectionAfter(
    prev.preferredConnectionId,
    nextConnections,
    input.connection.id,
    input.preferConnection,
  );
  const nextCreatedAt = matchedProfiles.reduce(
    (earliest, daemon) => (daemon.createdAt < earliest ? daemon.createdAt : earliest),
    prev.createdAt,
  );
  const changed = hasProfileChanged({
    previous: prev,
    pairedRelay,
    matchingCount: matchingIndexes.length,
    serverId,
    password,
    createdAt: nextCreatedAt,
    label: nextLabel,
    preferredConnectionId: nextPreferredConnectionId,
    lifecycle: nextLifecycle,
    connections: nextConnections,
  });

  if (!changed) {
    return existing;
  }

  const nextProfile: HostProfile = {
    ...prev,
    ...(pairedRelay ? { pairingRequired: undefined } : {}),
    ...(password ? { password } : {}),
    serverId,
    label: nextLabel,
    lifecycle: nextLifecycle,
    connections: nextConnections,
    preferredConnectionId: nextPreferredConnectionId,
    createdAt: nextCreatedAt,
    updatedAt: now,
  };

  const firstIndex = matchingIndexes[0];
  const matchingIndexSet = new Set(matchingIndexes);
  const next = existing.filter((_daemon, index) => !matchingIndexSet.has(index));
  next.splice(firstIndex, 0, nextProfile);
  return next;
}

export function connectionFromListen(listen: string): HostConnection | null {
  const normalizedListen = listen.trim();
  if (!normalizedListen) {
    return null;
  }

  if (normalizedListen.startsWith("pipe://")) {
    const path = normalizedListen.slice("pipe://".length).trim();
    return path ? { id: `pipe:${path}`, type: "directPipe", path } : null;
  }

  if (normalizedListen.startsWith("unix://")) {
    const path = normalizedListen.slice("unix://".length).trim();
    return path ? { id: `socket:${path}`, type: "directSocket", path } : null;
  }

  if (normalizedListen.startsWith("\\\\.\\pipe\\")) {
    return {
      id: `pipe:${normalizedListen}`,
      type: "directPipe",
      path: normalizedListen,
    };
  }

  if (normalizedListen.startsWith("/")) {
    return {
      id: `socket:${normalizedListen}`,
      type: "directSocket",
      path: normalizedListen,
    };
  }

  try {
    const endpoint = normalizeHostPort(normalizedListen);
    return {
      id: `direct:${endpoint}`,
      type: "directTcp",
      endpoint,
    };
  } catch {
    return null;
  }
}

export function relayConnectionFromOffer(offer: ConnectionOffer): RelayHostConnection {
  // COMPAT(oldRelayOfferTls): added in v0.1.73, remove after 2026-11-10.
  const useTls = offer.relay.useTls ?? shouldUseTlsForDefaultHostedRelay(offer.relay.endpoint);
  const relayEndpoint = normalizeHostPort(offer.relay.endpoint);
  return {
    id: useTls ? `relay:wss:${relayEndpoint}` : `relay:${relayEndpoint}`,
    type: "relay",
    relayEndpoint,
    useTls,
    daemonPublicKeyB64: offer.daemonPublicKeyB64.trim(),
  };
}

export function createRemoteSshHostConnection(input: {
  host: string;
  sshPort?: number;
  daemonPort?: number;
}): RemoteSshHostConnection {
  const host = validateSshHost(input.host);
  const sshPort = input.sshPort === undefined ? undefined : validatePort(input.sshPort, "SSH port");

  const daemonPort =
    input.daemonPort === undefined || input.daemonPort === DEFAULT_SSH_DAEMON_PORT
      ? undefined
      : validatePort(input.daemonPort, "Daemon port");

  const id = [
    "ssh",
    encodeURIComponent(host),
    sshPort === undefined ? "" : String(sshPort),
    daemonPort === undefined ? "" : String(daemonPort),
  ].join(":");

  return {
    id,
    type: "remoteSsh",
    host,
    ...(sshPort !== undefined ? { sshPort } : {}),
    ...(daemonPort !== undefined ? { daemonPort } : {}),
  };
}

const StoredHostConnectionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    id: z.string().optional(),
    type: z.literal("directTcp"),
    endpoint: z.string(),
    useTls: z.boolean().optional(),
    password: z.string().optional(),
  }),
  z.strictObject({
    id: z.string().optional(),
    type: z.literal("directSocket"),
    path: z.string(),
  }),
  z.strictObject({
    id: z.string().optional(),
    type: z.literal("directPipe"),
    path: z.string(),
  }),
  z.strictObject({
    id: z.string().optional(),
    type: z.literal("remoteSsh"),
    host: z.string(),
    sshPort: z.number().optional(),
    daemonPort: z.number().optional(),
  }),
  z.strictObject({
    id: z.string().optional(),
    type: z.literal("relay"),
    relayEndpoint: z.string(),
    useTls: z.boolean().optional(),
    daemonPublicKeyB64: z.string(),
    deviceId: z.string().optional(),
  }),
]);
const StoredHostProfileSchema = z.strictObject({
  pairingRequired: z.enum(["pairing-upgraded", "device-removed"]).optional(),
  serverId: z.string().trim().min(1),
  password: z.string().optional(),
  label: z.string().optional(),
  appearance: HostAppearanceSchema.optional(),
  lifecycle: z.strictObject({}).optional(),
  connections: z.array(StoredHostConnectionSchema).min(1),
  preferredConnectionId: z.string().nullable().optional(),
  createdAt: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
});
export const StoredHostRegistrySchema = z.array(StoredHostProfileSchema);
type StoredHostConnection = z.infer<typeof StoredHostConnectionSchema>;

function normalizeStoredConnection(connection: StoredHostConnection): HostConnection | null {
  if (connection.type === "directTcp") {
    try {
      const endpoint = normalizeHostPort(connection.endpoint);
      const parsed = DirectTcpHostConnectionSchema.parse({
        id: `direct:${endpoint}`,
        type: "directTcp",
        endpoint,
        useTls: connection.useTls,
      });
      return { id: parsed.id, type: parsed.type, endpoint: parsed.endpoint, useTls: parsed.useTls };
    } catch {
      return null;
    }
  }
  if (connection.type === "directSocket") {
    const path = connection.path.trim();
    return path ? { id: `socket:${path}`, type: "directSocket", path } : null;
  }
  if (connection.type === "directPipe") {
    const path = connection.path.trim();
    return path ? { id: `pipe:${path}`, type: "directPipe", path } : null;
  }
  if (connection.type === "remoteSsh") {
    try {
      return createRemoteSshHostConnection({
        host: connection.host,
        ...(connection.sshPort !== undefined ? { sshPort: connection.sshPort } : {}),
        ...(connection.daemonPort !== undefined ? { daemonPort: connection.daemonPort } : {}),
      });
    } catch {
      return null;
    }
  }
  if (connection.type === "relay") {
    try {
      const relayEndpoint = normalizeHostPort(connection.relayEndpoint);
      const daemonPublicKeyB64 = connection.daemonPublicKeyB64.trim();
      if (!daemonPublicKeyB64) return null;
      const useTls = connection.useTls;
      return {
        id: useTls === true ? `relay:wss:${relayEndpoint}` : `relay:${relayEndpoint}`,
        type: "relay",
        relayEndpoint,
        ...(useTls !== undefined ? { useTls } : {}),
        daemonPublicKeyB64,
        ...(connection.deviceId ? { deviceId: connection.deviceId } : {}),
      };
    } catch {
      return null;
    }
  }

  return null;
}

export function normalizeStoredHostProfile(entry: unknown): HostProfile | null {
  const result = StoredHostProfileSchema.safeParse(entry);
  if (!result.success) {
    return null;
  }
  const record = result.data;
  const serverId = record.serverId;
  // COMPAT(connectionPassword): added in v0.9.1, remove after 2027-03-24 once stored direct passwords have migrated.
  const legacyPassword = record.connections.find(
    (connection) => connection.type === "directTcp" && connection.password,
  );
  const password =
    record.password ?? (legacyPassword?.type === "directTcp" ? legacyPassword.password : undefined);

  const connections = record.connections
    .map((connection) => normalizeStoredConnection(connection))
    .filter((connection): connection is HostConnection => connection !== null);
  if (connections.length === 0) {
    return null;
  }

  const now = new Date().toISOString();
  const label = normalizeHostLabel(record.label, serverId);
  const preferredConnectionId =
    record.preferredConnectionId !== null &&
    record.preferredConnectionId !== undefined &&
    connections.some((connection) => connection.id === record.preferredConnectionId)
      ? record.preferredConnectionId
      : (connections[0]?.id ?? null);

  return {
    serverId,
    ...(password ? { password } : {}),
    label,
    ...(record.pairingRequired ? { pairingRequired: record.pairingRequired } : {}),
    appearance: record.appearance ?? defaultHostAppearance(),
    lifecycle: defaultLifecycle(),
    connections,
    preferredConnectionId,
    createdAt: record.createdAt ?? now,
    updatedAt: record.updatedAt ?? now,
  };
}

export function hostHasConnection(host: HostProfile, connection: HostConnection): boolean {
  return host.connections.some((existing) => hostConnectionEquals(existing, connection));
}

export function registryHasConnection(hosts: HostProfile[], connection: HostConnection): boolean {
  return hosts.some((host) => hostHasConnection(host, connection));
}

// Standard secure/plain web ports carry no information in a host display, so
// "relay.example.com:443" reads as "relay.example.com" while "127.0.0.1:6767" keeps its port.
export function formatHostEndpoint(endpoint: string): string {
  return endpoint.replace(/:(?:443|80)$/, "");
}

// The address a connection reaches, for telling hosts apart in the UI. Never returns a
// credential: TCP carries an optional password that is deliberately not read here.
export function describeHostConnection(connection: HostConnection): string | null {
  switch (connection.type) {
    case "directTcp":
      return connection.endpoint ? formatHostEndpoint(connection.endpoint) : null;
    case "relay":
      return connection.relayEndpoint ? formatHostEndpoint(connection.relayEndpoint) : null;
    case "remoteSsh":
      if (!connection.host) return null;
      return connection.daemonPort
        ? `${connection.host}:${connection.daemonPort}`
        : connection.host;
    case "directSocket":
    case "directPipe":
      return connection.path || null;
  }
}

// Two daemons on one machine report the same hostname, so a label alone cannot identify a
// host. Prefer the connection the host actually uses, then any other that has an address.
export function describeHostEndpoint(host: {
  connections: HostConnection[];
  preferredConnectionId?: string | null;
}): string | null {
  const preferred = host.connections.find((entry) => entry.id === host.preferredConnectionId);
  for (const connection of preferred ? [preferred, ...host.connections] : host.connections) {
    const described = describeHostConnection(connection);
    if (described) return described;
  }
  return null;
}
