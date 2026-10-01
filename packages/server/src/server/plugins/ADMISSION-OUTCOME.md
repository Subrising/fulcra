# Host admission refusal outcome

A correlated RPC can carry `code: "admission_refused"` and `nativeDispatched: false` only when the host's admission boundary rejected it before any mutating provider call in that request. The optional field preserves older clients' RPC error shape. The client exposes it on `DaemonRpcError`.

`admissionRequest` owns request-local state. Synchronous admission checks register the actual error object in a private weak map. `nativeDispatch` marks the request before calling a provider, including create/resume, native archive restore, close, configuration, permission, interruption, steer, rewind and start. Once marked, the request cannot produce this outcome. Error names, codes and message text are never evidence. Provider failures, unknown errors and failures after dispatch remain ordinary errors; consumers must treat them as uncertain.

Trusted input-hook diagnostics may accompany a refusal (bounded to 1,024 characters). They explain the decision, but never determine the typed outcome. This does not assert that every refusal is retryable, and it does not replace the Codex quota hook's separate durable, attempt-bound no-dispatch receipt.

`DaemonClient.invokeRawInput` preserves an explicitly supplied request ID. This matters for permission requests, whose semantic ID also binds the admission payload and journal intent. It generates a correlation ID when one is omitted.

The restore regression in `admission-outcome.test.ts` reaches `AgentManager.unarchiveSnapshot`, performs a native restore, then throws from a nested admission check. The outcome remains uncertain because native dispatch already began. This deliberately does not infer no-dispatch from a later refusal.
