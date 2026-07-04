import { x402Client as X402Client } from "@x402/core/client";
import { describe, expect, it } from "vitest";

import type { X402PayConfig } from "../src/config";
import { createX402Pay } from "../src/pay";
import { registerWallet, resolveEvmAccount } from "../src/pay/wallet";

// A well-known public Hardhat/Anvil test key (account #0). Not a real secret.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // secret-scanner:allow -- public Hardhat test key #0
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const boundedPolicy = { maxPerCall: "$0.10" } as const;

describe("resolveEvmAccount", () => {
    it("derives the canonical address from a raw private key (0x-prefixed or not)", async () => {
        const withPrefix = await resolveEvmAccount(TEST_KEY);
        const withoutPrefix = await resolveEvmAccount(TEST_KEY.slice(2));

        expect(withPrefix.address.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
        expect(withoutPrefix.address.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
    });

    it("rejects a key that is not 32-byte hex", async () => {
        await expect(resolveEvmAccount("nothex")).rejects.toThrow(/32-byte hex/);
    });
});

describe("registerWallet", () => {
    it("registers the EVM exact scheme for a raw-key signer", async () => {
        const client = new X402Client();
        const config: X402PayConfig = { network: "base-sepolia", policy: boundedPolicy, signer: { secretName: "AGENT_KEY", type: "raw-key" } };

        await expect(registerWallet(client, config, { getSecret: () => TEST_KEY })).resolves.toBeUndefined();
    });

    it("fails clearly when the wallet secret is unset", async () => {
        const client = new X402Client();
        const config: X402PayConfig = { network: "base", policy: boundedPolicy, signer: { secretName: "AGENT_KEY", type: "raw-key" } };

        await expect(registerWallet(client, config, { getSecret: () => undefined })).rejects.toThrow(/secret "AGENT_KEY" is not set/);
    });

    it("refuses CDP-managed EVM custody with guidance (needs @coinbase/cdp-sdk)", async () => {
        const client = new X402Client();
        const config: X402PayConfig = { network: "base", policy: boundedPolicy, signer: { account: "agent-wallet", type: "cdp" } };

        await expect(registerWallet(client, config, { getSecret: () => TEST_KEY })).rejects.toThrow(/CDP-managed EVM custody.*cdp-sdk/s);
    });

    it("refuses SVM custody (pay side not wired yet)", async () => {
        const client = new X402Client();
        const config: X402PayConfig = { network: "solana", policy: boundedPolicy, signer: { secretName: "AGENT_KEY", type: "raw-key" } };

        await expect(registerWallet(client, config, { getSecret: () => TEST_KEY })).rejects.toThrow(/Solana \(SVM\)/);
    });
});

describe("createX402Pay", () => {
    it("refuses an unbounded policy before resolving a signer", async () => {
        const config = { network: "base", policy: {}, signer: { secretName: "AGENT_KEY", type: "raw-key" } } as X402PayConfig;

        // Even with no secret available, the policy guard fires first.
        await expect(createX402Pay(config, { getSecret: () => undefined })).rejects.toThrow(/unbounded spend policy/);
    });

    it("builds a payment-enabled fetch under a bounded policy", async () => {
        const config: X402PayConfig = { network: "base", policy: boundedPolicy, signer: { secretName: "AGENT_KEY", type: "raw-key" } };
        const pay = await createX402Pay(config, { fetch: globalThis.fetch, getSecret: () => TEST_KEY });

        expect(typeof pay.fetch).toBe("function");
    });
});
