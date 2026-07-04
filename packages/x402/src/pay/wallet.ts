/**
 * Agent-wallet resolution for the pay rail.
 *
 * A wallet holds spending authority, so this module lives behind the pay rail's
 * `ActionCtx`-only surface and reads its key material through {@link WalletDeps}
 * (wired to `ctx.secrets.get` at the call site) — a private key is a secret, never
 * a plain var. The right scheme family is registered on the client by the
 * configured network: `@x402/evm` (viem) for `eip155:*`, `@x402/svm` for Solana.
 *
 * Custody status today. EVM raw-key is fully wired: a `ctx.secrets` private key
 * becomes a viem `LocalAccount`, which satisfies `@x402/evm`'s structural
 * `ClientEvmSigner`. SVM raw-key and CDP-managed custody are recognised config
 * shapes but not yet wired here; both fail loudly with guidance. (A CDP wallet
 * needs `@coinbase/cdp-sdk` — `@coinbase/x402` is a facilitator-auth helper, not a
 * signer provider.)
 */
import { LunoraError } from "@lunora/errors";
import type { x402Client } from "@x402/core/client";
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

    // SVM (Solana). Pay-side custody is not wired yet — the SVM charge rail works.
    const detail = signer.type === "cdp" ? `CDP account "${signer.account}"` : `raw key "${signer.secretName}"`;

    throw new LunoraError(
        "NOT_IMPLEMENTED",
        `x402 pay: Solana (SVM) wallet custody (${detail}) is not wired yet. The SVM charge rail works today; SVM pay is coming.`,
    );
};
