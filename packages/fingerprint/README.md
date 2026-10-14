# @lunora/fingerprint

Zero-dependency, cross-runtime **error fingerprinting** for Lunora.

One stable grouping hash that collapses noisy errors into **Issues**, shared by
the local Studio (over the bounded request-log readout) and the Lunora Cloud
(over durable OTLP telemetry) — so a local Issue and a cloud Incident are the
same object.

```ts
import { fingerprintError } from "@lunora/fingerprint";

const fp = fingerprintError({
    functionPath: "messages:list",
    message: "User 12345 not found",
    code: "NOT_FOUND", // metadata only — not part of the hash
});
// → { hash: "168d714cba85f1c8", title: "User 12345 not found",
//     culprit: "messages:list", bucket: "user <n> not found", code: "NOT_FOUND" }
```

`fingerprintError` hashes over `functionPath :: bucket(message)` **only**, because
that is the one thing every Lunora error source can agree on: an in-flight
observability event (`{ code, message, status }`) and a persisted request-log row
(`outcome` + `error_message`, no stored code) both fold onto the same hash. The
message bucketer strips per-occurrence noise — URLs, request paths, UUIDs, IPs,
timestamps, hex, long ids, and numbers — so a bot sweep or a per-user id doesn't
explode one bug into thousands of Issues.

For OTLP-sourced telemetry that carries a real stack trace, the stack-aware
`fingerprint` / `fingerprintLog` exports add top-5 user-frame normalization.

## Runtimes

Runs unchanged on the browser (Studio), the Cloudflare Workers (workerd) runtime
(`@lunora/do`, `apps/cloud`), and Node — the fingerprint is computed with a
portable synchronous SHA-256, so no `node:crypto` and no async `crypto.subtle`.

## Attribution

The core algorithm is vendored from Superlog Labs'
[`@superlog/fingerprint`](https://github.com/superloglabs/superlog) (Apache-2.0),
with the Node-only crypto backend replaced by the portable SHA-256. See
[`NOTICE`](./NOTICE).
