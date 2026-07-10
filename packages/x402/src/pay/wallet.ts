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
 * `KeyPairSigner` (a structural `ClientSvmSigner`/`TransactionSigner`). CDP-managed
 * custody is a recognised config shape but not yet wired on either family; it fails
 * loudly with guidance. (A CDP wallet needs `@coinbase/cdp-sdk` — `@coinbase/x402`
 * is a facilitator-auth helper, not a signer provider.)
 */
import { LunoraError } from "@lunora/errors";
import type { x402Client } from "@x402/core/client";
import type { ClientSvmSigner } from "@x402/svm";
import type { PrivateKeyAccount } from "viem/accounts";

import type { X402PayConfig } from "../config";
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

/** How the wallet reads its key material — wired to `ctx.secrets.get` in an action. */
export interface WalletDeps {
    /** Read a secret (e.g. a private key) by name; `undefined` when unset. */
    readonly getSecret: GetSecret;
}

/**
 * Resolve a viem `LocalAccount` from a raw private key. The key may be given with
 * or without the `0x` prefix. The account is a structural `ClientEvmSigner`
 * (`address` + `signTypedData`), so `@x402/evm` accepts it directly.
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
 * the resolved agent signer. Dispatches on network family (EVM vs SVM) and on the
 * configured signer custody (raw key vs CDP). Unwired custodies throw a
 * `NOT_IMPLEMENTED` error rather than silently registering nothing.
 */
export const registerWallet = async (client: x402Client, config: X402PayConfig, deps: WalletDeps): Promise<void> => {
    const network = toCaip2(config.network);
    const { signer } = config;

    if (isEvmNetwork(config.network)) {
        if (signer.type === "cdp") {
            throw new LunoraError(
                "NOT_IMPLEMENTED",
                `x402 pay: CDP-managed EVM custody (account "${signer.account}") is not wired yet — it needs @coinbase/cdp-sdk. Use a "raw-key" signer for now.`,
            );
        }

        const account = await resolveEvmAccount(await requireSecret(deps.getSecret, signer.secretName));
        const { registerExactEvmScheme } = await import("@x402/evm/exact/client");

        registerExactEvmScheme(client, { networks: [network], signer: account });

        return;
    }

    // SVM (Solana). Raw-key custody is wired; CDP-managed custody is not yet.
    if (signer.type === "cdp") {
        throw new LunoraError(
            "NOT_IMPLEMENTED",
            `x402 pay: CDP-managed Solana custody (account "${signer.account}") is not wired yet — it needs @coinbase/cdp-sdk. Use a "raw-key" signer for now.`,
        );
    }

    const svmSigner = await resolveSvmSigner(await requireSecret(deps.getSecret, signer.secretName));
    const { registerExactSvmScheme } = await import("@x402/svm/exact/client");

    registerExactSvmScheme(client, { networks: [network], signer: svmSigner });
};
