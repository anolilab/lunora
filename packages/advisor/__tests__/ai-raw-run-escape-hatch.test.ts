import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import type { AdvisorAiRawRun } from "../src/ai-raw-runs";
import aiRawRunEscapeHatch from "../src/lints/static/ai-raw-run-escape-hatch";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

describe("ai_raw_run_escape_hatch", () => {
    it("flags one WARN finding per evidence row with the right cacheKey and detail", () => {
        expect.assertions(4);

        const aiRawRuns: AdvisorAiRawRun[] = [
            { exportName: "infer", file: "chat", line: 4 },
            { exportName: "classify", file: "chat", line: 9 },
        ];
        const findings = aiRawRunEscapeHatch.run({ aiRawRuns, schema: schema() });

        expect(findings).toHaveLength(2);
        expect(findings[0]).toMatchObject({
            cacheKey: "ai_raw_run_escape_hatch:chat:4",
            level: "WARN",
            metadata: { exportName: "infer", file: "chat", line: 4 },
            name: "ai_raw_run_escape_hatch",
        });
        expect(findings[0]?.detail).toContain("ctx.ai.run");
        expect(findings[1]?.cacheKey).toBe("ai_raw_run_escape_hatch:chat:9");
    });

    it("finds nothing when the feeder supplies no ai-raw-run evidence", () => {
        expect.assertions(2);

        expect(aiRawRunEscapeHatch.run({ schema: schema() })).toHaveLength(0);
        expect(aiRawRunEscapeHatch.run({ aiRawRuns: [], schema: schema() })).toHaveLength(0);
    });
});
