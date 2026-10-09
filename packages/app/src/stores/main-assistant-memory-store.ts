import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

// Fulcra 0.2.8: the last main assistant each computer reported, so the sidebar can still show
// "Main assistant · Mac mini · offline" while that computer is away, also after an app restart.
// Only the seat name and the chat ID are kept.
const serverId = z.string().regex(/^srv_[A-Za-z0-9_-]{8,64}$/);
const remembered = z
  .object({ seat: z.string().min(1).max(64), sessionId: z.string().uuid() })
  .strict();
const persisted = z.object({ byHost: z.record(serverId, remembered) }).strict();
export type RememberedMainAssistant = z.infer<typeof remembered>;

interface MainAssistantMemory {
  byHost: Record<string, RememberedMainAssistant>;
  remember(serverId: string, value: RememberedMainAssistant): void;
  forget(serverId: string): void;
}

export const useMainAssistantMemory = create<MainAssistantMemory>()(
  persist(
    (set, get) => ({
      byHost: {},
      remember: (host, value) => {
        if (!serverId.safeParse(host).success || !remembered.safeParse(value).success) return;
        const current = get().byHost[host];
        if (current?.seat === value.seat && current.sessionId === value.sessionId) return;
        set({ byHost: { ...get().byHost, [host]: value } });
      },
      forget: (host) => {
        if (!(host in get().byHost)) return;
        const { [host]: _removed, ...rest } = get().byHost;
        set({ byHost: rest });
      },
    }),
    {
      name: "fulcra-main-assistant-memory",
      storage: createValidatedPersistStorage(AsyncStorage, persisted),
      partialize: ({ byHost }) => ({ byHost }),
    },
  ),
);
