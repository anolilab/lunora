import { createKeyPairSignerFromPrivateKeyBytes, getBase58Decoder } from "@solana/kit";
import { x402Client as X402Client } from "@x402/core/client";
import type { ClientEvmSigner } from "@x402/evm";
import { describe, expect, it, vi } from "vitest";

import type { X402PayConfig } from "../src/config";
import { createX402Pay } from "../src/pay";
import { registerWallet, resolveEvmAccount, resolveSvmSigner } from "../src/pay/wallet";

// Records what the CDP branch passes to `@coinbase/cdp-sdk` so we can assert the
// credential + account wiring without any live Coinbase call. `vi.hoisted` keeps
// it referenceable from the (hoisted) `vi.mock` factory below.
const cdpRecorder = vi.hoisted(() => {
    return { account: undefined as string | undefined, creds: undefined as Record<string, unknown> | undefined };
});

// String-path form (not `import()`) on purpose: the typed `import()` form checks
// this partial factory against the full module and rejects a minimal CdpClient stub.
// eslint-disable-next-line vitest/prefer-import-in-mock -- partial mock; typed form over-constrains
vi.mock("@coinbase/cdp-sdk", () => {
    return {
        CdpClient: class {
            public evm = {
                getOrCreateAccount: ({ name }: { name: string }) => {
                    cdpRecorder.account = name;

                    return Promise.resolve({ address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", signTypedData: () => Promise.resolve("0x") });
                },
            };

            public constructor(options: Record<string, unknown>) {
                cdpRecorder.creds = options;
            }
        },
    };
});

// A well-known public Hardhat/Anvil test key (account #0). Not a real secret.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // secret-scanner:allow -- public Hardhat test key #0
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// A deterministic all-sevens 32-byte Solana seed (not a real key) and the address it derives.
const SVM_SEED = new Uint8Array(32).fill(7); // secret-scanner:allow -- deterministic all-sevens test seed
const SVM_ADDRESS = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";
const svmSeedJson = JSON.stringify([...SVM_SEED]);
const svmSeedBase58 = getBase58Decoder().decode(SVM_SEED);

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

describe("resolveSvmSigner", () => {
    it("derives the same address from a 32-byte seed given as JSON array or base58", async () => {
        const fromJson = await resolveSvmSigner(svmSeedJson);
        const fromBase58 = await resolveSvmSigner(svmSeedBase58);

        expect(fromJson.address).toBe(SVM_ADDRESS);
        expect(fromBase58.address).toBe(SVM_ADDRESS);
    });

    it("accepts a full 64-byte secret key (seed ‖ public key)", async () => {
        // Derive the matching public key to assemble the 64-byte secret-key form.
        const seedSigner = await createKeyPairSignerFromPrivateKeyBytes(SVM_SEED, true);
        const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", seedSigner.keyPair.publicKey));
        const full = new Uint8Array(64);

        full.set(SVM_SEED, 0);
        full.set(publicKey, 32);

        const signer = await resolveSvmSigner(JSON.stringify([...full]));

        expect(signer.address).toBe(SVM_ADDRESS);
    });

    it("rejects a key that decodes to neither 32 nor 64 bytes", async () => {
        const sixteen = getBase58Decoder().decode(new Uint8Array(16).fill(3));

        await expect(resolveSvmSigner(sixteen)).rejects.toThrow(/32 or 64 bytes/);
    });

    it("rejects a value that is neither base58 nor a JSON byte array", async () => {
        await expect(resolveSvmSigner("0OIl-not-base58")).rejects.toThrow(/base58 secret key or a JSON byte array/);
    });

    it("rejects a malformed JSON byte array", async () => {
        await expect(resolveSvmSigner("[1, 2,")).rejects.toThrow(/not valid JSON/);
        await expect(resolveSvmSigner('["a", "b"]')).rejects.toThrow(/array of byte values/);
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

    it("registers the EVM exact scheme for a CDP-managed signer (get-or-create + creds wired)", async () => {
        const client = new X402Client();
        const config: X402PayConfig = { network: "base", policy: boundedPolicy, signer: { account: "agent-wallet", type: "cdp" } };

        await expect(registerWallet(client, config, { getSecret: (name) => `secret-for-${name}` })).resolves.toBeUndefined();
        expect(cdpRecorder.account).toBe("agent-wallet");
        expect(cdpRecorder.creds).toStrictEqual({
            apiKeyId: "secret-for-CDP_API_KEY_ID",
            apiKeySecret: "secret-for-CDP_API_KEY_SECRET",
            walletSecret: "secret-for-CDP_WALLET_SECRET",
        });
    });

    it("fails clearly when a CDP credential secret is unset", async () => {
        const client = new X402Client();
        const config: X402PayConfig = { network: "base", policy: boundedPolicy, signer: { account: "agent-wallet", type: "cdp" } };

        await expect(registerWallet(client, config, { getSecret: () => undefined })).rejects.toThrow(/is not set/);
    });

    it("honours custom CDP credential secret names", async () => {
        const client = new X402Client();
        const config: X402PayConfig = {
            network: "base",
            policy: boundedPolicy,
            signer: { account: "agent-wallet", apiKeyIdSecretName: "MY_ID", apiKeySecretName: "MY_SECRET", type: "cdp", walletSecretName: "MY_WALLET" },
        };

        await expect(registerWallet(client, config, { getSecret: (name) => `secret-for-${name}` })).resolves.toBeUndefined();
        expect(cdpRecorder.creds).toStrictEqual({ apiKeyId: "secret-for-MY_ID", apiKeySecret: "secret-for-MY_SECRET", walletSecret: "secret-for-MY_WALLET" });
    });

    it("registers the SVM exact scheme for a raw-key signer", async () => {
        const client = new X402Client();
        const config: X402PayConfig = { network: "solana", policy: boundedPolicy, signer: { secretName: "AGENT_KEY", type: "raw-key" } };

        await expect(registerWallet(client, config, { getSecret: () => svmSeedJson })).resolves.toBeUndefined();
    });

    it("refuses CDP-managed SVM custody, pointing at the escape hatch", async () => {
        const client = new X402Client();
        const config: X402PayConfig = { network: "solana", policy: boundedPolicy, signer: { account: "agent-wallet", type: "cdp" } };

        await expect(registerWallet(client, config, { getSecret: () => svmSeedJson })).rejects.toThrow(/CDP-managed Solana custody.*escape hatch/s);
    });

    it("registers a user-supplied EVM signer (escape hatch) without reading a secret", async () => {
        const client = new X402Client();
        const evmSigner: ClientEvmSigner = { address: TEST_ADDRESS, signTypedData: () => Promise.resolve("0x") };
        const config: X402PayConfig = { network: "base", policy: boundedPolicy, signer: { signer: evmSigner, type: "signer" } };

        // `getSecret` throws if touched — the escape hatch must not read any secret.
        await expect(
            registerWallet(client, config, {
                getSecret: () => {
                    throw new Error("must not read a secret for a user-supplied signer");
                },
            }),
        ).resolves.toBeUndefined();
    });

    it("registers a user-supplied SVM signer (escape hatch)", async () => {
        const client = new X402Client();
        const svmSigner = await createKeyPairSignerFromPrivateKeyBytes(SVM_SEED, true);
        const config: X402PayConfig = { network: "solana", policy: boundedPolicy, signer: { signer: svmSigner, type: "signer" } };

        await expect(registerWallet(client, config, { getSecret: () => undefined })).resolves.toBeUndefined();
    });

    it("refuses a user-supplied EVM signer on a Solana network (family mismatch)", async () => {
        const client = new X402Client();
        const evmSigner: ClientEvmSigner = { address: TEST_ADDRESS, signTypedData: () => Promise.resolve("0x") };
        const config: X402PayConfig = { network: "solana", policy: boundedPolicy, signer: { signer: evmSigner, type: "signer" } };

        await expect(registerWallet(client, config, { getSecret: () => undefined })).rejects.toThrow(/is an EVM.*network is Solana/s);
    });

    it("refuses a user-supplied SVM signer on an EVM network (family mismatch)", async () => {
        const client = new X402Client();
        const svmSigner = await createKeyPairSignerFromPrivateKeyBytes(SVM_SEED, true);
        const config: X402PayConfig = { network: "base", policy: boundedPolicy, signer: { signer: svmSigner, type: "signer" } };

        await expect(registerWallet(client, config, { getSecret: () => undefined })).rejects.toThrow(/is not an EVM.*network is EVM/s);
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
