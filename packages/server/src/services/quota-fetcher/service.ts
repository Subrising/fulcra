import type { ProviderUsage } from "../../server/messages.js";

/** Legacy wire projection of the native usage-source registry. Pool admission keeps its own observations. */
export interface ProviderUsageService {
  listUsage(options?: {
    forceRefresh?: boolean;
  }): Promise<{ fetchedAt: string; providers: ProviderUsage[] }>;
  observeUsage(): { fetchedAt: string; providers: ProviderUsage[] };
}
