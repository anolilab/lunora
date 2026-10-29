import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorContainer } from "../src";
import { fromServerSchema } from "../src";
import containerLongSleepAfter from "../src/lints/static/container-long-sleep-after";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

const base = (overrides: Partial<AdvisorContainer> = {}): AdvisorContainer => {
    return { exportName: "transcoder", ...overrides };
};

describe("container_long_sleep_after", () => {
    it("finds nothing when no containers are supplied (runtime caller)", () => {
        expect.assertions(1);

        expect(containerLongSleepAfter.run({ schema: schema() })).toHaveLength(0);
    });

    it("ignores an omitted sleepAfter (the 10 minute default) and one it cannot read", () => {
        expect.assertions(1);

        const containers = [base(), base({ exportName: "b", sleepAfter: "soon" })];

        expect(containerLongSleepAfter.run({ containers, schema: schema() })).toHaveLength(0);
    });

    it("ignores an idle window of an hour or less, in seconds or in units", () => {
        expect.assertions(1);

        const containers = [base({ sleepAfter: 3600 }), base({ exportName: "b", sleepAfter: "60m" }), base({ exportName: "c", sleepAfter: "5m" })];

        expect(containerLongSleepAfter.run({ containers, schema: schema() })).toHaveLength(0);
    });

    it("flags an idle window longer than an hour", () => {
        expect.assertions(2);

        const findings = containerLongSleepAfter.run({ containers: [base({ sleepAfter: "2h" })], schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "container_long_sleep_after:transcoder",
            level: "WARN",
            metadata: { container: "transcoder", effectiveIdleSeconds: 7200, sleepAfter: "2h" },
            name: "container_long_sleep_after",
        });
    });

    it("flags a numeric sleepAfter given in seconds", () => {
        expect.assertions(1);

        expect(containerLongSleepAfter.run({ containers: [base({ sleepAfter: 86_400 })], schema: schema() })).toHaveLength(1);
    });

    it("clears a long sleepAfter that a shorter hardTimeout caps", () => {
        expect.assertions(2);

        expect(containerLongSleepAfter.run({ containers: [base({ hardTimeout: "30m", sleepAfter: "24h" })], schema: schema() })).toHaveLength(0);
        expect(containerLongSleepAfter.run({ containers: [base({ hardTimeout: "6h", sleepAfter: "24h" })], schema: schema() })).toHaveLength(1);
    });
});
