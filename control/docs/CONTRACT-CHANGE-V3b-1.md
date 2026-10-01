# V3b dispatch integration: Phase A2 resolution

The Phase A draft recorded two blockers on product 437891fc4: no supported provenance-bearing client input method, and no typed host no-dispatch refusal. `NEXT-V3B.md` resolves the transport/packaging decisions: V4 uses the in-tree SDK from the same product commit, and V1.1b 81947cde3 supplies public `DaemonClient.invokeRawInput` plus the private controller channel.

The companion `cc/v02-host-refusal` change adds a request-local, host-generated RPC outcome for actual pre-provider admission refusal. The controller consumes only the complete typed outcome. Provider text never classifies a refusal. Permission invocation preserves its semantic request ID.

Phase B exports the pure method/input parser, repeats it in the child dispatcher, and uses fresh `ctx.management` in plugin mutations. See [controller-host-integration.md](controller-host-integration.md) for the integration contract and remaining V4 packaging/supervision work. Historical Phase A failures remain in the task report and evidence; later results supersede them only when actually verified.
