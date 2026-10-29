import { describe, expect, it } from "vitest";

import { parseTraceparent } from "../../../shared/otlp";
import { isTraceHeadSampled, resolveTraceSampling } from "../../../shared/sampling";

/**
 * `shared/otlp.ts` and `shared/sampling.ts` are bundler-inlined source rather
 * than a package; these cover the two inputs a deployment hands the trace
 * pipeline from outside — the inbound `traceparent` and the configured rate.
 */

const VALID = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

describe("parseTraceparent", () => {
    it("parses a well-formed lowercase header", () => {
        expect.assertions(1);

        expect(parseTraceparent(VALID)).toStrictEqual({ parentSpanId: "b7ad6b7169203331", sampled: true, traceId: "0af7651916cd43dd8448eb211c80319c" });
    });

    it("rejects an uppercase header, as W3C Trace Context requires", () => {
        expect.assertions(2);

        expect(parseTraceparent(VALID.toUpperCase())).toBeUndefined();
        expect(parseTraceparent("00-0AF7651916CD43DD8448EB211C80319C-b7ad6b7169203331-01")).toBeUndefined();
    });

    it("rejects a header padded with whitespace", () => {
        expect.assertions(2);

        expect(parseTraceparent(` ${VALID} `)).toBeUndefined();
        expect(parseTraceparent(`${VALID}\n`)).toBeUndefined();
    });
});

describe("isTraceHeadSampled with a non-finite rate", () => {
    const ids = ["00000000000000000000000000000001", "ffffffffffffffffffffffffffffffff", "0af7651916cd43dd8448eb211c80319c"];

    it("treats NaN (an unset env var through Number()) as the keep-all default", () => {
        expect.assertions(2);

        expect(ids.map((id) => isTraceHeadSampled(id, Number.NaN))).toStrictEqual([true, true, true]);
        expect(ids.map((id) => resolveTraceSampling({ headRate: Number(undefined) }, id).isTraced)).toStrictEqual([true, true, true]);
    });

    it("still drops everything at an explicit 0", () => {
        expect.assertions(1);

        expect(ids.map((id) => isTraceHeadSampled(id, 0))).toStrictEqual([false, false, false]);
    });
});
