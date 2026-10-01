# Distribution integration

The product checkout builds this controller with its own protocol, plugin and client SDK at the same revision. No published `@getpaseo/*` dependency is required. Use the product's `scripts/package-command-centre.mjs` through the required build scheduler; `tools/build-portable.mjs` is a retained legacy route pending shipped-path proof.

The trusted in-process contribution owns one child and its epoch. The ordinary plugin receives management only during an authenticated invocation and cannot enable a trusted-claimed ID through its normal plugin API. Service welcome/events/closure come only from the embedding host. Child requests, host management commands and provenance issuance retain separate typed validation.

A crash rejects pending management as uncertain without replay. At most three exponential-backoff restarts are attempted. Recovery requires the observed owned child exit and matching private lock/socket identity. Unknown or replaced files stop recovery. The stable bridge dispatches only while the current child is ready.

The pure command parser and portable config implementation live within the ordinary plugin's allowed shared/server boundaries. Existing controller import paths re-export them so the two halves validate the same data.

This branch still needs the staged bundle acceptance and independent trust-root review before release. Legacy activation/deployment routes remain until the shipped route is proven. No V3b fix-round merge is implied by these changes; merge that base only when the orchestrator authorises it.
