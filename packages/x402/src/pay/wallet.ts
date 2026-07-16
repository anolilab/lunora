/**
 * Agent-wallet resolution for the pay rail.
 *
 * A wallet holds spending authority, so this module lives behind the pay rail's
 * `ActionCtx`-only surface and reads its key material through {@link WalletDeps}
 * (wired to `ctx.secrets.get` at the call site) — a private key is a secret, never
 * a plain var. The right scheme family is registered on the client by the
 * configured network: `@x402/evm` (viem) for `eip155:*`, `@x402/svm` for Solana.
 *
 * Custody status today. Raw-key custody is fully wired on both families. On EVM a
 * `ctx.secrets` private key becomes a viem `LocalAccount` (a structural
 * `ClientEvmSigner`); on SVM a `ctx.secrets` secret key becomes a `@solana/kit`
 * `KeyPairSigner` (a structural `ClientSvmSigner`/`TransactionSigner`). The
 * `"signer"` escape hatch lets a caller hand in a signer they built themselves —
 * any custody provider (Turnkey, Privy, an AWS/GCP KMS `toAccount`, CDP's viem
 * adapter, …) adapted to the structural EVM/SVM signer — so `@lunora/x402` needs
 * no per-provider SDK. CDP-managed custody is wired on EVM via the optional
 * `@coinbase/cdp-sdk` peer: the SDK gets-or-creates a named server account and
 * signs the x402 EIP-712 authorization with it, so the key never leaves Coinbase.
 * CDP on Solana is not yet wired (the CDP Solana account is not a `@solana/kit`
 * signer); it fails loudly, pointing at the escape hatch. (`@coinbase/x402` is a
 * facilitator-auth helper, not a signer provider — CDP custody is `@coinbase/cdp-sdk`.)
 */
import { LunoraError } from "@lunora/errors";
import type { x402Client } from "@x402/core/client";
import type { ClientEvmSigner } from "@x402/evm";
import type { ClientSvmSigner } from "@x402/svm";
import type { PrivateKeyAccount } from "viem/accounts";

import type { X402CdpSignerConfig, X402PayConfig } from "../config";
import { isEvmNetwork, toCaip2 } from "../networks";

/** Reads a secret by name; resolves `undefined` when unset. */
type GetSecret = (name: string) => Promise<string | undefined> | string | undefined;

/** A 32-byte hex private key (64 hex chars), with the `0x` prefix normalised on. */
const HEX_PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

/** Read a required secret, failing with a clear error when it is missing. */
const requireSecret = async (getSecret: GetSecret, name: string): Promise<string> => {
    const value = await getSecret(name);

    if (value === undefined || value.length === 0) {
        throw new LunoraError("ENV_INVALID", `x402 pay: secret "${name}" is not set — the agent wallet has no key to sign with.`);
    }

    return value;
};

/**
 * Guard a user-supplied signer against the network family. An EVM signer's
 * `address` is `0x…`; an SVM signer's is base58. A family mismatch is a config
 * error we catch here — with a clear message — rather than letting it surface as
 * an opaque scheme failure deep inside `@x402/*`.
 */
const assertSignerFamily = (signer: ClientEvmSigner | ClientSvmSigner, evm: boolean): void => {
    const looksEvm = signer.address.startsWith("0x");

    if (evm && !looksEvm) {
        throw new LunoraError("ENV_INVALID", `x402 pay: the supplied signer address "${signer.address}" is not an EVM (0x…) address, but the network is EVM.`);
    }

    if (!evm && looksEvm) {
        throw new LunoraError("ENV_INVALID", `x402 pay: the supplied signer address "${signer.address}" is an EVM (0x…) address, but the network is Solana.`);
    }
};

/**
 * Resolve a CDP-managed EVM server account as a `ClientEvmSigner`. Reads the three
 * CDP credentials from `ctx.secrets` (names default to the SDK's own env vars),
 * constructs the client, and gets-or-creates the named account. The account signs
 * the x402 EIP-712 authorization directly, so the key never leaves Coinbase. Needs
 * the optional `@coinbase/cdp-sdk` peer installed — a clear error says so if not.
 */
const resolveCdpEvmAccount = async (signer: X402CdpSignerConfig, getSecret: GetSecret): Promise<ClientEvmSigner> => {
    // Load the optional peer first: if it is missing, a "not installed" error is
    // far more actionable than a "secret not set" one for the same misconfig.
    let cdpModule: typeof import("@coinbase/cdp-sdk");

    try {
        cdpModule = await import("@coinbase/cdp-sdk");
    } catch {
        throw new LunoraError(
            "ENV_INVALID",
            'x402 pay: CDP-managed custody needs the optional @coinbase/cdp-sdk peer — install it, or use "raw-key"/"signer" custody instead.',
        );
    }

    const [apiKeyId, apiKeySecret, walletSecret] = await Promise.all([
        requireSecret(getSecret, signer.apiKeyIdSecretName ?? "CDP_API_KEY_ID"),
        requireSecret(getSecret, signer.apiKeySecretName ?? "CDP_API_KEY_SECRET"),
        requireSecret(getSecret, signer.walletSecretName ?? "CDP_WALLET_SECRET"),
    ]);

    const cdp = new cdpModule.CdpClient({ apiKeyId, apiKeySecret, walletSecret });

    return cdp.evm.getOrCreateAccount({ name: signer.account });
};

/**
 * How the wallet reads its key material — wired to `ctx.secrets.get` in an action.
 * @experimental
 */
export interface WalletDeps {
    /** Read a secret (e.g. a private key) by name; `undefined` when unset. */
    readonly getSecret: GetSecret;
}

/**
 * Resolve a viem `LocalAccount` from a raw private key. The key may be given with
 * or without the `0x` prefix. The account is a structural `ClientEvmSigner`
 * (`address` + `signTypedData`), so `@x402/evm` accepts it directly.
 * @experimental
 */
export const resolveEvmAccount = async (privateKey: string): Promise<PrivateKeyAccount> => {
    const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;

    if (!HEX_PRIVATE_KEY.test(key)) {
        throw new LunoraError("ENV_INVALID", "x402 pay: the EVM wallet key must be a 32-byte hex private key (64 hex chars, optional 0x prefix).");
    }

    const { privateKeyToAccount } = await import("viem/accounts");

    return privateKeyToAccount(key as `0x${string}`);
};

/**
 * Resolve a `@solana/kit` `KeyPairSigner` from a raw Solana secret key. The secret
 * may be given as a JSON byte array (`[12,34,…]`, the `solana-keygen` keyfile
 * format) or as a base58 string. A 64-byte value is a full secret key (seed ‖
 * public key); a 32-byte value is the seed alone. The returned signer is a
 * structural `ClientSvmSigner` (`TransactionSigner`), so `@x402/svm` accepts it.
 * @experimental
 */
export const resolveSvmSigner = async (secret: string): Promise<ClientSvmSigner> => {
    const trimmed = secret.trim();
    const { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes, getBase58Encoder } = await import("@solana/kit");

    let bytes: Uint8Array;

    if (trimmed.startsWith("[")) {
        // `solana-keygen` keyfile format: a JSON array of byte values.
        let parsed: unknown;

        try {
            parsed = JSON.parse(trimmed);
        } catch {
            throw new LunoraError("ENV_INVALID", "x402 pay: the Solana wallet key looks like a JSON byte array but is not valid JSON.");
        }

        if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "number")) {
            throw new LunoraError("ENV_INVALID", "x402 pay: the Solana wallet key JSON must be an array of byte values.");
        }

        bytes = Uint8Array.from(parsed as number[]);
    } else {
        try {
            bytes = Uint8Array.from(getBase58Encoder().encode(trimmed));
        } catch {
            throw new LunoraError("ENV_INVALID", "x402 pay: the Solana wallet key must be a base58 secret key or a JSON byte array.");
        }
    }

    if (bytes.length === 64) {
        return createKeyPairSignerFromBytes(bytes);
    }

    if (bytes.length === 32) {
        return createKeyPairSignerFromPrivateKeyBytes(bytes);
    }

    throw new LunoraError(
        "ENV_INVALID",
        `x402 pay: the Solana wallet key must decode to 32 or 64 bytes (got ${String(bytes.length)}). Provide a base58 secret key or a JSON byte array.`,
    );
};

/**
 * Register the scheme family the configured network needs on `client`, wired to
 * the agent signer. Dispatches on network family (EVM vs SVM) and on custody —
 * `"signer"` (a signer the caller already built; registered directly, no secret
 * read), `"raw-key"` (a `ctx.secrets` private key → viem account on EVM or a
 * `@solana/kit` keypair on SVM), or `"cdp"` (a Coinbase-managed wallet via
 * `@coinbase/cdp-sdk`).
 * @experimental
 */
export const registerWallet = async (client: x402Client, config: X402PayConfig, deps: WalletDeps): Promise<void> => {
    const network = toCaip2(config.network);
    const { signer } = config;
    const evm = isEvmNetwork(config.network);

    // Phase 1 — custody: resolve a concrete signer for the network family. The
    // escape hatch returns the caller's signer with no `ctx.secrets` read; raw-key
    // and CDP resolve one from secrets; CDP-on-Solana is not wired.
    let account: ClientEvmSigner | ClientSvmSigner;

    if (signer.type === "signer") {
        assertSignerFamily(signer.signer, evm);
        account = signer.signer;
    } else if (signer.type === "cdp") {
        if (!evm) {
            throw new LunoraError(
                "NOT_IMPLEMENTED",
                `x402 pay: CDP-managed Solana custody (account "${signer.account}") is not wired — a CDP Solana account is not a @solana/kit signer. Build a @solana/kit signer around it and pass it via the { type: "signer" } escape hatch, or use "raw-key".`,
            );
        }

        account = await resolveCdpEvmAccount(signer, deps.getSecret);
    } else {
        const secret = await requireSecret(deps.getSecret, signer.secretName);

        account = evm ? await resolveEvmAccount(secret) : await resolveSvmSigner(secret);
    }

    // Phase 2 — scheme: register the family's exact scheme with the resolved
    // signer. Written once per family; the family guard above keeps the cast safe.
    if (evm) {
        const { registerExactEvmScheme } = await import("@x402/evm/exact/client");

        registerExactEvmScheme(client, { networks: [network], signer: account as ClientEvmSigner });
    } else {
        const { registerExactSvmScheme } = await import("@x402/svm/exact/client");

        registerExactSvmScheme(client, { networks: [network], signer: account as ClientSvmSigner });
    }
};
