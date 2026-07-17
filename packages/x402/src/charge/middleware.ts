/**
 * The charge-rail request middleware: the framework-agnostic x402 flow over a
 * Fetch `Request` / `Response`.
 *
 * For each request it runs the four-step protocol — match the route, challenge
 * (`402` + `PAYMENT-REQUIRED`) when unpaid, verify the client's `X-PAYMENT`
 * payload with the facilitator, run the resource handler, then settle on-chain
 * and attach `X-PAYMENT-RESPONSE`. Any Lunora HTTP surface (HTTP actions today,
 * procedures and MCP tools later) wraps its handler with this.
 */
import type { HTTPAdapter, HTTPRequestContext, HTTPResponseInstructions, PaymentOption, ProcessSettleSuccessResponse, RouteConfig } from "@x402/core/http";
import { x402HTTPResourceServer as X402HTTPResourceServer } from "@x402/core/http";

import type { X402ChargeConfig } from "../config";
import { isEvmNetwork, toCaip2 } from "../networks";
import type { X402ReceiptSink } from "./receipt";
import { toReceipt } from "./receipt";
import { buildResourceServer } from "./resource-server";

/** The x402 request header carrying the client's signed payment payload. */
const PAYMENT_HEADER = "X-PAYMENT";

/** Snapshot a `Headers` into a plain record (for the settlement transport context). */
const headerRecord = (headers: Headers): Record<string, string> => {
    // Prototype-less so a header literally named `__proto__`/`constructor` is
    // stored as a plain data key instead of tripping the prototype setter.
    const record: Record<string, string> = Object.create(null) as Record<string, string>;

    for (const [key, value] of headers) {
        record[key] = value;
    }

    return record;
};

/**
 * Fire the opt-in receipt sink for a settled payment. Best-effort telemetry: the
 * payment already settled, so a sink failure must never withhold the paid
 * resource — a synchronous throw and a rejected promise are both swallowed, and
 * the sink is not awaited into the response path.
 */
export const reportReceipt = (sink: X402ReceiptSink | undefined, settlement: ProcessSettleSuccessResponse, resource: string): void => {
    if (sink === undefined) {
        return;
    }

    try {
        // A `.catch()`-terminated chain handles an async sink's rejection without
        // awaiting it (which would block the paid response).
        Promise.resolve(sink(toReceipt(settlement, { resource, ts: Date.now() }))).catch(() => {
            // best-effort: a reporting failure must not affect the paid response.
        });
    } catch {
        // a synchronous sink throw is likewise swallowed.
    }
};

/**
 * Runs the protected resource handler, producing the Response to gate.
 * @experimental
 */
export type ChargeHandler = () => Promise<Response> | Response;

/**
 * A prepared, initialised paywall. Build once (it fetches facilitator support), reuse per request.
 * @experimental
 */
export interface ChargeMiddleware {
    /** Gate `request`: challenge / verify / settle around `runHandler`. */
    handle: (request: Request, runHandler: ChargeHandler) => Promise<Response>;
}

/**
 * The payout address for `config`'s network family. Throws a clear config error
 * when the matching `recipient.evm` / `recipient.svm` is missing — a paywall
 * with nowhere to settle must fail loudly at setup, not silently drop funds.
 */
export const resolvePayTo = (config: X402ChargeConfig): string => {
    const evm = isEvmNetwork(config.network);
    const address = evm ? config.recipient.evm : config.recipient.svm;

    if (address === undefined || address.length === 0) {
        throw new Error(`x402 charge on "${config.network}" needs recipient.${evm ? "evm" : "svm"} set.`);
    }

    return address;
};

/** The single, catch-all route (`accepts` present → gates every request). */
export const buildRoute = (config: X402ChargeConfig): RouteConfig => {
    const accepts: PaymentOption = {
        network: toCaip2(config.network),
        payTo: resolvePayTo(config),
        price: config.price,
        scheme: "exact",
    };

    return { accepts };
};

/** A framework-agnostic {@link HTTPAdapter} backed by a Fetch `Request`. */
export const createRequestAdapter = (request: Request, url: URL): HTTPAdapter => {
    return {
        getAcceptHeader: () => request.headers.get("accept") ?? "",
        getHeader: (name) => request.headers.get(name) ?? undefined,
        getMethod: () => request.method,
        getPath: () => url.pathname,
        getQueryParam: (name) => {
            const values = url.searchParams.getAll(name);

            if (values.length === 0) {
                return undefined;
            }

            return values.length === 1 ? values[0] : values;
        },
        getQueryParams: () => {
            // Prototype-less so an attacker-supplied `?__proto__=…` query key is
            // stored as a plain data field, never the prototype setter.
            const params: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;

            for (const key of new Set(url.searchParams.keys())) {
                const values = url.searchParams.getAll(key);
                const [first, ...rest] = values;

                if (first === undefined) {
                    continue;
                }

                params[key] = rest.length > 0 ? values : first;
            }

            return params;
        },
        getUrl: () => request.url,
        getUserAgent: () => request.headers.get("user-agent") ?? "",
    };
};

/** Render x402's framework-neutral response instructions into a Fetch `Response`. */
export const toResponse = (instructions: HTTPResponseInstructions): Response => {
    const headers = new Headers(instructions.headers);
    const { body } = instructions;

    if (body === undefined || body === null) {
        return new Response(undefined, { headers, status: instructions.status });
    }

    if (typeof body === "string") {
        if (instructions.isHtml && !headers.has("content-type")) {
            headers.set("content-type", "text/html; charset=utf-8");
        }

        return new Response(body, { headers, status: instructions.status });
    }

    return Response.json(body, { headers, status: instructions.status });
};

/** Return a copy of `response` with `extra` headers (e.g. `X-PAYMENT-RESPONSE`) merged in. */
export const withHeaders = (response: Response, extra: Record<string, string>): Response => {
    const headers = new Headers(response.headers);

    for (const [key, value] of Object.entries(extra)) {
        headers.set(key, value);
    }

    return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
};

/**
 * Route metadata a caller can layer onto the generated catch-all route. The
 * procedure gate sets `resource` to the `functionPath` so the x402 challenge
 * names the paid function (x402 core falls back to the request URL otherwise —
 * every RPC POSTs to the same `/_lunora/rpc`, so the URL can't tell two paid
 * procedures apart).
 * @experimental
 */
export type ChargeRouteOverrides = Pick<RouteConfig, "description" | "resource">;

/**
 * Build and initialise a {@link ChargeMiddleware} for `config`. Fetches
 * facilitator support once (via `initialize()`), so call this once per config
 * and reuse the result across requests. `routeOverrides` layers extra route
 * metadata (e.g. `resource`) onto the generated catch-all route.
 * @experimental
 */
export const createChargeMiddleware = async (config: X402ChargeConfig, routeOverrides?: ChargeRouteOverrides): Promise<ChargeMiddleware> => {
    const server = await buildResourceServer(config);
    const http = new X402HTTPResourceServer(server, { ...buildRoute(config), ...routeOverrides });

    await http.initialize();

    const handle = async (request: Request, runHandler: ChargeHandler): Promise<Response> => {
        const url = new URL(request.url);
        const context: HTTPRequestContext = {
            adapter: createRequestAdapter(request, url),
            method: request.method,
            path: url.pathname,
            paymentHeader: request.headers.get(PAYMENT_HEADER) ?? undefined,
        };

        const result = await http.processHTTPRequest(context);

        if (result.type === "no-payment-required") {
            return runHandler();
        }

        if (result.type === "payment-error") {
            return toResponse(result.response);
        }

        // payment-verified: run the handler, then settle around its response.
        let response: Response;

        try {
            response = await runHandler();
        } catch (error) {
            // The client paid but we couldn't produce the resource — release the
            // verified payment so the facilitator never settles it. A cancellation
            // failure must not mask why the handler threw: surface it to the Worker
            // logs (the client paid and we couldn't release it — worth a tail line)
            // and rethrow the original error the caller was waiting on.
            try {
                await result.cancellationDispatcher.cancel({ error, reason: "handler_threw" });
            } catch (cancelError) {
                // eslint-disable-next-line no-console -- a stuck-payment cancellation failure is worth a Worker tail line
                console.error("x402 charge: failed to cancel payment after the handler threw", cancelError);
            }

            throw error;
        }

        const settlement = await http.processSettlement(result.paymentPayload, result.paymentRequirements, result.declaredExtensions, {
            request: context,
            responseHeaders: headerRecord(response.headers),
        });

        if (settlement.success) {
            // The route's `resource` override names the paid resource (a procedure's
            // `functionPath`); the generic rail has none, so fall back to the URL.
            reportReceipt(config.onReceipt, settlement, routeOverrides?.resource ?? request.url);

            return withHeaders(response, settlement.headers);
        }

        // Settlement failed after the handler ran: the client did not actually
        // pay, so withhold the resource and surface the 402 failure instead.
        return toResponse(settlement.response);
    };

    return { handle };
};
