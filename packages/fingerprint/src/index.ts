/**
 * `@lunora/fingerprint` — zero-dependency, cross-runtime error fingerprinting.
 *
 * One stable grouping hash that collapses noisy errors into **Issues**, shared by
 * the local Studio (over the bounded request-log readout) and the Cloud (over
 * durable OTLP telemetry) so a local Issue and a cloud Incident are the same
 * object. The core algorithm is vendored from Superlog Labs' `@superlog/fingerprint`
 * (Apache-2.0 — see `NOTICE`); the Node-only crypto backend was swapped for a
 * portable synchronous SHA-256 so it runs unchanged on the browser, the workerd
 * runtime, and Node.
 *
 * Most Lunora callers want `fingerprintError` (the stack-less adapter over
 * `functionPath` + message). The stack-aware `fingerprint` / `fingerprintLog`
 * are for OTLP-sourced telemetry that carries `exception.stacktrace`.
 */
export type { ErrorFingerprint, FingerprintErrorInput } from "./lunora";
export { fingerprintError } from "./lunora";
export { sha256Hex } from "./sha256";
export type { Fingerprint, LogFingerprintInput } from "./superlog";
export { fingerprint, fingerprintLog, messageBucketFor, normalizeMessage, stripNullBytes } from "./superlog";
