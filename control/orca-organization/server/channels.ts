// Fulcra J3b channels, server side: typed views over the controller's operator methods (src/control/inbox-channels.mjs),
// plus the push hook (CONTRACTS §3.4 [D4]). The push is the title only, for urgency "now" items, and only when the
// host provides a notify API (J5b, P1). Without one nothing polls and nothing is sent: it degrades silently.
import {
  channelsRpc,
  channelPairOpenRpc,
  channelPauseRpc,
  channelRevokeRpc,
  channel,
} from "../shared/cc/channels";
import type { ContractInput, ContractOutput } from "../shared/rpc-contract";
type Call = (method: string, input?: unknown) => Promise<any>;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);
export function createChannels({
  call,
  now = () => new Date().toISOString(),
}: {
  call: Call;
  now?: () => string;
}) {
  let last: ContractOutput<typeof channelsRpc> | null = null;
  return {
    async list(): Promise<ContractOutput<typeof channelsRpc>> {
      try {
        const r = await call("cc-channels-list", null);
        last = channelsRpc.output.parse({
          version: 1,
          observedAt: r.observedAt,
          stale: false,
          error: null,
          channels: r.channels,
        });
        return last;
      } catch (e) {
        return last
          ? { ...last, stale: true, error: message(e) }
          : { version: 1, observedAt: now(), stale: true, error: message(e), channels: [] };
      }
    },
    async open(
      input: ContractInput<typeof channelPairOpenRpc>,
    ): Promise<ContractOutput<typeof channelPairOpenRpc>> {
      const observedAt = now();
      try {
        const r = await call("cc-channel-pair-open", input);
        return {
          ok: true,
          message: r.note ?? null,
          observedAt,
          windowId: r.windowId,
          code: r.code,
          expiresAt: r.expiresAt,
          pairedBy: r.pairedBy,
        };
      } catch (e) {
        return {
          ok: false,
          message: message(e),
          observedAt,
          windowId: null,
          code: null,
          expiresAt: null,
          pairedBy: null,
        };
      }
    },
    async pause(
      input: ContractInput<typeof channelPauseRpc>,
    ): Promise<ContractOutput<typeof channelPauseRpc>> {
      const observedAt = now();
      try {
        const r = await call(input.paused ? "cc-channel-pause" : "cc-channel-resume", {
          id: input.id,
          expectedRevision: input.expectedRevision,
        });
        return { ok: true, message: null, observedAt, channel: channel.parse(r.channel) };
      } catch (e) {
        return { ok: false, message: message(e), observedAt, channel: null };
      }
    },
    async revoke(
      input: ContractInput<typeof channelRevokeRpc>,
    ): Promise<ContractOutput<typeof channelRevokeRpc>> {
      const observedAt = now();
      try {
        const r = await call("cc-channel-revoke", input);
        return { ok: true, message: null, observedAt, channel: channel.parse(r.channel) };
      } catch (e) {
        return { ok: false, message: message(e), observedAt, channel: null };
      }
    },
  };
}
type Notify = (n: { title: string; key: string }) => unknown;
// Title-only push for new "now" items. `notify` is the host's API when it exists; returns a stop function.
export function startPush({
  notify,
  read,
  everyMs = 60000,
}: {
  notify: Notify | undefined;
  read: () => Promise<{ items: { key: string; urgency: string; title: string }[]; stale: boolean }>;
  everyMs?: number;
}) {
  if (typeof notify !== "function") return () => {};
  const seen = new Set<string>();
  let first = true;
  const tick = async () => {
    try {
      const inbox = await read();
      if (inbox.stale) return;
      for (const item of inbox.items) {
        if (item.urgency !== "now" || seen.has(item.key)) continue;
        seen.add(item.key);
        // The first read only learns what is already there: a restart must not re-push the whole inbox.
        if (!first) await notify({ title: item.title, key: item.key });
      }
      first = false;
    } catch {
      /* the next tick tries again; a push is never retried into a flood */
    }
  };
  void tick();
  const timer = setInterval(() => {
    void tick();
  }, everyMs);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
