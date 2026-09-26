import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";

// Proves plugin access from the server side: a host-mediated provider request with the account.
export const checkAccount = defineRpc({
  name: "check-account",
  input: z.object({ accountId: z.string(), connector: z.string() }),
  output: z.object({ connector: z.string(), status: z.number() }),
});

export const sendTestNotification = defineRpc({
  name: "send-test-notification",
  input: z.object({ urgency: z.enum(["now", "today", "fyi"]) }),
  output: z.object({ id: z.string(), duplicate: z.boolean() }),
});
