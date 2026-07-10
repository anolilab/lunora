import { describe, expect, it } from "vitest";

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
});
