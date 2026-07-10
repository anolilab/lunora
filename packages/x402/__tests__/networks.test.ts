import { describe, expect, it } from "vitest";

import { EVM_NETWORKS, isEvmNetwork, isSvmNetwork, NETWORK_TO_CAIP2, SVM_NETWORKS, toCaip2 } from "../src/networks";

describe("networks", () => {
    it("maps every friendly name to a CAIP-2 id", () => {
        for (const [friendly, caip2] of Object.entries(NETWORK_TO_CAIP2)) {
            expect(caip2, friendly).toMatch(/^[a-z0-9]+:.+$/);
            expect(toCaip2(friendly as keyof typeof NETWORK_TO_CAIP2)).toBe(caip2);
        }
    });

    it("resolves the primary prod/test pair to Base mainnet + Sepolia", () => {
        expect(toCaip2("base")).toBe("eip155:8453");
        expect(toCaip2("base-sepolia")).toBe("eip155:84532");
    });

    it("resolves Solana to its CAIP-2 genesis ids", () => {
        expect(toCaip2("solana")).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
        expect(toCaip2("solana-devnet")).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    });

    it("passes a raw CAIP-2 id through unchanged (power-user escape hatch)", () => {
        expect(toCaip2("eip155:10")).toBe("eip155:10");
        expect(toCaip2("solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z")).toBe("solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z");
    });

    it("throws on an unknown, non-CAIP-2 network", () => {
        // @ts-expect-error — exercising the runtime guard with an off-union value.
        expect(() => toCaip2("dogecoin")).toThrow(/Unknown x402 network/);
    });

    it("classifies EVM vs SVM by CAIP-2 namespace", () => {
        for (const network of EVM_NETWORKS) {
            expect(isEvmNetwork(network), network).toBe(true);
            expect(isSvmNetwork(network), network).toBe(false);
        }

        for (const network of SVM_NETWORKS) {
            expect(isSvmNetwork(network), network).toBe(true);
            expect(isEvmNetwork(network), network).toBe(false);
        }
    });

    it("classifies raw CAIP-2 ids too", () => {
        expect(isEvmNetwork("eip155:10")).toBe(true);
        expect(isSvmNetwork("solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z")).toBe(true);
    });

    it("does not advertise networks the SDK cannot settle by default", () => {
        // Optimism / Avalanche are absent from @x402/evm DEFAULT_STABLECOINS at
        // 2.17.0, so they must not be friendly aliases (a raw CAIP-2 id still works).
        expect(Object.keys(NETWORK_TO_CAIP2)).not.toContain("optimism");
        expect(Object.keys(NETWORK_TO_CAIP2)).not.toContain("avalanche");
    });
});
