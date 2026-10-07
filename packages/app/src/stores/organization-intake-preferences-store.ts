import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { bindIntakeSource } from "@/plugins/workspace-organization-model";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
const serverId = z.string().regex(/^srv_[A-Za-z0-9_-]{8,64}$/);
const persisted = z
  .object({
    companyHost: serverId.nullable(),
    requestSources: z.record(z.string().uuid(), serverId),
  })
  .strict();
interface IntakePreferences {
  companyHost: string | null;
  requestSources: Record<string, string>;
  hydrated: boolean;
  hydrationError: string | null;
  chooseCompany(serverId: string): void;
  bindRequest(intakeId: string, serverId: string): void;
  setHydrated(value: boolean): void;
}
export const useOrganizationIntakePreferences = create<IntakePreferences>()(
  persist(
    (set, get) => ({
      companyHost: null,
      requestSources: {},
      hydrated: false,
      hydrationError: null,
      setHydrated: (hydrated) => set({ hydrated }),
      chooseCompany: (companyHost) => {
        serverId.parse(companyHost);
        set({ companyHost });
      },
      bindRequest: (intakeId, companyHost) => {
        z.string().uuid().parse(intakeId);
        serverId.parse(companyHost);
        set({
          companyHost,
          requestSources: bindIntakeSource(get().requestSources, intakeId, companyHost),
        });
      },
    }),
    {
      name: "fulcra-organization-intake-preferences",
      storage: createValidatedPersistStorage(AsyncStorage, persisted),
      partialize: ({ companyHost, requestSources }) => ({ companyHost, requestSources }),
      onRehydrateStorage: () => (state, error) => {
        if (state) state.setHydrated(true);
        if (error)
          useOrganizationIntakePreferences.setState({
            hydrated: true,
            hydrationError:
              "Your saved company intake could not be read. Retry before choosing another destination.",
          });
        else useOrganizationIntakePreferences.setState({ hydrationError: null });
      },
    },
  ),
);
