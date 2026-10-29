import type { LanguageModel, LanguageModelMiddleware } from "ai";

import type { AiSpan, AiTelemetry, AiTracer } from "./types";
import type { CallOutcome } from "./usage";
import { modelIdOf, recordUsage } from "./usage";

/** How an instrumented stream ended: the usage it reported, and the upstream error if it failed. */
interface StreamSettled {
    error?: unknown;
    failed?: boolean;
    outcome: CallOutcome;
}

const NOOP_SPAN: AiSpan = { setAttribute: () => {}, setAttributes: () => {} };

/** Stands in for an absent `ctx.trace`, so the middleware has one code path. */
const noopTracer: AiTracer = async (_name, function_) => function_(noopTracer, NOOP_SPAN);

/**
 * Middleware that opens an `ai.generate` / `ai.stream` span around every model
 * call and records its token usage and cost — on the span (live trace ring)
 * and as `gen_ai.usage.*` counters (the durable, per-function history Studio's
 * AI usage view reads).
 *
 * A stream's span stays open until the stream finishes, so its duration is the
 * whole generation rather than the time to the first byte. It closes on normal
 * end and on consumer cancellation (with whatever usage arrived by then), and
 * fails with the upstream error when the stream errors.
 */
const usageMiddleware = (modelId: string, { metrics, trace = noopTracer }: AiTelemetry): LanguageModelMiddleware => {
    const attributes = { "gen_ai.operation.name": "chat", "gen_ai.request.model": modelId };

    return {
        wrapGenerate: async ({ doGenerate }) =>
            trace(
                "ai.generate",
                async (_trace, span) => {
                    const result = await doGenerate();

                    recordUsage(modelId, result, span, metrics);

                    return result;
                },
                attributes,
            ),

        wrapStream: async ({ doStream }) => {
            type StreamResult = Awaited<ReturnType<typeof doStream>>;
            type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

            // Re-emits the stream part by part, remembering the `finish` part's
            // usage, and settles once on close, cancel or an upstream error — with
            // whatever usage arrived first. A `TransformStream`'s `flush` never runs
            // on cancel or error, which left the span (and its counters) pending forever.
            const instrument = (result: StreamResult, onSettle: (settled: StreamSettled) => void): StreamResult => {
                const reader = result.stream.getReader();
                let outcome: CallOutcome = {};

                return {
                    ...result,
                    stream: new ReadableStream<StreamPart>({
                        cancel: async (reason) => {
                            onSettle({ outcome });
                            await reader.cancel(reason);
                        },
                        pull: async (controller) => {
                            let next: ReadableStreamReadResult<StreamPart>;

                            try {
                                next = await reader.read();
                            } catch (error) {
                                onSettle({ error, failed: true, outcome });
                                controller.error(error);

                                return;
                            }

                            if (next.done) {
                                onSettle({ outcome });
                                controller.close();

                                return;
                            }

                            if (next.value.type === "finish") {
                                outcome = { providerMetadata: next.value.providerMetadata, usage: next.value.usage };
                            }

                            controller.enqueue(next.value);
                        },
                    }),
                };
            };

            const streamed = Promise.withResolvers<StreamResult>();
            // Settles once: a later resolve on a settled promise is a no-op.
            const finished = Promise.withResolvers<StreamSettled>();

            trace(
                "ai.stream",
                async (_trace, span) => {
                    // A failed dispatch throws here, so the tracer marks the span
                    // errored before the rejection reaches the caller below.
                    streamed.resolve(instrument(await doStream(), finished.resolve));

                    const settled = await finished.promise;

                    // Usage that arrived before a failure is still spend: record it,
                    // then rethrow so the tracer marks the span errored.
                    recordUsage(modelId, settled.outcome, span, metrics);

                    if (settled.failed === true) {
                        throw settled.error;
                    }
                },
                attributes,
            ).catch(streamed.reject);

            return streamed.promise;
        },
    };
};

/**
 * Wrap a resolved language model so every call through it is traced and
 * counted. `requestedId` is the id the caller asked for (e.g.
 * `anthropic/claude-sonnet-5`), which is what spend should be grouped by even
 * when the provider reports a different internal id. Without telemetry — or for
 * a bare model-id string, which has nothing to wrap — the model passes through.
 */
// eslint-disable-next-line sonarjs/function-return-type -- every arm returns LanguageModel; heuristic false-positive on the union
const instrumentModel = (model: LanguageModel, telemetry: AiTelemetry | undefined, requestedId?: string): LanguageModel => {
    if (telemetry === undefined || typeof model === "string") {
        return model;
    }

    const middleware = usageMiddleware(requestedId ?? modelIdOf(model) ?? "unknown", telemetry);
    // `wrapLanguageModel` lives in the `ai` root, which is a ~720 KB barrel: load it on the
    // first call (not at module load) so a Worker that never calls a model never evaluates it.
    let wrapped: Promise<Extract<LanguageModel, { specificationVersion: "v4" }>> | undefined;

    const resolve = async () => {
        wrapped ??= import("ai").then(
            ({ wrapLanguageModel }) => wrapLanguageModel({ middleware, model }) as never,
            (error: unknown) => {
                wrapped = undefined;

                throw error;
            },
        );

        return wrapped;
    };
    const base = model as Extract<LanguageModel, { specificationVersion: "v4" }>;

    return {
        doGenerate: async (options) => resolve().then((m) => m.doGenerate(options)),
        doStream: async (options) => resolve().then((m) => m.doStream(options)),
        modelId: base.modelId,
        provider: base.provider,
        // `wrapLanguageModel` normalises any model to v4, so the delegate reports what it returns.
        specificationVersion: "v4",
        get supportedUrls() {
            return resolve().then((m) => m.supportedUrls);
        },
    };
};

export default instrumentModel;
