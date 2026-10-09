import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorUnboundedLoop, LintContext } from "../src";
import { fromServerSchema, STATIC_LINTS } from "../src";
import unboundedLoop from "../src/lints/static/unbounded-loop";

const context = (unboundedLoops?: AdvisorUnboundedLoop[]): LintContext => {
    return { schema: fromServerSchema(defineSchema({ jobs: defineTable({ name: v.string() }) })), unboundedLoops };
};

const DRAIN: AdvisorUnboundedLoop = { file: "jobs", kind: "while", line: 7, scope: { kind: "export", name: "drain" } };

describe("unbounded_loop", () => {
    it("is registered as a static lint", () => {
        expect.assertions(1);

        expect(STATIC_LINTS).toContain(unboundedLoop);
    });

    it("finds nothing without loop evidence", () => {
        expect.assertions(1);

        expect(unboundedLoop.run(context())).toHaveLength(0);
    });

    it("flags an exported handler's infinite loop as an ERROR", () => {
        expect.assertions(1);

        expect(unboundedLoop.run(context([DRAIN]))).toStrictEqual([
            expect.objectContaining({
                cacheKey: "unbounded_loop:jobs:drain:while",
                detail: expect.stringContaining("`while (true)` in `drain` (jobs:7)"),
                level: "ERROR",
                metadata: { exportName: "drain", file: "jobs", line: 7, loop: "while" },
                name: "unbounded_loop",
            }),
        ]);
    });

    it("flags module scope, which runs at import", () => {
        expect.assertions(1);

        expect(unboundedLoop.run(context([{ file: "boot", kind: "for", line: 2, scope: { kind: "module" } }]))).toMatchObject([
            { cacheKey: "unbounded_loop:boot:<module>:for" },
        ]);
    });

    it("flags a helper an export calls, naming its callers", () => {
        expect.assertions(1);

        const [finding] = unboundedLoop.run(context([{ file: "jobs", kind: "do", line: 3, scope: { callers: ["drain"], kind: "helper", name: "pump" } }]));

        expect(finding?.detail).toContain("a helper called by `drain`");
    });

    it("stays quiet for a helper nothing calls", () => {
        expect.assertions(1);

        expect(unboundedLoop.run(context([{ file: "jobs", kind: "while", line: 3, scope: { callers: [], kind: "helper", name: "dead" } }]))).toHaveLength(0);
    });

    it("keeps two loops in one function apart", () => {
        expect.assertions(1);

        expect(unboundedLoop.run(context([DRAIN, { ...DRAIN, line: 12 }])).map((finding) => finding.cacheKey)).toStrictEqual([
            "unbounded_loop:jobs:drain:while",
            "unbounded_loop:jobs:drain:while:2",
        ]);
    });
});
