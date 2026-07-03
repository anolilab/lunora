import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import ratelimitKeySpoofableOrGlobal from "../src/lints/static/ratelimit-key-spoofable-or-global";
import type { AdvisorRatelimitKeySelector } from "../src/ratelimit-key-selectors";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

const selectors: AdvisorRatelimitKeySelector[] = [
    { callee: "rateLimit", exportName: "sendMessage", file: "chat", limitName: "send", line: 4 },
    { callee: "dbRateLimit", exportName: "requestOtp", file: "auth", limitName: "otp", line: 9 },
];

describe("ratelimit_key_spoofable_or_global", () => {
    it("flags one WARN finding per evidence row with the right cacheKey and detail", () => {
        expect.assertions(4);

        const findings = ratelimitKeySpoofableOrGlobal.run({ ratelimitKeySelectors: selectors, schema: schema() });

        expect(findings).toHaveLength(2);
        expect(findings[0]).toMatchObject({
            cacheKey: "ratelimit_key_spoofable_or_global:chat:4",
            level: "WARN",
            metadata: { callee: "rateLimit", exportName: "sendMessage", file: "chat", limitName: "send", line: 4 },
            name: "ratelimit_key_spoofable_or_global",
        });
        expect(findings[0]?.detail).toContain("rateLimit");
        expect(findings[1]?.cacheKey).toBe("ratelimit_key_spoofable_or_global:auth:9");
    });

    it("finds nothing when the feeder supplies no rate-limit key-selector evidence", () => {
        expect.assertions(2);

        expect(ratelimitKeySpoofableOrGlobal.run({ schema: schema() })).toHaveLength(0);
        expect(ratelimitKeySpoofableOrGlobal.run({ ratelimitKeySelectors: [], schema: schema() })).toHaveLength(0);
    });
});
