const NOTIFICATION_PREVIEW_LIMIT = 220;

export type AgentAttentionReason = "finished" | "error" | "permission";

export interface AgentAttentionNotificationData {
  [key: string]: unknown;
  serverId: string;
  workspaceId?: string;
  agentId: string;
  reason: AgentAttentionReason;
}

export interface AgentAttentionNotificationPayload {
  title: string;
  body: string;
  data: AgentAttentionNotificationData;
}

interface BuildAgentAttentionNotificationPayloadInput {
  reason: AgentAttentionReason;
  serverId: string;
  workspaceId: string;
  agentId: string;
  assistantMessage?: string | null;
  agentTitle?: string | null;
  permissionRequest?: NotificationPermissionRequest | null;
}

export interface NotificationPermissionRequest {
  id: string;
  provider: string;
  name: string;
  kind: "tool" | "plan" | "question" | "mode" | "other";
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type AssistantTimelineItem =
  | { type: "assistant_message"; text: string }
  | { type: string; text?: string };

const normalizeNotificationText = (text: string): string => text.replace(/\s+/g, " ").trim();

const truncateNotificationText = (text: string, limit: number): string => {
  if (text.length <= limit) {
    return text;
  }
  const trimmed = text.slice(0, Math.max(0, limit - 3)).trimEnd();
  return trimmed.length > 0 ? `${trimmed}...` : text.slice(0, limit);
};

const stripMarkdownToText = (markdown: string): string => {
  let text = markdown.replace(/\r\n/g, "\n");

  // Strip fenced code markers but keep the code content itself.
  text = text.replace(/^\s*```[^\n]*$/gm, "");
  text = text.replace(/^\s*~~~[^\n]*$/gm, "");

  // Markdown links/images.
  text = text.replace(/!\[([^\]]*)\]\((?:[^()\\]|\\.)*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\((?:[^()\\]|\\.)*\)/g, "$1");

  // Structural prefixes.
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s{0,3}>+\s?/gm, "");
  text = text.replace(/^\s{0,3}(?:[*+-]|\d+\.)\s+/gm, "");
  text = text.replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, "");

  // Inline markdown markers.
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/\*([^*\n]+)\*/g, "$1");
  text = text.replace(/_([^_\n]+)_/g, "$1");
  text = text.replace(/~~([^~]+)~~/g, "$1");

  // Angle-bracketed URL autolinks.
  text = text.replace(/<([^>\n]+)>/g, "$1");

  return text;
};

// Push previews leave the machine. Once a field looks credential-bearing, omit the
// whole field: parsing one value cannot safely bound shell/JSON/YAML quotes, escapes
// or multiline continuations. These detectors are conservative heuristics, not a
// guarantee that arbitrary unlabelled secrets can be identified.
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b[A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|auth|credential|cookie|private[_-]?key)[A-Za-z0-9_.-]*["'`]?\s*[=:]/i,
  /\b[A-Z][A-Z0-9_]{2,}["'`]?\s*=/,
  /--?(?:token|password|passwd|secret|api-?key|auth|key)(?:[=\s])/i,
  /\b(?:authorization|bearer|basic)\b[:\s]+\S+/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@\S+/i,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/,
  /\b(?:gh[opsur]_|github_pat_|xox[abpr]-|AKIA|AIza)[A-Za-z0-9_-]{8,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/,
  /\b[A-Za-z0-9+/_=-]{32,}/,
];

export function redactNotificationSecrets(text: string): string {
  // Inspect common escaped key spellings without decoding the outgoing prose.
  const inspected = text
    .replace(/\\u([a-f0-9]{4})|\\x([a-f0-9]{2})/gi, (_, unicode: string, hex: string) =>
      String.fromCharCode(Number.parseInt(unicode ?? hex, 16)),
    )
    .replace(/\\(["'`\\])/g, "$1")
    .replace(/\\\r?\n/g, "");
  return SECRET_PATTERNS.some((pattern) => pattern.test(inspected)) ? "[redacted]" : text;
}

const buildNotificationPreview = (text: string | null | undefined): string | null => {
  if (!text) {
    return null;
  }

  // Inspect raw text before markdown can erase a credential delimiter or key.
  // Inspect the rendered text too, since markdown can split a key's spelling.
  const normalized = normalizeNotificationText(
    redactNotificationSecrets(stripMarkdownToText(redactNotificationSecrets(text))),
  );
  if (!normalized) {
    return null;
  }

  return truncateNotificationText(normalized, NOTIFICATION_PREVIEW_LIMIT);
};

// A tool permission's title, description and input are built from the raw command and can hold secrets, so the push
// carries only the tool name: a bounded summary, never the command. Question
// fields are checked separately so a safe title survives an omitted description.
const buildPermissionDetails = (
  request: NotificationPermissionRequest | null | undefined,
): string | null => {
  if (!request) {
    return null;
  }
  if (request.kind === "question") {
    const title = buildNotificationPreview(request.title);
    // A description can continue a value introduced in the title.
    if (title === "[redacted]") return title;
    const details = [title, buildNotificationPreview(request.description)].filter(
      (part, index, all): part is string => Boolean(part) && all.indexOf(part) === index,
    );
    if (details.length > 0) return details.join(" - ");
  }
  const name = request.name?.trim();
  return name ? `Wants to use ${name}` : `Needs your approval (${request.kind})`;
};

export function findLatestAssistantMessageFromTimeline(
  timeline: readonly AssistantTimelineItem[],
): string | null {
  // Providers may stream assistant content in consecutive chunks.
  const chunks: string[] = [];
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const item = timeline[i];
    if (item.type !== "assistant_message" || typeof item.text !== "string") {
      if (chunks.length > 0) {
        break;
      }
      continue;
    }
    chunks.push(item.text);
  }

  if (chunks.length === 0) {
    return null;
  }

  return chunks.toReversed().join("");
}

export function findLatestPermissionRequest(
  pendingPermissions: ReadonlyMap<string, NotificationPermissionRequest>,
): NotificationPermissionRequest | null {
  let latest: NotificationPermissionRequest | null = null;
  for (const request of pendingPermissions.values()) {
    latest = request;
  }
  return latest;
}

function resolveAgentAttentionTitle(reason: AgentAttentionReason): string {
  if (reason === "permission") return "Agent needs permission";
  if (reason === "error") return "Agent needs attention";
  return "Agent finished";
}

function resolveAgentAttentionPreview(
  input: BuildAgentAttentionNotificationPayloadInput,
): string | null {
  if (input.reason === "finished") {
    return buildNotificationPreview(input.assistantMessage);
  }
  if (input.reason === "permission") {
    return buildNotificationPreview(buildPermissionDetails(input.permissionRequest));
  }
  return null;
}

function resolveAgentAttentionFallbackBody(reason: AgentAttentionReason): string {
  if (reason === "permission") return "Permission requested.";
  if (reason === "error") return "Encountered an error.";
  return "Finished working.";
}

export function buildAgentAttentionNotificationPayload(
  input: BuildAgentAttentionNotificationPayloadInput,
): AgentAttentionNotificationPayload {
  const sessionTitle = buildNotificationPreview(input.agentTitle);
  const title = sessionTitle
    ? truncateNotificationText(sessionTitle, 80)
    : resolveAgentAttentionTitle(input.reason);
  const preview = resolveAgentAttentionPreview(input);
  const body = preview ?? resolveAgentAttentionFallbackBody(input.reason);

  return {
    title,
    body,
    data: {
      serverId: input.serverId,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      reason: input.reason,
    },
  };
}
