/**
 * Vendor presets over {@link otlpSink}. Each one fills in a vendor's OTLP/HTTP
 * endpoint and auth so a caller passes a token instead of hand-assembling headers.
 *
 * A preset returns only the hooks the vendor ingests. `otlpSink` derives the
 * per-signal paths from one base endpoint, and an absent hook never reaches the
 * batcher, so no request is sent for a signal the vendor does not accept.
 */
import type { ObservabilitySink } from "./observability";
import { otlpSink } from "./observability-sinks";

/** Options for {@link axiomMetricsSink}. */
interface AxiomMetricsSinkOptions {
    /** Dataset that receives the metrics. */
    dataset: string;
    /** The Axiom edge domain for your deployment, without a scheme or path. */
    domain: string;
    /** Axiom API token, sent as a Bearer token. */
    token: string;
}

/**
 * Ship `ctx.metrics` measurements to Axiom over OTLP/HTTP.
 *
 * Official source: https://axiom.co/docs/send-data/opentelemetry (fetched; the
 * findings below are paraphrased from the page).
 *
 * - Endpoint: `https://AXIOM_DOMAIN/v1/metrics`. `AXIOM_DOMAIN` is the deployment's
 * edge domain, which the caller supplies as `domain`.
 * - Auth: a Bearer token sent in the `Authorization` header.
 * - Dataset: metrics use the `x-axiom-metrics-dataset` header in place of
 * `x-axiom-dataset`.
 * - Encoding: the page states that `/v1/metrics` accepts Protobuf or JSON
 * (`application/json`). `otlpSink` sends JSON.
 * - Signals: only metrics. The page gives no encoding statement for traces or logs,
 * so this preset implements `onMetric` alone.
 * - Gzip: the page does not mention it. `otlpSink` gzips bodies above its size
 * threshold.
 * @param options The token, the metrics dataset and the Axiom domain.
 */
const axiomMetricsSink = (options: AxiomMetricsSinkOptions): ObservabilitySink => {
    const sink = otlpSink({
        endpoint: `https://${options.domain}`,
        headers: { "x-axiom-metrics-dataset": options.dataset },
        token: options.token,
    });

    return { flush: sink.flush, onMetric: sink.onMetric };
};

export type { AxiomMetricsSinkOptions };
export { axiomMetricsSink };
