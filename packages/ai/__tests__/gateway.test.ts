import { describe, expect, it, vi } from "vitest";

import { AI_GATEWAY_ACCOUNT_ID_ENV, AI_GATEWAY_ID_ENV, AI_GATEWAY_TOKEN_ENV, buildAiGatewayMetadataFields, resolveAiGateway } from "../src/gateway";

/** A configured-gateway env, without any auth token. */
const configuredEnv = (): Record<string, unknown> => {
    return { [AI_GATEWAY_ACCOUNT_ID_ENV]: "acct-123", [AI_GATEWAY_ID_ENV]: "my-gateway" };
};

// A fixed 32-hex trace id for the correlation-metadata assertions. Not a
// credential — the `no-secrets` heuristic just sees a high-entropy hex run.
// eslint-disable-next-line no-secrets/no-secrets -- fake test trace id, not a real secret
const FAKE_TRACE_ID = "0123456789abcdef0123456789abcdef";

describe(resolveAiGateway, () => {
    it("returns undefined when the gateway env vars are absent (direct-provider default)", () => {
        expect.assertions(1);
        expect(resolveAiGateway({})).toBeUndefined();
    });

    it("returns undefined when only one of account/gateway is set", () => {
        expect.assertions(2);
        expect(resolveAiGateway({ [AI_GATEWAY_ACCOUNT_ID_ENV]: "acct-123" })).toBeUndefined();
        expect(resolveAiGateway({ [AI_GATEWAY_ID_ENV]: "my-gateway" })).toBeUndefined();
    });

    it("ignores empty-string env values (treated as unset)", () => {
        expect.assertions(1);
        expect(resolveAiGateway({ [AI_GATEWAY_ACCOUNT_ID_ENV]: "", [AI_GATEWAY_ID_ENV]: "my-gateway" })).toBeUndefined();
    });

    it("builds the universal gateway base URL and gateway id, with no headers when unauthenticated", () => {
        expect.assertions(1);

        const resolved = resolveAiGateway(configuredEnv());

        expect(resolved).toStrictEqual({
            accountId: "acct-123",
            baseURL: "https://gateway.ai.cloudflare.com/v1/acct-123/my-gateway",
            gatewayId: "my-gateway",
            headers: {},
        });
    });

    it("adds cf-aig-authorization when a gateway token is configured", () => {
        expect.assertions(1);

        const resolved = resolveAiGateway({ ...configuredEnv(), [AI_GATEWAY_TOKEN_ENV]: "gw-secret" });

        expect(resolved?.headers).toStrictEqual({ "cf-aig-authorization": "Bearer gw-secret" });
    });

    it("folds a cf-aig-metadata correlation header from the defined metadata fields", () => {
        expect.assertions(1);

        const resolved = resolveAiGateway(configuredEnv(), { functionPath: "messages:send", traceId: FAKE_TRACE_ID });

        expect(resolved?.headers["cf-aig-metadata"]).toBe(JSON.stringify({ functionPath: "messages:send", traceId: FAKE_TRACE_ID }));
    });

    it("omits cf-aig-metadata when the metadata object carries no defined fields", () => {
        expect.assertions(1);

        const resolved = resolveAiGateway(configuredEnv(), {});

        expect(resolved?.headers).toStrictEqual({});
    });

    it("warns once when a token is set on the Workers AI binding path (which can't carry it)", () => {
        expect.assertions(4);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        try {
            const env = { ...configuredEnv(), [AI_GATEWAY_TOKEN_ENV]: "gw-secret" };

            // The Workers AI binding's native `gateway` option has no authorization
            // field, so a configured token would be silently dropped on this path —
            // resolveAiGateway warns instead so it isn't diagnosed at inference time.
            const resolved = resolveAiGateway(env, undefined, "workers-ai-binding");

            // The token still appears in `headers` (that is what the BYO-provider
            // path sends); only the binding path can't use it.
            expect(resolved?.headers).toStrictEqual({ "cf-aig-authorization": "Bearer gw-secret" });
            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0]?.[0])).toContain(AI_GATEWAY_TOKEN_ENV);

            // One-shot per isolate: a second binding-path resolution stays quiet so a
            // hot dispatch path doesn't flood the log.
            resolveAiGateway(env, undefined, "workers-ai-binding");

            expect(warn).toHaveBeenCalledTimes(1);
        } finally {
            warn.mockRestore();
        }
    });
});

describe(buildAiGatewayMetadataFields, () => {
    it("returns undefined for undefined metadata", () => {
        expect.assertions(1);
        expect(buildAiGatewayMetadataFields(undefined)).toBeUndefined();
    });

    it("returns undefined when no field is defined", () => {
        expect.assertions(2);
        expect(buildAiGatewayMetadataFields({})).toBeUndefined();
        expect(buildAiGatewayMetadataFields({ functionPath: "", traceId: undefined })).toBeUndefined();
    });

    it("projects only the defined, non-empty correlation fields", () => {
        expect.assertions(2);
        expect(buildAiGatewayMetadataFields({ functionPath: "messages:send", traceId: FAKE_TRACE_ID })).toStrictEqual({
            functionPath: "messages:send",
            traceId: FAKE_TRACE_ID,
        });
        expect(buildAiGatewayMetadataFields({ functionPath: "messages:send" })).toStrictEqual({ functionPath: "messages:send" });
    });
});
