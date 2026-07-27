import { describe, expect, it } from "vitest";

import type { SpanEvent } from "../../../shared/span-event";
import { otlpSpanBody } from "../src/otlp-export";

/** One OTLP `KeyValue`, as `otlpSpanBody` encodes them. */
type OtlpKeyValue = { key: string; value: { boolValue: boolean } | { doubleValue: number } | { intValue: string } | { stringValue: string } };

/** Pull the single span's attribute list out of an `otlpSpanBody` export body. */
const spanAttributes = (body: unknown): OtlpKeyValue[] => {
    const parsed = body as { resourceSpans: { scopeSpans: { spans: { attributes: OtlpKeyValue[] }[] }[] }[] };

    return parsed.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes;
};

const attrValue = (attributes: OtlpKeyValue[], key: string): OtlpKeyValue["value"] | undefined => attributes.find((entry) => entry.key === key)?.value;

/**
 * Proves the framework's `gen_ai.evaluation.*` emission survives OTLP encoding
 * exactly as the cloud OTLP decoder expects. A `SpanHandle.recordEvaluation` call
 * lands the pair on the recorded `SpanEvent.attributes` (see `@lunora/do`'s
 * `context-telemetry` tests); this checks the last hop — that `otlpSpanBody` ships
 * those keys verbatim on the generation span rather than mangling or dropping them.
 */
describe("otlpSpanBody — gen_ai.evaluation attributes", () => {
    const generationSpan = (attributes: SpanEvent["attributes"]): SpanEvent => ({
        attributes,
        durationMs: 12,
        functionPath: "chat:complete",
        name: "chat gpt-4o-mini",
        ok: true,
        parentSpanId: "1111111111111111",
        shardKey: undefined,
        spanId: "2222222222222222",
        startTs: 1_700_000_000_000,
        traceId: "33333333333333333333333333333333",
        userId: undefined,
    });

    it("encodes gen_ai.evaluation.<name>.score as a number and .label as a string", () => {
        expect.assertions(2);

        const body = otlpSpanBody(
            generationSpan({
                "gen_ai.evaluation.exact-match.label": "pass",
                "gen_ai.evaluation.exact-match.score": 1,
                "gen_ai.request.model": "gpt-4o-mini",
            }),
            "lunora",
        );
        const attributes = spanAttributes(body);

        // `1` is a safe integer → proto3-JSON `intValue` (decimal string); the decoder reads it back as the numeric score.
        expect(attrValue(attributes, "gen_ai.evaluation.exact-match.score")).toStrictEqual({ intValue: "1" });
        expect(attrValue(attributes, "gen_ai.evaluation.exact-match.label")).toStrictEqual({ stringValue: "pass" });
    });

    it("encodes a fractional score as a doubleValue", () => {
        expect.assertions(1);

        const body = otlpSpanBody(generationSpan({ "gen_ai.evaluation.keyword-coverage.score": 0.8 }), "lunora");

        expect(attrValue(spanAttributes(body), "gen_ai.evaluation.keyword-coverage.score")).toStrictEqual({ doubleValue: 0.8 });
    });
});
