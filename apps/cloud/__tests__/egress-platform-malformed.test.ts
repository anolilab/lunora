import { describe, expect, it } from "vitest";

import type { EgressPolicy } from "../src/egress/policy";
import { egressOutbound, malformedPlatformVariables, platformEgressOrigins } from "../src/egress/policy";

const enforce: EgressPolicy = { mode: "enforce", origins: [], v: 1 };

describe("malformed platform variables", () => {
    it("counts a configured variable that gives no origin", () => {
        expect(malformedPlatformVariables({ LUNORA_OTLP_ENDPOINT: "not a url" })).toBe(1);
        expect(malformedPlatformVariables({ LUNORA_OTLP_ENDPOINT: "ftp://otlp.example.com" })).toBe(1);
    });

    it("does not count an unset or empty variable, or a valid endpoint with a path", () => {
        expect(malformedPlatformVariables({})).toBe(0);
        expect(malformedPlatformVariables({ LUNORA_OTLP_ENDPOINT: "" })).toBe(0);
        expect(malformedPlatformVariables({ LUNORA_OTLP_ENDPOINT: "https://otlp.example.com/v1/traces" })).toBe(0);
    });

    it("refuses enforcement while one configured platform variable is malformed, even with a valid one", () => {
        const env = { LUNORA_AI_PROXY_URL: "https://ai.example.com/v1", LUNORA_ENVIRONMENT: "production", LUNORA_OTLP_ENDPOINT: "not a url" };

        expect(platformEgressOrigins(env)).toStrictEqual(["https://ai.example.com"]);
        expect(malformedPlatformVariables(env)).toBe(1);
        expect(egressOutbound(enforce, env)).toStrictEqual({ refuse: expect.stringMatching(/not available/) });
    });
});
