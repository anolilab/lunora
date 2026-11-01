/**
 * Facilitator wiring shared by both rails.
 *
 * A **facilitator** is the third party that actually talks to the chain: it
 * `/verify`s a signed `PAYMENT-SIGNATURE` payload and `/settle`s it on-chain, so neither
 * the seller (charge rail) nor the buyer (pay rail) needs an RPC node or a
 * settlement key of its own. A facilitator must be configured explicitly — there
 * is no default. CDP's hosted facilitator authenticates per request via a bearer
 * token (see {@link FacilitatorConfig}); note the CDP bearer JWT expires after
 * about 2 minutes and the client does not refresh `headers`, so a long-running
 * server must refresh the token and rebuild the client on expiry.
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
 * client throws (fail loud) — a facilitator URL is required; see
 * {@link resolveFacilitatorUrl}.
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
