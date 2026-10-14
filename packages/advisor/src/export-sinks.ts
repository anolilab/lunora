/* eslint-disable no-secrets/no-secrets -- the referenced lint rule id in the doc comment, not a credential */

/**
 * One CDC export-sink construction discovered in a function body — the input the
 * `export_sink_misconfigured` lint consumes. Produced by the codegen feeder,
 * which walks the lunora source for the three sink factories the export tap
 * (plan 170) ships: `defineExportSink({ name, deliver })`,
 * `webhookExportSink({ name, url, … })`, and `r2Sink({ name, bucket, … })`.
 *
 * A sink missing a required field can never deliver a change batch — a webhook
 * with no `url` would POST to `undefined`, an R2 sink with no `bucket` binding has
 * nowhere to write, and a custom sink with no `deliver` has no delivery path. The
 * runtime `defineExportSink` guard throws for a missing `name`/`deliver`, but the
 * built-in `webhookExportSink`/`r2Sink` don't validate `url`/`bucket`, so catching
 * the misconfiguration statically beats a silently-dead export tap at runtime.
 * Runtime callers don't supply this, so the lint finds nothing there.
 */
export interface AdvisorExportSink {
    /**
     * True when the factory's config argument is a statically analyzable object
     * literal. A non-literal config (a variable, a spread) is not decidable, so
     * the lint skips it rather than raising a false alarm.
     */
    analyzable: boolean;
    /** Present keys whose value is an empty-string literal (`""`) — treated as missing. */
    emptyKeys: string[];
    /** Which sink factory was called. */
    factory: "defineExportSink" | "r2Sink" | "webhookExportSink";
    /** Source file the construction appears in (relative to the lunora dir, no extension). */
    file: string;
    /** 1-based line of the factory call, or `0` when unknown. */
    line: number;
    /** Config keys present on the object literal, regardless of value. */
    presentKeys: string[];
}

/* eslint-enable no-secrets/no-secrets -- re-enable after the AdvisorExportSink doc block */
