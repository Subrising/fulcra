import { z } from "zod";

export const MAX_RECEIPT_LIFETIME_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
export const ReceiptRetentionMsSchema = z
  .number()
  .int()
  .gt(MAX_RECEIPT_LIFETIME_MS)
  .max(Number.MAX_SAFE_INTEGER);
