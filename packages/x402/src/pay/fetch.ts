/**
 * The pay-rail fetch builder: turns an {@link X402PayConfig} into a
 * payment-enabled `fetch` that transparently answers `402 Payment Required` by
 * signing an `X-PAYMENT` and retrying — all under the wallet's spend policy.
 *
 * Wiring order matters and is deliberately fail-closed. First
 * {@link assertBoundedPolicy} refuses an unbounded policy before a signer is ever
 * resolved or held. Then {@link registerWallet} resolves the agent signer and
 * registers the scheme. Then `registerPolicy(buildSpendPolicy(...))` narrows the
 * offered requirements to the payable ones (per-call cap + allowlists). Finally
 * `onBeforePaymentCreation` enforces the stateful per-run cap and confirmation
 * gate, reserving the amount atomically as soon as it passes (the reservation
 * itself is the record — there is no separate after-hook), and
 * `onPaymentCreationFailure` releases that reservation if the signature itself
 * later fails.
 */
import { x402Client as X402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";

import type { X402PayConfig } from "../config";
import { assertBoundedPolicy, buildPaymentGuard, buildSpendPolicy, createSpendState, releaseSpendOnFailure } from "./policy";
import type { WalletDeps } from "./wallet";
import { registerWallet } from "./wallet";

/**
 * A payment-enabled `fetch`: same signature as the platform `fetch`.
 * @experimental
 */
export type PayFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * Dependencies for building a pay-rail fetch: secret access, plus an optional base `fetch` to wrap.
 * @experimental
 */
export interface X402PayDeps extends WalletDeps {
    /** The `fetch` to wrap (defaults to `globalThis.fetch`). Inject to test or to chain transports. */
    readonly fetch?: typeof globalThis.fetch;
}

/**
 * Build a payment-enabled `fetch` for `config`. Throws (before resolving a
 * signer) when `config.policy` is unbounded — an agent wallet is never built
 * with unlimited spend authority.
 * @experimental
 */
export const createPayFetch = async (config: X402PayConfig, deps: X402PayDeps): Promise<PayFetch> => {
    assertBoundedPolicy(config.policy);

    const client = new X402Client();

    await registerWallet(client, config, deps);

    const state = createSpendState();

    client.registerPolicy(buildSpendPolicy(config.policy));
    client.onBeforePaymentCreation(buildPaymentGuard(config.policy, state));
    client.onPaymentCreationFailure(releaseSpendOnFailure(state));

    return wrapFetchWithPayment(deps.fetch ?? globalThis.fetch, client);
};
