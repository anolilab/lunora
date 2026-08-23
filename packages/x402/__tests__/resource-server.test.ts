import { describe, expect, it, vi } from "vitest";

import { buildResourceServer } from "../src/charge/resource-server";

describe("buildResourceServer", () => {
    it("registers the exact EVM scheme for an EVM network only", async () => {
        const server = await buildResourceServer({
            network: "base",
            price: "0.01",
            recipient: { evm: "0x1111111111111111111111111111111111111111" },
        });

        expect(server.hasRegisteredScheme("eip155:8453", "exact")).toBe(true);
        // Family isolation: no Solana scheme was pulled in.
        expect(server.hasRegisteredScheme("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "exact")).toBe(false);
    });

    it("registers the exact SVM scheme for a Solana network only", async () => {
        const server = await buildResourceServer({
            network: "solana",
            price: "0.01",
            recipient: { svm: "So11111111111111111111111111111111111111112" },
        });

        expect(server.hasRegisteredScheme("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "exact")).toBe(true);
        expect(server.hasRegisteredScheme("eip155:8453", "exact")).toBe(false);
    });

    it("scopes registration to the configured network", async () => {
        const server = await buildResourceServer({
            network: "base-sepolia",
            price: "0.01",
            recipient: { evm: "0x1111111111111111111111111111111111111111" },
        });

        expect(server.hasRegisteredScheme("eip155:84532", "exact")).toBe(true);
        expect(server.hasRegisteredScheme("eip155:8453", "exact")).toBe(false);
    });

    it("fails with install guidance when the @x402/evm peer is not installed", async () => {
        // A throwing factory makes the lazy `import("@x402/evm/exact/server")` reject,
        // exercising the missing-peer catch (same pattern as pay-wallet's CDP test).
        vi.resetModules();
        vi.doMock(import("@x402/evm/exact/server"), () => {
            throw new Error("Cannot find package '@x402/evm'");
        });

        try {
            const { buildResourceServer: buildWithoutPeer } = await import("../src/charge/resource-server");

            await expect(
                buildWithoutPeer({ network: "base", price: "0.01", recipient: { evm: "0x1111111111111111111111111111111111111111" } }),
            ).rejects.toMatchObject({
                code: "ENV_INVALID",
                message: expect.stringMatching(/optional @x402\/evm \+ viem peers/),
            });
        } finally {
            vi.doUnmock("@x402/evm/exact/server");
            vi.resetModules();
        }
    });

    it("fails with install guidance when the @x402/svm peer is not installed", async () => {
        vi.resetModules();
        vi.doMock(import("@x402/svm/exact/server"), () => {
            throw new Error("Cannot find package '@x402/svm'");
        });

        try {
            const { buildResourceServer: buildWithoutPeer } = await import("../src/charge/resource-server");

            await expect(
                buildWithoutPeer({ network: "solana", price: "0.01", recipient: { svm: "So11111111111111111111111111111111111111112" } }),
            ).rejects.toMatchObject({
                code: "ENV_INVALID",
                message: expect.stringMatching(/optional @x402\/svm \+ @solana\/kit peers/),
            });
        } finally {
            vi.doUnmock("@x402/svm/exact/server");
            vi.resetModules();
        }
    });
});
