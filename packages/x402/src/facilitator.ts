/**
 * Facilitator wiring shared by both rails.
 *
 * A **facilitator** is the third party that actually talks to the chain: it
 * `/verify`s a signed `X-PAYMENT` payload and `/settle`s it on-chain, so neither
 * the seller (charge rail) nor the buyer (pay rail) needs an RPC node or a
 * settlement key of its own. The public `x402.org/facilitator` needs no auth; a
 * private / CDP facilitator authenticates per request.
 */
import { HTTPFacilitatorClient } from "@x402/core/server";

import type { FacilitatorConfig } from "./config";
import { resolveFacilitatorUrl } from "./config";

/**
 * Build an `@x402/core` facilitator client from Lunora's {@link FacilitatorConfig}.
 *
 * `config.headers` (e.g. a CDP bearer token) are applied to every facilitator
 * call — `@x402/core` splits auth per endpoint (`verify` / `settle` /
 * `supported`), so the same header map is handed to each. With no config the
 * client points at the public {@link resolveFacilitatorUrl default} and sends no
 * auth headers.
 * @experimental
 */
export const createFacilitatorClient = (config?: FacilitatorConfig): HTTPFacilitatorClient => {
    const url = resolveFacilitatorUrl(config);

    if (config?.headers === undefined) {
        return new HTTPFacilitatorClient({ url });
    }

    // Copy into a fresh, mutable record — `@x402/core` reads it directly and our
    // config field is `readonly`. Snapshot once here rather than per call.
    const headers = { ...config.headers };

    return new HTTPFacilitatorClient({
        createAuthHeaders: () => Promise.resolve({ settle: headers, supported: headers, verify: headers }),
        url,
    });
};
