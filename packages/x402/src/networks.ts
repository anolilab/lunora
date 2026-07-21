/**
 * Network identity for `@lunora/x402`.
 *
 * `@x402/core` v2 speaks **CAIP-2** chain ids (`eip155:8453` for Base,
 * `solana:5eyk…` for Solana mainnet) — `type Network = ` `${string}:${string}` ``.
 * Lunora keeps ergonomic **friendly** names (`"base"`, `"base-sepolia"`) as the
 * public surface and maps them to CAIP-2 here, at the single seam where we hand a
 * network to the SDK. A raw CAIP-2 string is also accepted as a power-user escape
 * hatch (e.g. a chain we don't yet have a friendly alias for).
 *
 * The friendly set is intentionally scoped to chains `@x402/evm` / `@x402/svm`
 * can settle the ergonomic `price:"$0.01"` path on out of the box (i.e. chains in
 * their `DEFAULT_STABLECOINS` registry). Notably that excludes Optimism and
 * Avalanche today — advertising them would 500 at settlement — so they are not
 * friendly aliases; a caller who needs them can still pass a raw CAIP-2 id with an
 * explicit asset.
 */

/* eslint-disable import/exports-last, no-void, sonarjs/void-use -- a data + types module: public types sit next to the consts they describe, and each const's shape is checked with a standalone `void (… satisfies …)` (an inline `as const satisfies` breaks isolatedDeclarations, TS9010). */

/**
 * A CAIP-2 chain identifier, e.g. `"eip155:8453"` (Base) or `"solana:5eyk…"`.
 * @experimental
 */
export type Caip2 = `${string}:${string}`;

/**
 * Friendly network names Lunora maps to CAIP-2 for `@x402/core`.
 * @experimental
 */
export type FriendlyNetwork = "arbitrum" | "arbitrum-sepolia" | "base" | "base-sepolia" | "ethereum" | "polygon" | "solana" | "solana-devnet";

/**
 * A network Lunora can settle on: a {@link FriendlyNetwork} alias (mapped to
 * CAIP-2 internally) or a raw {@link Caip2} id for chains without a friendly name.
 * @experimental
 */
export type X402Network = Caip2 | FriendlyNetwork;

/**
 * Friendly name → CAIP-2 id. Values verified against `@x402/evm` and `@x402/svm`
 * `DEFAULT_STABLECOINS` at 2.17.0. `base` / `base-sepolia` are the primary
 * prod / test pair.
 * @experimental
 */
export const NETWORK_TO_CAIP2 = {
    arbitrum: "eip155:42161",
    "arbitrum-sepolia": "eip155:421614",
    base: "eip155:8453",
    "base-sepolia": "eip155:84532",
    ethereum: "eip155:1",
    polygon: "eip155:137",
    solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "solana-devnet": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
} as const;

// `isolatedDeclarations` (oxc `.d.ts` emit) rejects an inline `as const satisfies …`, so the
// exported consts keep `as const` (preserving their literal types) and validate their shape with a
// standalone `satisfies` here. Don't fold these back into `as const satisfies` — it reintroduces TS9010.
void (NETWORK_TO_CAIP2 satisfies Record<FriendlyNetwork, Caip2>);

/**
 * EVM friendly networks (signed via `@x402/evm` + viem).
 * @experimental
 */
export const EVM_NETWORKS = ["arbitrum", "arbitrum-sepolia", "base", "base-sepolia", "ethereum", "polygon"] as const;

void (EVM_NETWORKS satisfies ReadonlyArray<FriendlyNetwork>);

/**
 * Solana friendly networks (signed via `@x402/svm`).
 * @experimental
 */
export const SVM_NETWORKS = ["solana", "solana-devnet"] as const;

void (SVM_NETWORKS satisfies ReadonlyArray<FriendlyNetwork>);

/**
 * Resolve a network to its CAIP-2 id. Friendly aliases are looked up; a value
 * that already looks like CAIP-2 (`namespace:reference`) passes through.
 * @experimental
 */
export const toCaip2 = (network: X402Network): Caip2 => {
    const mapped = (NETWORK_TO_CAIP2 as Record<string, Caip2>)[network];

    if (mapped !== undefined) {
        return mapped;
    }

    if (network.includes(":")) {
        return network as Caip2;
    }

    throw new Error(`Unknown x402 network "${network}". Use a friendly name (${EVM_NETWORKS.join(", ")}, ${SVM_NETWORKS.join(", ")}) or a raw CAIP-2 id.`);
};

/**
 * True when `network` settles on an EVM chain (viem signer path).
 * @experimental
 */
export const isEvmNetwork = (network: X402Network): boolean => toCaip2(network).startsWith("eip155:");

/**
 * True when `network` settles on Solana (`@x402/svm` signer path).
 * @experimental
 */
export const isSvmNetwork = (network: X402Network): boolean => toCaip2(network).startsWith("solana:");
