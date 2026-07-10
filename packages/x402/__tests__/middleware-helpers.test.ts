import { describe, expect, it } from "vitest";

import { buildRoute, createRequestAdapter, resolvePayTo, toResponse, withHeaders } from "../src/charge/middleware";

const evmConfig = { network: "base", price: "0.01", recipient: { evm: "0x1111111111111111111111111111111111111111" } } as const;

describe("resolvePayTo", () => {
    it("returns the EVM address for an EVM network", () => {
        expect(resolvePayTo(evmConfig)).toBe("0x1111111111111111111111111111111111111111");
    });

    it("returns the SVM address for a Solana network", () => {
        expect(resolvePayTo({ network: "solana", price: "0.01", recipient: { svm: "So11111111111111111111111111111111111111112" } })).toBe(
            "So11111111111111111111111111111111111111112",
        );
    });

    it("throws when the matching recipient is missing", () => {
        expect(() => resolvePayTo({ network: "base", price: "0.01", recipient: {} })).toThrow(/recipient\.evm/);
        expect(() => resolvePayTo({ network: "solana", price: "0.01", recipient: { evm: "0x1111111111111111111111111111111111111111" } })).toThrow(
            /recipient\.svm/,
        );
    });
});

describe("buildRoute", () => {
    it("builds a single exact-scheme option in the network's CAIP-2 id", () => {
        const route = buildRoute(evmConfig);
        const accepts = Array.isArray(route.accepts) ? route.accepts[0] : route.accepts;

        expect(accepts).toMatchObject({ network: "eip155:8453", payTo: evmConfig.recipient.evm, price: "0.01", scheme: "exact" });
    });
});

describe("createRequestAdapter", () => {
    it("exposes request metadata the way @x402/core expects", () => {
        const request = new Request("https://api.example/report?tier=pro&tag=a&tag=b", {
            headers: { accept: "application/json", "user-agent": "agent/1", "x-payment": "sig" },
            method: "POST",
        });
        const adapter = createRequestAdapter(request, new URL(request.url));

        expect(adapter.getMethod()).toBe("POST");
        expect(adapter.getPath()).toBe("/report");
        expect(adapter.getAcceptHeader()).toBe("application/json");
        expect(adapter.getUserAgent()).toBe("agent/1");
        expect(adapter.getHeader("x-payment")).toBe("sig");
        expect(adapter.getHeader("missing")).toBeUndefined();
        expect(adapter.getQueryParam?.("tier")).toBe("pro");
        expect(adapter.getQueryParam?.("tag")).toEqual(["a", "b"]);
        expect(adapter.getQueryParams?.()).toEqual({ tag: ["a", "b"], tier: "pro" });
    });
});

describe("toResponse", () => {
    it("serialises an object body as JSON", async () => {
        const response = toResponse({ body: { error: "nope" }, headers: { "payment-required": "x" }, status: 402 });

        expect(response.status).toBe(402);
        expect(response.headers.get("content-type")).toBe("application/json");
        expect(response.headers.get("payment-required")).toBe("x");
        await expect(response.json()).resolves.toEqual({ error: "nope" });
    });

    it("passes a string HTML body through with a text/html type", async () => {
        const response = toResponse({ body: "<h1>pay</h1>", headers: {}, isHtml: true, status: 402 });

        expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
        await expect(response.text()).resolves.toBe("<h1>pay</h1>");
    });

    it("emits no body when there is none", async () => {
        const response = toResponse({ headers: {}, status: 402 });

        await expect(response.text()).resolves.toBe("");
    });
});

describe("withHeaders", () => {
    it("merges extra headers while preserving status and body", async () => {
        const merged = withHeaders(new Response("ok", { headers: { "content-type": "text/plain" }, status: 200 }), { "x-payment-response": "receipt" });

        expect(merged.status).toBe(200);
        expect(merged.headers.get("content-type")).toBe("text/plain");
        expect(merged.headers.get("x-payment-response")).toBe("receipt");
        await expect(merged.text()).resolves.toBe("ok");
    });
});
