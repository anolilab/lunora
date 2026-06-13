import { defineSchema, defineTable } from "@cirrus/server";
import { v } from "@cirrus/values";
import { describe, expect, it } from "vitest";

import type { AdvisorContainer } from "../src";
import { fromServerSchema } from "../src";
import containerOversizedInstance from "../src/lints/static/container-oversized-instance";
import containerPublicInternet from "../src/lints/static/container-public-internet";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

const base = (overrides: Partial<AdvisorContainer> = {}): AdvisorContainer => {
    return { exportName: "transcoder", ...overrides };
};

describe("container_oversized_instance", () => {
    it("finds nothing when no containers are supplied (runtime caller)", () => {
        expect.assertions(1);
        expect(containerOversizedInstance.run({ schema: schema() })).toHaveLength(0);
    });

    it("ignores small named instance types", () => {
        expect.assertions(1);

        const containers = [base({ instanceType: "lite" }), base({ exportName: "b", instanceType: "standard-1" })];

        expect(containerOversizedInstance.run({ containers, schema: schema() })).toHaveLength(0);
    });

    it("flags standard-3 / standard-4", () => {
        expect.assertions(2);

        const findings = containerOversizedInstance.run({ containers: [base({ instanceType: "standard-4" })], schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "container_oversized_instance:transcoder",
            level: "INFO",
            metadata: { container: "transcoder", instanceType: "standard-4" },
            name: "container_oversized_instance",
        });
    });

    it("flags a large custom instance (over the vcpu/memory thresholds)", () => {
        expect.assertions(2);
        expect(containerOversizedInstance.run({ containers: [base({ instanceType: { vcpu: 4 } })], schema: schema() })).toHaveLength(1);
        expect(containerOversizedInstance.run({ containers: [base({ instanceType: { memoryMib: 8192 } })], schema: schema() })).toHaveLength(1);
    });

    it("ignores a small custom instance", () => {
        expect.assertions(1);
        expect(containerOversizedInstance.run({ containers: [base({ instanceType: { memoryMib: 4096, vcpu: 1 } })], schema: schema() })).toHaveLength(0);
    });
});

describe("container_public_internet", () => {
    it("flags a container that does not set enableInternet", () => {
        expect.assertions(2);

        const findings = containerPublicInternet.run({ containers: [base()], schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "container_public_internet:transcoder",
            categories: ["SECURITY"],
            level: "INFO",
            name: "container_public_internet",
        });
    });

    it("stays silent when enableInternet is set explicitly (either value)", () => {
        expect.assertions(1);

        const containers = [base({ enableInternet: false }), base({ enableInternet: true, exportName: "b" })];

        expect(containerPublicInternet.run({ containers, schema: schema() })).toHaveLength(0);
    });
});
