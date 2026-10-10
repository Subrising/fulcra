import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

// Fulcra 0.2.14 (FU-50): the project leads each other computer last reported, so the sidebar can still show them,
// greyed, while that computer is offline or its Fulcra needs an update, also after an app restart. Only the seat name,
// the chat ID and two names are kept.
const serverId = z.string().regex(/^srv_[A-Za-z0-9_-]{8,64}$/);
const remembered = z
  .object({
    seat: z.string().min(1).max(64),
    sessionId: z.string().uuid(),
    project: z.string().min(1).max(200),
    title: z.string().min(1).max(200),
  })
  .strict();
const MAX_PER_HOST = 50;
const persisted = z
  .object({ byHost: z.record(serverId, z.array(remembered).max(MAX_PER_HOST)) })
  .strict();
export type RememberedLead = z.infer<typeof remembered>;

interface LeadsMemory {
  byHost: Record<string, RememberedLead[]>;
  /** Replaces what is known for that computer; an empty list forgets it. */
  remember(serverId: string, leads: readonly RememberedLead[]): void;
  forget(serverId: string): void;
}

const same = (a: readonly RememberedLead[], b: readonly RememberedLead[]) =>
  a.length === b.length && JSON.stringify(a) === JSON.stringify(b);

export const useLeadsMemory = create<LeadsMemory>()(
  persist(
    (set, get) => ({
      byHost: {},
      remember: (host, leads) => {
        if (!serverId.safeParse(host).success) return;
        const valid = leads.filter((lead) => remembered.safeParse(lead).success);
        const next = valid.slice(0, MAX_PER_HOST);
        const current = get().byHost[host] ?? [];
        if (same(current, next)) return;
        if (next.length === 0) return get().forget(host);
        set({ byHost: { ...get().byHost, [host]: next } });
      },
      forget: (host) => {
        if (!(host in get().byHost)) return;
        const { [host]: _removed, ...rest } = get().byHost;
        set({ byHost: rest });
      },
    }),
    {
      name: "fulcra-leads-memory",
      storage: createValidatedPersistStorage(AsyncStorage, persisted),
      partialize: ({ byHost }) => ({ byHost }),
    },
  ),
);
