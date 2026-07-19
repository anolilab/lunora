/**
 * The Lunora HTTP-action seam for the charge rail.
 *
 * `withX402` wraps a handler with the signature Lunora's `httpAction` expects —
 * `(context, request) => Response` — behind an x402 paywall, so gating an
 * endpoint is one wrapper call:
 *
 * ```ts
 * import { httpAction } from "@lunora/server";
 * import { withX402 } from "@lunora/x402/charge";
 *
 * export const report = httpAction(
 *   withX402({ network: "base", price: "$0.05", recipient: { evm: env.PAYOUT } }, async (ctx, request) => {
 *     return Response.json(await ctx.runQuery(api.reports.latest, {}));
 *   }),
 * );
 * ```
 *
 * The wrapper is generic over the context type, so it composes with any
 * `(ctx, request) => Response` handler without a runtime dependency on
 * `@lunora/server`. The middleware (which fetches facilitator support on first
 * use) is built lazily and memoised across requests; a failed initialisation is
 * not cached, so a transient facilitator outage retries on the next request.
 */
import type { X402ChargeConfig } from "../config";
import type { ChargeMiddleware } from "./middleware";
import { createChargeMiddleware } from "./middleware";

/**
 * A handler shaped like a Lunora HTTP action: `(context, request) => Response`.
 * @experimental
 */
export type HttpActionHandler<Context> = (context: Context, request: Request) => Promise<Response> | Response;

/**
 * Gate `handler` behind an x402 paywall described by `config`. Returns a handler
 * of the same shape, ready to pass to `httpAction`.
 * @experimental
 */
export const withX402 = <Context>(config: X402ChargeConfig, handler: HttpActionHandler<Context>): HttpActionHandler<Context> => {
    let pending: Promise<ChargeMiddleware> | undefined;

    return async (context: Context, request: Request): Promise<Response> => {
        pending ??= createChargeMiddleware(config).catch((error: unknown) => {
            // Don't cache a failed init — let the next request retry.
            pending = undefined;

            throw error;
        });

        const middleware = await pending;

        return middleware.handle(request, () => handler(context, request));
    };
};
