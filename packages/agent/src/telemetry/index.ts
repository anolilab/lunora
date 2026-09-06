/**
 * `@lunora/agent/telemetry` — observability integrations for `@lunora/agent`.
 *
 * Every export here produces an ai@7 `Telemetry` object suitable for the
 * `integrations` array of `TelemetryOptions` (`defineAgent({ telemetry: {
 * isEnabled: true, integrations: [...] } })`). `consoleTelemetry` is a
 * zero-dependency structured console tracer; `combineTelemetry` fans the
 * lifecycle out to several integrations and nests their execution wrappers;
 * `sentryTelemetry` / `braintrustTelemetry` are dependency-injected bridges (the
 * app passes its own Sentry namespace / Braintrust logger, so the heavy SDKs are
 * never imported here); and `otlpTelemetry` ships `gen_ai.*` spans over
 * OTLP-over-HTTP to any collector (the Lunora Cloud, or your own), so agent
 * generations land in the same trace store as the rest of the app.
 *
 * All integrations are privacy-safe by default (`recordInputs` / `recordOutputs`
 * both default `false`), so nothing sensitive is recorded without opt-in.
 */
export type { BraintrustLike, BraintrustSpan, BraintrustTelemetryOptions } from "./braintrust";
export { braintrustTelemetry } from "./braintrust";
export { combineTelemetry } from "./combine";
export type { CommonOptions } from "./common";
export type { ConsoleLogger, ConsoleLogLevel, ConsoleTelemetryOptions } from "./console";
export { consoleTelemetry } from "./console";
export type { OtlpTelemetryOptions } from "./otlp";
export { otlpTelemetry } from "./otlp";
export type { SentryLike, SentrySpan, SentryTelemetryOptions } from "./sentry";
export { sentryTelemetry } from "./sentry";
