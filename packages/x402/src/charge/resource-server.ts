/**
 * Builds the `@x402/core` resource server for the charge rail: a facilitator
 * client plus the one scheme family the configured network needs.
 *
 * The EVM (`@x402/evm`, viem) and SVM (`@x402/svm`, `@solana/kit`) scheme
 * modules are `import()`-ed lazily so an EVM-only deployment never pulls Solana's
 * (heavy) toolchain into its bundle — we register exactly the family
 * {@link X402ChargeConfig.network} resolves to.
 */
import { LunoraError } from "@lunora/errors";
import type { x402ResourceServer } from "@x402/core/server";

import type { X402ChargeConfig } from "../config";
import { createFacilitatorClient } from "../facilitator";
import { isEvmNetwork, toCaip2 } from "../networks";

/**
 * Construct and initialise the resource server for `config`. Registers the exact
 * scheme for the configured network's family (EVM or SVM) scoped to that one
 * CAIP-2 network, wired to `config.facilitator` (or the public default).
 */
export const buildResourceServer = async (config: X402ChargeConfig): Promise<x402ResourceServer> => {
    const { x402ResourceServer: ResourceServer } = await import("@x402/core/server");

    const server = new ResourceServer(createFacilitatorClient(config.facilitator));
    const network = toCaip2(config.network);

    if (isEvmNetwork(config.network)) {
        let evmModule: typeof import("@x402/evm/exact/server");

        try {
            evmModule = await import("@x402/evm/exact/server");
        } catch {
            throw new LunoraError(
                "ENV_INVALID",
                "x402 charge: EVM networks need the optional @x402/evm + viem peers — install them, or configure an SVM network.",
            );
        }

        evmModule.registerExactEvmScheme(server, { networks: [network] });
    } else {
        let svmModule: typeof import("@x402/svm/exact/server");

        try {
            svmModule = await import("@x402/svm/exact/server");
        } catch {
            throw new LunoraError(
                "ENV_INVALID",
                "x402 charge: SVM networks need the optional @x402/svm + @solana/kit peers — install them, or configure an EVM network.",
            );
        }

        svmModule.registerExactSvmScheme(server, { networks: [network] });
    }

    return server;
};
