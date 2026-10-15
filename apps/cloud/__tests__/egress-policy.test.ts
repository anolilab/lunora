import { describe, expect, it } from "vitest";

import type { EgressOutbound, EgressPolicy } from "../src/egress/policy";
import {
    egressOutbound,
    MAX_HOST_NAME_LENGTH,
    MAX_USER_EGRESS_ORIGINS,
    MAX_WIRE_EGRESS_ORIGINS,
    parseEgressOrigin,
    parseEgressParameter,
    PLATFORM_ORIGIN_RESERVE,
    PLATFORM_VARIABLE_COUNT,
    platformEgressOrigins,
    validateEgressPolicy,
} from "../src/egress/policy";
import { userOrigins } from "./_helpers/egress";

/**
 * The egress policy value (plan 477 §4.2–4.3). These are pure rules: an origin is
 * exact, https by default, and carries nothing but scheme, host and port.
 */

/** The wire parameter of a decision, or `undefined` when there is none (a refusal, or nothing to send). */
const parameterOf = (outbound: EgressOutbound): string | undefined => ("parameter" in outbound ? outbound.parameter : undefined);

describe(parseEgressOrigin, () => {
    it("accepts an https origin and normalises case and the default port", () => {
        expect(parseEgressOrigin("https://API.Example.com:443")).toStrictEqual({ ok: true, origin: "https://api.example.com" });
    });

    it("keeps a non-default port", () => {
        expect(parseEgressOrigin("https://api.example.com:8443")).toStrictEqual({ ok: true, origin: "https://api.example.com:8443" });
    });

    it("accepts a trailing slash, which is not a path", () => {
        expect(parseEgressOrigin("https://api.example.com/")).toStrictEqual({ ok: true, origin: "https://api.example.com" });
    });

    it("accepts http only because it is listed, so the value is kept", () => {
        expect(parseEgressOrigin("http://localhost:8787")).toStrictEqual({ ok: true, origin: "http://localhost:8787" });
    });

    it.each([
        ["a path", "https://api.example.com/v1/charges"],
        ["a query", "https://api.example.com?x=1"],
        ["a fragment", "https://api.example.com#top"],
        ["userinfo", "https://user:pass@api.example.com"], // secret-scanner:allow -- a test fixture literal, not a credential.
        ["a wildcard host", "https://*.example.com"],
        ["a non-http scheme", "ftp://api.example.com"],
        ["a websocket scheme", "wss://api.example.com"],
        ["not a URL", "api.example.com"],
    ])("rejects %s", (_label, raw) => {
        expect(parseEgressOrigin(raw).ok).toBe(false);
    });
});

describe(validateEgressPolicy, () => {
    it("accepts a valid policy and normalises and dedupes its origins", () => {
        expect(validateEgressPolicy({ mode: "enforce", origins: ["https://A.example.com", "https://a.example.com:443/"], v: 1 })).toStrictEqual({
            ok: true,
            policy: { mode: "enforce", origins: ["https://a.example.com"], v: 1 },
        });
    });

    it.each([
        ["an unknown version", { mode: "enforce", origins: [], v: 2 }],
        ["an unknown mode", { mode: "deny", origins: [], v: 1 }],
        ["origins that are not an array", { mode: "enforce", origins: "https://a.example.com", v: 1 }],
        ["a non-string origin", { mode: "enforce", origins: [42], v: 1 }],
        ["an invalid origin entry", { mode: "enforce", origins: ["https://a.example.com/path"], v: 1 }],
        ["a non-object", "enforce"],
    ])("rejects %s", (_label, value) => {
        expect(validateEgressPolicy(value).ok).toBe(false);
    });
});

describe("egressOutbound (off yields no parameter)", () => {
    const platform = { LUNORA_OTLP_ENDPOINT: "https://otlp.example.com" };

    it("is empty when there is no policy, so dispatch options stay lineage-only", () => {
        expect(egressOutbound(undefined, platform)).toStrictEqual({});
    });

    it("is empty for mode off, even with platform origins", () => {
        expect(egressOutbound({ mode: "off", origins: [], v: 1 }, platform)).toStrictEqual({});
    });

    it("withholds a report policy from the wire, even with platform origins (no recording yet)", () => {
        expect(egressOutbound({ mode: "report", origins: ["https://api.example.com"], v: 1 }, platform)).toStrictEqual({});
    });

    it("carries an enforcing policy with platform origins merged and deduped", () => {
        const outbound = egressOutbound(
            { mode: "enforce", origins: ["https://api.example.com"], v: 1 },
            {
                LUNORA_AI_PROXY_URL: "https://api.example.com/v1",
                LUNORA_OTLP_ENDPOINT: "https://otlp.example.com/v1/traces",
            },
        );

        expect(parseEgressParameter(parameterOf(outbound))).toStrictEqual({
            mode: "enforce",
            origins: ["https://api.example.com", "https://otlp.example.com"],
            v: 1,
        });
    });

    it("skips a malformed platform origin rather than widening the list", () => {
        const outbound = egressOutbound({ mode: "enforce", origins: [], v: 1 }, { LUNORA_ENVIRONMENT: "development", LUNORA_OTLP_ENDPOINT: "not a url" });

        expect(parseEgressParameter(parameterOf(outbound))?.origins).toStrictEqual([]);
    });
});

describe("egressOutbound refusal", () => {
    const enforce: EgressPolicy = { mode: "enforce", origins: ["https://api.example.com"], v: 1 };

    it("refuses an enforcing policy with no platform origins outside development, with public text", () => {
        for (const LUNORA_ENVIRONMENT of [undefined, "production"]) {
            const outbound = egressOutbound(enforce, { LUNORA_ENVIRONMENT });

            expect(outbound).toStrictEqual({ refuse: expect.stringMatching(/not available for this project/) });
            expect(JSON.stringify(outbound)).not.toMatch(/LUNORA_/);
        }
    });

    it("allows an enforcing policy with no platform origins under lunora dev", () => {
        expect(parameterOf(egressOutbound(enforce, { LUNORA_ENVIRONMENT: "development" }))).toBeDefined();
    });

    it("allows an enforcing policy once the platform origins are configured", () => {
        expect(parameterOf(egressOutbound(enforce, { LUNORA_OTLP_ENDPOINT: "https://otlp.example.com" }))).toBeDefined();
    });

    it("does not refuse off, report, or no policy, which send nothing", () => {
        expect(egressOutbound({ mode: "off", origins: [], v: 1 }, {})).toStrictEqual({});
        expect(egressOutbound({ mode: "report", origins: [], v: 1 }, {})).toStrictEqual({});
        expect(egressOutbound(undefined, {})).toStrictEqual({});
    });
});

describe(platformEgressOrigins, () => {
    it("takes the origins of the OTLP endpoint and the AI proxy", () => {
        expect(
            platformEgressOrigins({ LUNORA_AI_PROXY_URL: "https://ai.example.com/v1", LUNORA_OTLP_ENDPOINT: "https://otlp.example.com/v1/traces" }),
        ).toStrictEqual(["https://otlp.example.com", "https://ai.example.com"]);
    });

    it("is empty when neither is configured, and skips a malformed value", () => {
        expect(platformEgressOrigins({})).toStrictEqual([]);
        expect(platformEgressOrigins({ LUNORA_OTLP_ENDPOINT: "not a url" })).toStrictEqual([]);
    });
});

describe(parseEgressParameter, () => {
    it("returns undefined for anything that is not a valid policy string", () => {
        expect(parseEgressParameter(undefined)).toBeUndefined();
        expect(parseEgressParameter("{not json")).toBeUndefined();
        expect(parseEgressParameter(JSON.stringify({ mode: "enforce", origins: [], v: 9 }))).toBeUndefined();
    });
});

describe("egress origin ceiling", () => {
    /** One platform origin per platform variable, so the wire count is exactly the reserve. */
    const PLATFORM_ENV = { LUNORA_AI_PROXY_URL: "https://ai.lunora.app", LUNORA_OTLP_ENDPOINT: "https://otel.lunora.app" };

    it("accepts the largest user list with the platform origins appended", () => {
        const policy = validateEgressPolicy({ mode: "enforce", origins: userOrigins(MAX_USER_EGRESS_ORIGINS), v: 1 });

        expect(policy.ok).toBe(true);

        const outbound = egressOutbound(policy.ok ? policy.policy : undefined, PLATFORM_ENV);

        expect(parseEgressParameter(parameterOf(outbound))?.origins).toHaveLength(MAX_USER_EGRESS_ORIGINS + PLATFORM_VARIABLE_COUNT);
    });

    it("rejects one origin more than the user ceiling", () => {
        const policy = validateEgressPolicy({ mode: "enforce", origins: userOrigins(MAX_USER_EGRESS_ORIGINS + 1), v: 1 });

        expect(policy.ok).toBe(false);
    });

    it("reserves exactly one wire slot per platform variable, so a drift in either fails here", () => {
        expect(PLATFORM_ORIGIN_RESERVE).toBe(PLATFORM_VARIABLE_COUNT);
        expect(MAX_USER_EGRESS_ORIGINS + PLATFORM_VARIABLE_COUNT).toBeLessThanOrEqual(MAX_WIRE_EGRESS_ORIGINS);
    });
});

describe("egress origin host length", () => {
    it("accepts a host name at the DNS limit", () => {
        const host = ["a".repeat(63), "a".repeat(63), "a".repeat(63), "a".repeat(61)].join(".");

        expect(host).toHaveLength(MAX_HOST_NAME_LENGTH);
        expect(parseEgressOrigin(`https://${host}`).ok).toBe(true);
    });

    it("rejects a host name over the DNS limit", () => {
        const label = "a".repeat(60);
        const host = [label, label, label, label, label].join(".");

        expect(host.length).toBeGreaterThan(MAX_HOST_NAME_LENGTH);
        expect(parseEgressOrigin(`https://${host}`).ok).toBe(false);
    });
});
