/**
 * `@lunora/x402/pay` — the pay rail (client / agent side, ActionCtx-only).
 *
 * A Lunora **action** (the only ctx with outbound network + secret access) pays
 * for a `402`-gated resource: it holds a wallet, signs an `X-PAYMENT`, and
 * retries — all bounded by a **mandatory** spend policy. Because the signer holds
 * spending authority, an unbounded policy is refused before a signer is resolved.
 *
 * `createX402Pay(config, deps)` is the entry point; it returns a payment-enabled
 * `fetch`. The wallet is resolved from `deps.getSecret` (wire it to
 * `ctx.secrets.get`).
 *
 * ```ts
 * const pay = await createX402Pay(
 *   { network: "base", signer: { type: "raw-key", secretName: "AGENT_WALLET_KEY" }, policy: { maxPerCall: "$0.10", maxPerRun: "$5.00" } },
 *   { getSecret: (name) => ctx.secrets.get(name) },
 * );
 * const res = await pay.fetch("https://api.example/paid-report");
 * ```
 */
import type { X402PayConfig } from "../config";
import type { PayFetch, X402PayDeps } from "./fetch";
import { createPayFetch } from "./fetch";

export type { X402CdpSignerConfig, X402PayConfig, X402Price, X402SignerConfig } from "../config";
export { DEFAULT_FACILITATOR_URL, resolveFacilitatorUrl } from "../config";
export type { Caip2, X402Network } from "../networks";
export { isEvmNetwork, isSvmNetwork, toCaip2 } from "../networks";
export type { PayFetch, X402PayDeps } from "./fetch";
export { createPayFetch } from "./fetch";
export type { SpendPolicy, SpendState } from "./policy";
export {
    assertBoundedPolicy,
    buildPaymentGuard,
    buildSpendPolicy,
    createSpendState,
    DEFAULT_STABLECOIN_DECIMALS,
    releaseSpendOnFailure,
    usdToAtomic,
} from "./policy";
export type { WalletDeps } from "./wallet";
export { registerWallet, resolveEvmAccount, resolveSvmSigner } from "./wallet";

/**
 * A configured pay rail: a payment-enabled `fetch` bounded by the spend policy.
 * @experimental
 */
export interface X402Pay {
    /** A `fetch` that transparently pays for `402`-gated resources under the policy. */
    readonly fetch: PayFetch;
}

/**
 * Build a pay rail for `config`. The returned `fetch` answers `402` challenges by
 * signing and retrying, within `config.policy`. Throws (before touching the
 * signer) when the policy is unbounded.
 * @experimental
 */
export const createX402Pay = async (config: X402PayConfig, deps: X402PayDeps): Promise<X402Pay> => {
    const fetch = await createPayFetch(config, deps);

    return { fetch };
};

/**
 * A synchronous, lazily-initialised pay rail — what codegen wires `ctx.x402` to.
 *
 * `buildCtx` must stay synchronous, but {@link createX402Pay} is async (it reads
 * the wallet secret and imports the signer). So this returns an {@link X402Pay}
 * immediately whose `fetch` builds the real rail on its **first** call and
 * memoises it: the viem/`@x402` signer imports + Secrets Store read are paid for
 * only when an action actually pays, and the single `SpendState` behind the
 * rail is shared across every payment for the lifetime of this ctx — so the
 * per-run cap scopes to the ctx, not to each request. A failed build (e.g. an
 * unbounded policy) is memoised too, keeping the rail deterministically
 * fail-closed.
 * @experimental
 */
export const lazyX402Pay = (config: X402PayConfig, deps: X402PayDeps): X402Pay => {
    let railPromise: Promise<X402Pay> | undefined;

    const fetch: PayFetch = async (input, init) => {
        railPromise ??= createX402Pay(config, deps);

        const rail = await railPromise;

        return rail.fetch(input, init);
    };

    return { fetch };
};
