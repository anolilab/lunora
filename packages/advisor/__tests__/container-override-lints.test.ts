import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import type { AdvisorContainerOverride } from "../src/container-overrides";
import containerRuntimeEgressRelaxation from "../src/lints/static/container-runtime-egress-relaxation";
import containerStartEnableInternetOverride from "../src/lints/static/container-start-enable-internet-override";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

const containerOverrides: AdvisorContainerOverride[] = [
    { detail: "enableInternet: true", exportName: "boot", file: "launch", kind: "enable_internet", line: 3 },
    { detail: "allow", exportName: "openUp", file: "egress", kind: "egress_relaxation", line: 5 },
];

describe("container_start_enable_internet_override", () => {
    it("flags only the enable_internet row, ignoring the egress_relaxation row", () => {
        expect.assertions(3);

        const findings = containerStartEnableInternetOverride.run({ containerOverrides, schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "container_start_enable_internet_override:launch:3",
            level: "WARN",
            metadata: { exportName: "boot", file: "launch", line: 3 },
            name: "container_start_enable_internet_override",
        });
        expect(findings[0]?.detail).toContain("enableInternet: true");
    });

    it("returns [] when context.containerOverrides is undefined", () => {
        expect.assertions(1);

        expect(containerStartEnableInternetOverride.run({ schema: schema() })).toHaveLength(0);
    });
});

describe("container_runtime_egress_relaxation", () => {
    it("flags only the egress_relaxation row, ignoring the enable_internet row", () => {
        expect.assertions(3);

        const findings = containerRuntimeEgressRelaxation.run({ containerOverrides, schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "container_runtime_egress_relaxation:egress:5",
            level: "WARN",
            metadata: { exportName: "openUp", file: "egress", line: 5, method: "allow" },
            name: "container_runtime_egress_relaxation",
        });
        expect(findings[0]?.detail).toContain("egress.allow");
    });

    it("returns [] when context.containerOverrides is undefined", () => {
        expect.assertions(1);

        expect(containerRuntimeEgressRelaxation.run({ schema: schema() })).toHaveLength(0);
    });
});
