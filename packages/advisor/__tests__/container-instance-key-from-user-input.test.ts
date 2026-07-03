import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import type { AdvisorContainerKeyAccess } from "../src/container-key-accesses";
import containerInstanceKeyFromUserInput from "../src/lints/static/container-instance-key-from-user-input";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

describe("container_instance_key_from_user_input", () => {
    it("flags one WARN finding per evidence row with the right cacheKey and detail", () => {
        expect.assertions(4);

        const containerKeyAccesses: AdvisorContainerKeyAccess[] = [
            { exportName: "startJob", file: "jobs", line: 4, method: "get" },
            { exportName: "resumeJob", file: "jobs", line: 9, method: "get" },
        ];
        const findings = containerInstanceKeyFromUserInput.run({ containerKeyAccesses, schema: schema() });

        expect(findings).toHaveLength(2);
        expect(findings[0]).toMatchObject({
            cacheKey: "container_instance_key_from_user_input:jobs:4",
            level: "WARN",
            metadata: { exportName: "startJob", method: "get" },
            name: "container_instance_key_from_user_input",
        });
        expect(findings[0]?.detail).toContain("ctx.containers.*.get");
        expect(findings[1]?.cacheKey).toBe("container_instance_key_from_user_input:jobs:9");
    });

    it("finds nothing when the feeder supplies no container evidence", () => {
        expect.assertions(2);

        expect(containerInstanceKeyFromUserInput.run({ schema: schema() })).toHaveLength(0);
        expect(containerInstanceKeyFromUserInput.run({ containerKeyAccesses: [], schema: schema() })).toHaveLength(0);
    });
});
