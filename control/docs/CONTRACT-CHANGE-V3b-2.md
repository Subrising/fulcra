# V3b R1 proof expectation and controller-journal decision

The orchestrator chose controller-side durable revocation for B1: allow outside input only after recording that it ends delegation; do not change the host's human-only sequence semantics or refuse all outside input.

The supplied unchanged proof defines `fenceAdvanced` only as `host.requireSequence(id).humanAt` increasing. With an allowed agent-origin input, it requires this boolean to be true. V1.1 exposes observations read-only and counts only human input. A controller transfer to human mode plus a generation increment cannot change that host counter.

The selected implementation can therefore produce the secure outcome `{injectedReachedProvider:true,fenceAdvanced:false,controllerSendAdmittedAfterInjection:false}` while the proof still fails. Making it pass literally would require changing the host sequence contract, refusing legitimate input contrary to the decision, or falsifying the fixture. None is done.

The original proof is retained byte-for-byte and run without weakened assertions. New real-host tests independently require committed journal revocation before the effect, refusal on transaction/write failure, and refusal of later controller send/permission/MCP refresh. A blockers-only re-check should additionally recognize durable journal mode/generation revocation as the chosen fence. The final report records the original proof's actual result separately; this document is not permission to report it green.

Round 2 disposition: the orchestrator and R-V3B explicitly accepted the human-counter expectation as superseded and closed B1 based on journal revocation. The historical failing execution remains unchanged evidence, rather than being retroactively marked green.
