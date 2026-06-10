import { defineSchema, defineTable } from "@cirrus/server";
import { v } from "@cirrus/values";
import { describe, expect, it } from "vitest";

import type { AdvisorAuthApiCall } from "../src";
import { fromServerSchema } from "../src";
import authApiCallWithoutHeaders from "../src/lints/static/auth-api-call-without-headers";

const schema = () =>
    fromServerSchema(
        defineSchema({
            users: defineTable({ name: v.string() }),
        }),
    );

const run = (authApiCalls?: AdvisorAuthApiCall[]) => authApiCallWithoutHeaders.run({ authApiCalls, schema: schema() });

describe("auth_api_call_without_headers", () => {
    it("finds nothing when no authApi call evidence is supplied (runtime caller)", () => {
        // A runtime caller (no codegen feeder) must not flag anything.
        expect(run()).toHaveLength(0);
    });

    it("flags a call with hasHeaders: false", () => {
        const calls: AdvisorAuthApiCall[] = [
            { exportName: "createOrg", file: "orgs", hasHeaders: false, line: 10, method: "createOrganization" },
        ];
        const findings = run(calls);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "auth_api_call_without_headers:orgs:10:createOrganization",
            categories: ["SECURITY"],
            level: "WARN",
            metadata: { exportName: "createOrg", file: "orgs", line: 10, method: "createOrganization" },
            name: "auth_api_call_without_headers",
        });
    });

    it("does not flag a call with hasHeaders: true", () => {
        const calls: AdvisorAuthApiCall[] = [
            { exportName: "createOrg", file: "orgs", hasHeaders: true, line: 10, method: "createOrganization" },
        ];

        expect(run(calls)).toHaveLength(0);
    });

    it("produces two findings with distinct cacheKeys for two violating calls", () => {
        const calls: AdvisorAuthApiCall[] = [
            { exportName: "banSomeone", file: "admin", hasHeaders: false, line: 5, method: "banUser" },
            { exportName: "promoteUser", file: "admin", hasHeaders: false, line: 20, method: "setRole" },
        ];
        const findings = run(calls);

        expect(findings).toHaveLength(2);
        expect(findings[0]!.cacheKey).toBe("auth_api_call_without_headers:admin:5:banUser");
        expect(findings[1]!.cacheKey).toBe("auth_api_call_without_headers:admin:20:setRole");
    });
});
