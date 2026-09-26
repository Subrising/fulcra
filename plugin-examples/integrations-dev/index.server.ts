import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createCheckAccount, createSendTestNotification } from "./server/checks";
import { checkAccount, sendTestNotification } from "./shared/checks";

export default function contribute(server: PluginServerContext) {
  server.handle(checkAccount, createCheckAccount(server));
  server.handle(sendTestNotification, createSendTestNotification(server));
  return () => {};
}
