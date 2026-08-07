/**
 * The per-procedure charge gate — the seam `@lunora/runtime` injects to paywall
 * a `.x402({ price })`-tagged query/mutation/action at the origin worker.
 *
 * `@lunora/runtime` must not import `@lunora/x402` (it would pull viem/solana
 * into every worker bundle), so the runtime declares a structural gate type and
 * the host wires this factory in. The gate runs the same four-step x402 flow as
 * the HTTP-action rail ({@link createChargeMiddleware}) — challenge / verify /
 * dispatch / settle — but keyed per procedure: each function bakes its own price
 * (from `.x402({ price })`) and its `functionPath` as the challenge `resource`.
 *
 * ```ts
 * import { createProcedureChargeGate } from "@lunora/x402/charge";
 *
 * const gate = createProcedureChargeGate({ network: "base", recipient: { evm: env.PAYOUT } });
 * // handed to createWorker({ x402Charge: gate })
 * ```
 */
import type { X402ChargeConfig, X402Price } from "../config";
import type { ChargeHandlerDeps, ChargeMiddleware } from "./middleware";
import { createChargeMiddleware } from "./middleware";

/**
 * Charge config for the procedure gate: the worker-level settlement vocabulary
 * (network, recipient, facilitator) minus `price` — price is per-procedure and
 * arrives with each {@link X402ProcedureSpec}.
 * @experimental
 */
export type X402ProcedureChargeConfig = Omit<X402ChargeConfig, "price">;

/**
 * The per-RPC charge spec the runtime passes the gate for each paid dispatch.
 * @experimental
 */
export interface X402ProcedureSpec {
    /** The `file:function` id of the paid procedure; becomes the x402 challenge `resource`. */
    readonly functionPath: string;
    /** USD price declared by the procedure's `.x402({ price })` modifier. */
    readonly price: X402Price;
}

/**
 * Gate one paid RPC. Returns a real `402` + `PAYMENT-REQUIRED` challenge when the
 * request is unpaid, or the dispatched response (with `X-PAYMENT-RESPONSE`
 * attached) once the client's `X-PAYMENT` is verified and settled. `dispatch`
 * runs the actual shard forward — settlement happens **before** `dispatch` is
 * invoked (settle-first), so a settlement failure means the shard forward
 * (the mutation's commit) never runs at all — no committed-but-unpaid write is
 * possible. `deps.waitUntil`, when supplied (the request's `ctx.waitUntil`),
 * keeps the opt-in receipt sink alive past the response.
 * @experimental
 */
export type X402ProcedureChargeGate = (
    request: Request,
    spec: X402ProcedureSpec,
    dispatch: () => Promise<Response>,
    deps?: ChargeHandlerDeps,
) => Promise<Response>;

/**
 * Build the injectable procedure charge gate for `config`. One initialised
 * {@link ChargeMiddleware} is memoised per `functionPath` (each bakes that
 * function's price + `resource`), since `createChargeMiddleware` fetches
 * facilitator support on first use. A failed init is not cached, so a transient
 * facilitator outage retries on the next request. Settlement runs before
 * `dispatch` (the `settleBeforeHandler` default) since `dispatch` commits the
 * procedure's real mutation — see `createChargeMiddleware`'s `ChargeMiddlewareOptions`.
 * @experimental
 */
export const createProcedureChargeGate = (config: X402ProcedureChargeConfig): X402ProcedureChargeGate => {
    const middlewareByFunction = new Map<string, Promise<ChargeMiddleware>>();

    return async (request: Request, spec: X402ProcedureSpec, dispatch: () => Promise<Response>, deps?: ChargeHandlerDeps): Promise<Response> => {
        let pending = middlewareByFunction.get(spec.functionPath);

        if (pending === undefined) {
            pending = createChargeMiddleware({ ...config, price: spec.price }, { resource: spec.functionPath }).catch((error: unknown) => {
                // Don't cache a failed init — let the next request retry.
                middlewareByFunction.delete(spec.functionPath);

                throw error;
            });
            middlewareByFunction.set(spec.functionPath, pending);
        }

        const middleware = await pending;

        return middleware.handle(request, dispatch, deps);
    };
};
