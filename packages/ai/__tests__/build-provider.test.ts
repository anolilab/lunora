import type { LanguageModel } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AiBindingLike, WorkersAiProviderLike } from "../src/types";

/**
 * Capture what `createAi` hands to `createWorkersAI` when it builds the provider
 * from a binding. The real provider is opaque, so we mock the module and assert
 * the binding + gateway are threaded through — the construction seam the
 * provider-from-binding and gateway-routing paths both rely on.
 */
const createWorkersAI = vi.fn<(options: Record<string, unknown>) => WorkersAiProviderLike>((): WorkersAiProviderLike => {
    const provider = ((modelId: string) => ({ __model: modelId }) as unknown as LanguageModel) as WorkersAiProviderLike;

    provider.textEmbeddingModel = (modelId: string) => ({ __embeddingModel: modelId }) as never;

    return provider;
});

// String specifier (not the `import(...)` form): the typed-import overload would
// check the factory's return against the real module's exports, and our
// intentionally-narrow `WorkersAiProviderLike` mock doesn't implement the full
// `WorkersAI` surface. The string form mocks the module without that constraint.
// eslint-disable-next-line vitest/prefer-import-in-mock -- typed-import overload rejects the narrow mock provider
vi.mock("workers-ai-provider", () => {
    return { createWorkersAI };
});

const { default: createAi } = await import("../src/create-ai");

const fakeBinding = (): AiBindingLike => {
    return {
        run: async () => {
            return {};
        },
    };
};

describe("provider construction from a binding", () => {
    beforeEach(() => {
        createWorkersAI.mockClear();
    });

    it("threads the binding through createWorkersAI", () => {
        expect.assertions(2);

        const binding = fakeBinding();

        createAi({ binding });

        expect(createWorkersAI).toHaveBeenCalledTimes(1);
        expect(createWorkersAI).toHaveBeenCalledWith({ binding, gateway: undefined });
    });

    it("threads the AI Gateway config through createWorkersAI", () => {
        expect.assertions(1);

        const binding = fakeBinding();
        const gateway = { cacheTtl: 60, id: "my-gateway" };

        createAi({ binding, gateway });

        expect(createWorkersAI).toHaveBeenCalledWith({ binding, gateway });
    });

    it("does not call createWorkersAI when a provider is supplied", () => {
        expect.assertions(1);

        const provider = ((modelId: string) => ({ __model: modelId }) as unknown as LanguageModel) as WorkersAiProviderLike;

        createAi({ provider });

        expect(createWorkersAI).not.toHaveBeenCalled();
    });

    it("routes Workers AI through an env-configured AI Gateway (opt-in)", () => {
        expect.assertions(1);

        const binding = fakeBinding();

        createAi({ binding, env: { LUNORA_AI_GATEWAY_ACCOUNT_ID: "acct-123", LUNORA_AI_GATEWAY_ID: "my-gateway" } });

        // The env vars derive the Workers AI `gateway` option by id so the gateway
        // computes token + dollar-cost telemetry.
        expect(createWorkersAI).toHaveBeenCalledWith({ binding, gateway: { id: "my-gateway" } });
    });

    it("leaves the direct-provider path unchanged when env has no gateway vars", () => {
        expect.assertions(1);

        const binding = fakeBinding();

        createAi({ binding, env: { SOME_OTHER: "x" } });

        expect(createWorkersAI).toHaveBeenCalledWith({ binding, gateway: undefined });
    });

    it("prefers an explicit gateway over the env-derived one", () => {
        expect.assertions(1);

        const binding = fakeBinding();
        const gateway = { cacheTtl: 60, id: "explicit-gateway" };

        createAi({ binding, env: { LUNORA_AI_GATEWAY_ACCOUNT_ID: "acct-123", LUNORA_AI_GATEWAY_ID: "env-gateway" }, gateway });

        expect(createWorkersAI).toHaveBeenCalledWith({ binding, gateway });
    });
});

// A fixed 32-hex trace id for the correlation-metadata assertions. Not a
// credential — the `no-secrets` heuristic just sees a high-entropy hex run.
// eslint-disable-next-line no-secrets/no-secrets -- fake test trace id, not a real secret
const FAKE_TRACE_ID = "0123456789abcdef0123456789abcdef";

describe("gateway correlation metadata", () => {
    beforeEach(() => {
        createWorkersAI.mockClear();
    });

    it("folds functionPath + traceId into the env-derived gateway's metadata", () => {
        expect.assertions(1);

        const binding = fakeBinding();

        createAi({
            binding,
            env: { LUNORA_AI_GATEWAY_ACCOUNT_ID: "acct-123", LUNORA_AI_GATEWAY_ID: "my-gateway" },
            metadata: { functionPath: "messages:send", traceId: FAKE_TRACE_ID },
        });

        expect(createWorkersAI).toHaveBeenCalledWith({
            binding,
            gateway: { id: "my-gateway", metadata: { functionPath: "messages:send", traceId: FAKE_TRACE_ID } },
        });
    });

    it("sends only the defined metadata fields", () => {
        expect.assertions(1);

        const binding = fakeBinding();

        createAi({
            binding,
            env: { LUNORA_AI_GATEWAY_ACCOUNT_ID: "acct-123", LUNORA_AI_GATEWAY_ID: "my-gateway" },
            metadata: { functionPath: "messages:send" },
        });

        expect(createWorkersAI).toHaveBeenCalledWith({ binding, gateway: { id: "my-gateway", metadata: { functionPath: "messages:send" } } });
    });

    it("omits gateway metadata entirely when no correlation field is defined", () => {
        expect.assertions(1);

        const binding = fakeBinding();

        createAi({
            binding,
            env: { LUNORA_AI_GATEWAY_ACCOUNT_ID: "acct-123", LUNORA_AI_GATEWAY_ID: "my-gateway" },
            metadata: { functionPath: undefined, traceId: undefined },
        });

        // No `metadata` key on the gateway option — the env-derived gateway is
        // still routed by id, unchanged from the no-metadata case.
        expect(createWorkersAI).toHaveBeenCalledWith({ binding, gateway: { id: "my-gateway" } });
    });

    it("does not attach metadata when no gateway is configured (additive/opt-in)", () => {
        expect.assertions(1);

        const binding = fakeBinding();

        createAi({ binding, env: { SOME_OTHER: "x" }, metadata: { functionPath: "messages:send", traceId: FAKE_TRACE_ID } });

        // Without gateway env vars there is no gateway to correlate — the direct
        // Workers AI path stays exactly as before.
        expect(createWorkersAI).toHaveBeenCalledWith({ binding, gateway: undefined });
    });

    it("folds metadata into an explicit gateway that carries none", () => {
        expect.assertions(1);

        const binding = fakeBinding();

        createAi({ binding, gateway: { cacheTtl: 60, id: "explicit" }, metadata: { functionPath: "messages:send", traceId: FAKE_TRACE_ID } });

        expect(createWorkersAI).toHaveBeenCalledWith({
            binding,
            gateway: { cacheTtl: 60, id: "explicit", metadata: { functionPath: "messages:send", traceId: FAKE_TRACE_ID } },
        });
    });

    it("preserves an explicit gateway's own metadata over the threaded correlation", () => {
        expect.assertions(1);

        const binding = fakeBinding();
        const gateway = { id: "explicit", metadata: { tenant: "acme" } };

        createAi({ binding, gateway, metadata: { functionPath: "messages:send", traceId: FAKE_TRACE_ID } });

        expect(createWorkersAI).toHaveBeenCalledWith({ binding, gateway });
    });
});
