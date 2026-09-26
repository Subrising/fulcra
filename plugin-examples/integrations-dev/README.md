# Integrations developer test

A settings screen that exercises the host plugin APIs end to end. It is a developer test screen,
not the product **Settings › Integrations** UI. The screen runs in the app session, which is where
account management is allowed; the plugin's own server session may only list its declared
connectors. On a host without these APIs every action reports "Update the host".

- **Connect / Reconnect / Disconnect** accounts through `usePaseo().credentials`: token sign-in for
  every connector, and device sign-in for GitHub when the host has a GitHub OAuth client id in
  `config.json` → `integrations.oauthClientIds`.
- **Check** calls a server RPC that makes a host-mediated `server.credentials.request` with the
  account and returns only the provider's status code. The plugin never sees the credential.
- **Send** raises a `server.notify` notification with `urgency: "now"`, which pushes to connected apps.

The manifest declares `requirements.notify` and every connector in `requirements.credentials`.
See [docs/integrations-auth.md](../../docs/integrations-auth.md).
