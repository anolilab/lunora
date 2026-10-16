import { isLunoraError } from "@lunora/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import createAi from "../src/create-ai";
import { AI_GATEWAY_ACCOUNT_ID_ENV, AI_GATEWAY_ID_ENV, AI_PROXY_TOKEN_ENV, AI_PROXY_URL_ENV } from "../src/gateway";
import type { AiBindingLike } from "../src/types";

/** The subset of `generateImage`'s argument the routing tests assert on. */
interface ImageCall {
    model: {
        config: {
            baseURL?: string;
            fetch?: (input: string, init?: RequestInit) => Promise<Response>;
            url?: (options: { modelId: string; path: string }) => string;
        };
        modelId: string;
        provider: string;
    };
    n?: number;
    prompt: string;
    seed?: number;
    size?: string;
}

// `generateImage` lives in the `ai` root, which `create-ai` imports lazily; the
// mock keeps the routing assertions free of a real provider call.
const generateImage = vi.hoisted(() => vi.fn<(input: ImageCall) => Promise<{ images: { base64: string; mediaType: string }[] }>>());

vi.mock(import("ai"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>();

    return { ...actual, generateImage: generateImage as unknown as typeof actual.generateImage };
});

/** A configured-gateway env, so the provider slugs build a gateway-backed model. */
const gatewayEnv = (): Record<string, unknown> => {
    return { [AI_GATEWAY_ACCOUNT_ID_ENV]: "acct-123", [AI_GATEWAY_ID_ENV]: "my-gateway" };
};

describe("ai.images.generate", () => {
    beforeEach(() => {
        generateImage.mockReset();
        generateImage.mockResolvedValue({ images: [{ base64: "AAA", mediaType: "image/png" }] });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("strips the placeholder key from gateway image requests so the gateway's stored key authenticates", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<() => Promise<Response>>(async () => new Response("{}"));
        vi.stubGlobal("fetch", fetchMock);

        await createAi({ env: gatewayEnv() }).images.generate({ model: "openai/dall-e-3", prompt: "x" });
        const call = generateImage.mock.calls[0]?.[0];

        await call?.model.config.fetch?.("https://gateway.ai.cloudflare.com/v1/acct-123/my-gateway/openai/images/generations", {
            headers: { Authorization: "Bearer unused" },
        });
        const sent = new Headers((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers);

        expect(sent.has("authorization")).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("routes an openai/<model> slug through the AI SDK image model", async () => {
        expect.assertions(5);

        const result = await createAi({ env: gatewayEnv() }).images.generate({ model: "openai/dall-e-3", prompt: "a cat", size: "1024x1024" });
        const call = generateImage.mock.calls[0]?.[0];

        expect(result).toStrictEqual({ images: [{ base64: "AAA", mimeType: "image/png" }], model: "openai/dall-e-3" });
        expect(generateImage).toHaveBeenCalledTimes(1);
        expect(call?.prompt).toBe("a cat");
        // The slug's provider prefix is stripped before it reaches the provider.
        expect(call?.model.modelId).toBe("dall-e-3");
        expect(call?.model.provider).toBe("openai.image");
    });

    it("routes a google/<model> slug through the AI SDK image model", async () => {
        expect.assertions(4);

        generateImage.mockResolvedValue({ images: [{ base64: "BBB", mediaType: "image/jpeg" }] });
        const result = await createAi({ env: gatewayEnv() }).images.generate({ model: "google/imagen-4.0-generate-001", prompt: "a dog", count: 2 });
        const call = generateImage.mock.calls[0]?.[0];

        expect(result.images).toStrictEqual([{ base64: "BBB", mimeType: "image/jpeg" }]);
        expect(call?.model.modelId).toBe("imagen-4.0-generate-001");
        expect(call?.model.provider).toBe("google.generative-ai");
        expect(call?.n).toBe(2);
    });

    it("routes an openai slug through the OpenAI-compatible proxy when one is configured", async () => {
        expect.assertions(2);

        await createAi({ env: { [AI_PROXY_URL_ENV]: "https://proxy.internal/v1" } }).images.generate({ model: "openai/dall-e-3", prompt: "x" });
        const call = generateImage.mock.calls[0]?.[0];

        expect(generateImage).toHaveBeenCalledTimes(1);
        expect(call?.model.provider).toBe("lunora-proxy.image");
    });

    it("runs a Workers AI image id through the binding and normalises { image }", async () => {
        expect.assertions(2);

        const runCalls: unknown[][] = [];
        const binding: AiBindingLike = {
            run: async (...arguments_) => {
                runCalls.push(arguments_);

                return { image: "YmFzZTY0" };
            },
        };

        const result = await createAi({ binding }).images.generate({ model: "@cf/black-forest-labs/flux-1-schnell", prompt: "a fox", size: "512x512" });

        // "YmFzZTY0" is not image data, so no format is claimed for it.
        expect(result).toStrictEqual({ images: [{ base64: "YmFzZTY0" }], model: "@cf/black-forest-labs/flux-1-schnell" });
        expect(runCalls).toStrictEqual([["@cf/black-forest-labs/flux-1-schnell", { height: 512, prompt: "a fox", width: 512 }, undefined]]);
    });

    it("sniffs the MIME type from the image bytes instead of labelling every output PNG", async () => {
        expect.assertions(2);

        // A JPEG's leading bytes, base64-encoded, from a binding that returns a bare string.
        const binding: AiBindingLike = { run: async () => "/9j/4AAQSkZJRgABAQAAAQABAAD/" };
        const result = await createAi({ binding }).images.generate({ model: "@cf/black-forest-labs/flux-1-schnell", prompt: "a fox" });

        expect(result.images).toStrictEqual([{ base64: "/9j/4AAQSkZJRgABAQAAAQABAAD/", mimeType: "image/jpeg" }]);

        const png: AiBindingLike = { run: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) };
        const pngResult = await createAi({ binding: png }).images.generate({ model: "@cf/black-forest-labs/flux-1-schnell", prompt: "a fox" });

        expect(pngResult.images[0]?.mimeType).toBe("image/png");
    });

    it("throws the binding's failure instead of returning its error body as an image", async () => {
        expect.assertions(2);

        const binding: AiBindingLike = { run: async () => new Response("capacity exceeded", { status: 503 }) };
        const error: unknown = await createAi({ binding })
            .images.generate({ model: "@cf/black-forest-labs/flux-1-schnell", prompt: "x" })
            .catch((error_: unknown) => error_);

        expect(isLunoraError(error) && error.code === "SERVICE_UNAVAILABLE").toBe(true);
        expect((error as Error).message).toMatch(/HTTP 503: capacity exceeded/);
    });

    it("rejects a malformed size before any billed call", async () => {
        expect.assertions(2);

        const error: unknown = await createAi({ env: gatewayEnv() })
            .images.generate({ model: "openai/dall-e-3", prompt: "x", size: "1024x" as never })
            .catch((error_: unknown) => error_);

        expect(isLunoraError(error) && error.code === "BAD_REQUEST").toBe(true);
        expect(generateImage).not.toHaveBeenCalled();
    });

    it("records an estimated image cost on the function's metrics", async () => {
        expect.assertions(1);

        const count = vi.fn<(name: string, value?: number, attributes?: Record<string, unknown>) => void>();
        generateImage.mockResolvedValueOnce({
            images: [
                { base64: "AAA", mediaType: "image/png" },
                { base64: "BBB", mediaType: "image/png" },
            ],
        });
        await createAi({ env: gatewayEnv(), telemetry: { metrics: { count } } }).images.generate({ model: "openai/dall-e-3", prompt: "x", count: 2 });

        expect(count).toHaveBeenCalledWith("gen_ai.usage.cost", 0.08, { "gen_ai.request.model": "openai/dall-e-3", "lunora.usage.cost.source": "estimated" });
    });

    it("sends the explicit gateway option's id, not only the env one, to the provider", async () => {
        expect.assertions(1);

        await createAi({ env: { [AI_GATEWAY_ACCOUNT_ID_ENV]: "acct-123" }, gateway: { id: "explicit-gw" } }).images.generate({
            model: "openai/dall-e-3",
            prompt: "x",
        });
        const call = generateImage.mock.calls[0]?.[0];

        expect(call?.model.config.url?.({ path: "/images/generations", modelId: "dall-e-3" })).toBe(
            "https://gateway.ai.cloudflare.com/v1/acct-123/explicit-gw/openai/images/generations",
        );
    });

    it("routes an openai slug through the proxy with the full slug, as chat does", async () => {
        expect.assertions(1);

        await createAi({ env: { [AI_PROXY_URL_ENV]: "https://proxy.internal/v1" } }).images.generate({ model: "openai/dall-e-3", prompt: "x" });

        expect(generateImage.mock.calls[0]?.[0].model.modelId).toBe("openai/dall-e-3");
    });

    it("generates one Workers AI image per call for a count over one", async () => {
        expect.assertions(2);

        let calls = 0;
        const binding: AiBindingLike = {
            run: async () => {
                calls += 1;

                return { image: "YmFzZTY0" };
            },
        };

        const result = await createAi({ binding }).images.generate({ model: "@cf/black-forest-labs/flux-1-schnell", count: 2, prompt: "a fox" });

        expect(result.images).toHaveLength(2);
        expect(calls).toBe(2);
    });

    it("sends an openai slug to the AI Gateway's /openai route, not a /openai/v1 base", async () => {
        expect.assertions(1);

        await createAi({ env: gatewayEnv() }).images.generate({ model: "openai/dall-e-3", prompt: "x" });
        const call = generateImage.mock.calls[0]?.[0];

        // The SDK appends its own `/images/generations`; a `/v1` base would double it.
        expect(call?.model.config.url?.({ path: "/images/generations", modelId: "dall-e-3" })).toBe(
            "https://gateway.ai.cloudflare.com/v1/acct-123/my-gateway/openai/images/generations",
        );
    });

    it("keeps the Google AI Studio version segment in the gateway base", async () => {
        expect.assertions(1);

        generateImage.mockResolvedValue({ images: [{ base64: "BBB", mediaType: "image/jpeg" }] });
        await createAi({ env: gatewayEnv() }).images.generate({ model: "google/imagen-4.0-generate-001", prompt: "x" });
        const call = generateImage.mock.calls[0]?.[0];

        // Google's image model appends `/models/<id>:…` to `baseURL`, so the base carries `/v1beta`.
        expect(call?.model.config.baseURL).toBe("https://gateway.ai.cloudflare.com/v1/acct-123/my-gateway/google-ai-studio/v1beta");
    });

    it("refuses to send the proxy token over plain HTTP for images too", async () => {
        expect.assertions(2);

        // Plain HTTP is the point: the refusal must fire for a cleartext token URL.
        // eslint-disable-next-line sonarjs/no-clear-text-protocols -- the test asserts the cleartext refusal
        const cleartextProxy = "http://proxy.internal/v1";
        const error: unknown = await createAi({ env: { [AI_PROXY_URL_ENV]: cleartextProxy, [AI_PROXY_TOKEN_ENV]: "secret" } })
            .images.generate({ model: "openai/dall-e-3", prompt: "x" })
            .catch((error_: unknown) => error_);

        expect((error as Error).message).toMatch(/cleartext/);
        expect(generateImage).not.toHaveBeenCalled();
    });

    it("rejects a count outside 1..8 before any billed call", async () => {
        expect.assertions(2);

        const error: unknown = await createAi({ env: gatewayEnv() })
            .images.generate({ model: "openai/dall-e-3", prompt: "x", count: 1000 })
            .catch((error_: unknown) => error_);

        expect(isLunoraError(error) && error.code === "BAD_REQUEST").toBe(true);
        expect(generateImage).not.toHaveBeenCalled();
    });

    it("throws AI_UNKNOWN_IMAGE_MODEL for an unroutable slug", async () => {
        expect.assertions(2);

        const error: unknown = await createAi({})
            .images.generate({ model: "midjourney/v7", prompt: "x" })
            .catch((error_: unknown) => error_);

        expect(isLunoraError(error) && error.code === "AI_UNKNOWN_IMAGE_MODEL").toBe(true);
        expect((error as Error).message).toMatch(/openai\/<model>/);
    });

    it("throws the directed binding error for a Workers AI id without a binding", async () => {
        expect.assertions(1);

        await expect(createAi({}).images.generate({ model: "@cf/black-forest-labs/flux-1-schnell", prompt: "x" })).rejects.toThrow(
            /ai\.images\.generate needs the `AI` binding/,
        );
    });
});
