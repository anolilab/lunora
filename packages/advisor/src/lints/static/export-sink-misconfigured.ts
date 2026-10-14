import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * The required config keys per CDC export-sink factory. A sink missing any of
 * these can never deliver a change batch: a custom sink with no `deliver` has no
 * delivery path, a webhook with no `url` would POST to `undefined`, an R2 sink
 * with no `bucket` binding has nowhere to write. `name` anchors the durable
 * per-shard cursor, so every factory requires it.
 */
const REQUIRED_KEYS: Record<string, ReadonlyArray<string>> = {
    defineExportSink: ["name", "deliver"],
    r2Sink: ["bucket", "name"],
    webhookExportSink: ["name", "url"],
};

/**
 * Flags a misconfigured CDC export sink (plan 170) — a `defineExportSink` /
 * `webhookExportSink` / `r2Sink` construction with a required config field
 * missing or set to an empty string.
 *
 * The runtime `defineExportSink` guard throws for a missing `name`/`deliver`, but
 * the built-in `webhookExportSink` / `r2Sink` never validate their `url` /
 * `bucket`, so a webhook sink with no URL or an R2 sink with no bucket binding
 * ships and silently fails to drain — the export tap advances no cursor and the
 * warehouse never sees a row. Catching it at codegen time beats a dead tap in
 * production.
 *
 * A non-literal config (a variable, a spread that could supply the key) is not
 * statically decidable, so those constructions are skipped rather than flagged.
 * Only runs when the codegen feeder supplied evidence (`context.exportSinks`
 * present); a runtime caller flags nothing.
 */
const exportSinkMisconfigured: Lint = {
    categories: ["SCHEMA"],
    description:
        "A CDC export sink (`defineExportSink` / `webhookExportSink` / `r2Sink`) is missing a required config field (a webhook with no `url`, an R2 sink with no `bucket`, or a sink with no `name`/`deliver`). The sink can never deliver a change batch, so the export tap silently drains nothing.",
    facing: "INTERNAL",
    level: "ERROR",
    name: "export_sink_misconfigured",
    remediation:
        "Supply the missing field: a non-empty `url` for `webhookExportSink`, a `bucket` R2 binding for `r2Sink`, or `name` + `deliver` for `defineExportSink`.",
    run: (context) => {
        // No sink evidence supplied → nothing to assert (mirrors the other feeders).
        if (context.exportSinks === undefined) {
            return [];
        }

        const findings = [];

        for (const sink of context.exportSinks) {
            // A non-literal config can't be decided — skip rather than false-alarm.
            if (!sink.analyzable) {
                continue;
            }

            const present = new Set(sink.presentKeys);
            const empty = new Set(sink.emptyKeys);

            for (const key of REQUIRED_KEYS[sink.factory] ?? []) {
                if (present.has(key) && !empty.has(key)) {
                    continue;
                }

                const reason = empty.has(key) ? "is set to an empty string" : "is missing";

                findings.push(
                    emit(exportSinkMisconfigured, {
                        cacheKey: `export_sink_misconfigured:${sink.file}:${sink.line.toString()}:${key}`,
                        detail: `\`${sink.factory}({ … })\` in ${sink.file}:${sink.line.toString()} ${reason} its required \`${key}\` field — the sink can never deliver a change batch, so the export tap drains nothing.`,
                        metadata: { factory: sink.factory, field: key, file: sink.file, line: sink.line },
                    }),
                );
            }
        }

        return findings;
    },
    source: "static",
    title: "Export sink is misconfigured",
};

export default exportSinkMisconfigured;
