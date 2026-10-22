import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema, runAdvisor, STATIC_LINTS } from "../src";
import openShardAccess from "../src/lints/static/open-shard-access";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }).rls("required"));

describe("open_shard_access", () => {
    it("flags one ERROR finding per site, whatever the schema's RLS posture", () => {
        expect.assertions(3);

        const findings = openShardAccess.run({
            openShardAccess: [
                { file: "lunora/app.ts", line: 29 },
                { file: "vite.config.ts", line: 12 },
            ],
            schema: schema(),
        });

        expect(findings).toHaveLength(2);
        expect(findings[0]).toMatchObject({ cacheKey: "open_shard_access:lunora/app.ts:29", level: "ERROR", name: "open_shard_access" });
        expect(findings[0]?.remediation).toContain("authorizeShard");
    });

    it("finds nothing without deploy-supplied evidence, so codegen never raises it", () => {
        expect.assertions(2);

        expect(openShardAccess.run({ schema: schema() })).toHaveLength(0);
        expect(runAdvisor({ schema: schema() }, { lints: STATIC_LINTS }).some((finding) => finding.name === "open_shard_access")).toBe(false);
    });
});
