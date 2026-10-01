import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageDetail,
  ProviderUsageListResponseMessage,
  ProviderUsageStatus,
  ProviderUsageTone,
  ProviderUsageWindow,
} from "@getpaseo/protocol/messages";

export type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageDetail,
  ProviderUsageStatus,
  ProviderUsageTone,
  ProviderUsageWindow,
};

export type ProviderUsageBalanceUnit = ProviderUsageBalance["unit"];
export type ProviderUsageListPayload = ProviderUsageListResponseMessage["payload"];
export type AccountUsageRow = NonNullable<ProviderUsageListPayload["accounts"]>[number];

export type ProviderUsageView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; payload: ProviderUsageListPayload; isRefreshing: boolean };
