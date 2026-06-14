/**
 * `@cirrus/container/bridge` — the container→Cirrus client.
 *
 * Container code (any JS runtime — Node, Bun, Deno) uses this to call back
 * into the app's Cirrus functions over the Worker's HTTP RPC endpoint
 * (`POST /_cirrus/rpc`), so a container can read/write app state through the
 * same queries/mutations/actions the browser uses instead of reaching into a
 * database directly.
 *
 * Pure `fetch` over the documented wire contract — no Cloudflare imports — so
 * it runs in any container and is unit-testable with an injected `fetch`. The
 * transport is the public RPC endpoint authenticated with a bearer token your
 * Worker's `resolveIdentity` recognizes (forward it as a container `secret`).
 * Non-JS containers can implement the same one-line contract directly.
 */

/** The RPC path the Cirrus Worker exposes. */
const RPC_PATH = "/_cirrus/rpc";

/** A `fetch` implementation — defaults to the runtime global. */
type FetchLike = (
    input: string,
    init: { body: string; headers: Record<string, string>; method: string },
) => Promise<{ json: () => Promise<unknown>; ok: boolean; status: number; statusText?: string }>;

interface ContainerBridgeOptions {
    /**
     * Base URL of the deployed Cirrus Worker (no trailing `/_cirrus/rpc`), e.g.
     * `https://my-app.workers.dev`. In a Cirrus container, surface it as an
     * `env` value on the definition.
     */
    baseUrl: string;
    /** Injectable `fetch` (tests / non-global runtimes). Defaults to `globalThis.fetch`. */
    fetch?: FetchLike;

    /**
     * Bearer token sent as `Authorization: Bearer &lt;token>`. Your Worker's
     * `resolveIdentity` maps it to the identity the called functions run as.
     * Pass it to the container as a `secret`, never bake it into the image.
     */
    token?: string;
}

/** Thrown when a Cirrus function returns an error envelope. Carries the wire `code`. */
class ContainerBridgeError extends Error {
    public readonly code: string;

    public constructor(code: string, message: string) {
        super(message);
        this.name = "ContainerBridgeError";
        this.code = code;
    }
}

/**
 * Structural mirror of `@cirrus/client`'s `FunctionReference` — the typed
 * handle the generated `_generated/api` object carries. Declared locally (not
 * imported) so the bridge stays dependency-free and its `.d.ts` is
 * self-contained; the `__cirrusPhantom` shape matches, so a real `api.x.y`
 * reference is assignable and its arg/return types are inferable.
 */
interface BridgeFunctionReference<Args = unknown, Result = unknown> {
    readonly __cirrusPhantom?: { args: Args; returns: Result };
    readonly __cirrusRef: string;
}

/** Infer the args type from a {@link BridgeFunctionReference} (or a `@cirrus/client` reference). */
type ArgsOfReference<Reference> = Reference extends { __cirrusPhantom?: { args: infer Args } } ? Args : never;

/** Infer the result type from a {@link BridgeFunctionReference} (or a `@cirrus/client` reference). */
type ResultOfReference<Reference> = Reference extends { __cirrusPhantom?: { returns: infer Result } } ? Result : never;

interface ContainerBridge {
    /** Call an `action` by `namespace:fn` path. Alias of {@link ContainerBridge.call} for intent. */
    action: <Result = unknown>(functionPath: string, args?: Record<string, unknown>, shardKey?: string) => Promise<Result>;
    /** Call any Cirrus function by `namespace:fn` path; the server resolves its kind. */
    call: <Result = unknown>(functionPath: string, args?: Record<string, unknown>, shardKey?: string) => Promise<Result>;
    /** Call a `mutation` by `namespace:fn` path. Alias of {@link ContainerBridge.call} for intent. */
    mutation: <Result = unknown>(functionPath: string, args?: Record<string, unknown>, shardKey?: string) => Promise<Result>;
    /** Call a `query` by `namespace:fn` path. Alias of {@link ContainerBridge.call} for intent. */
    query: <Result = unknown>(functionPath: string, args?: Record<string, unknown>, shardKey?: string) => Promise<Result>;

    /**
     * Fully-typed call via a generated function reference. Pass a reference from
     * the project's `_generated/api` (e.g. `api.messages.list`) and the args +
     * result are inferred from it — the typed counterpart to {@link ContainerBridge.call}
     * for JS/TS containers that can import the generated `api`.
     */
    run: <Reference extends BridgeFunctionReference>(
        reference: Reference,
        args: ArgsOfReference<Reference>,
        shardKey?: string,
    ) => Promise<ResultOfReference<Reference>>;
}

const joinUrl = (baseUrl: string, path: string): string => {
    let base = baseUrl;

    while (base.endsWith("/")) {
        base = base.slice(0, -1);
    }

    return `${base}${path}`;
};

/** The response shape a {@link FetchLike} resolves to. */
type BridgeResponse = Awaited<ReturnType<FetchLike>>;

/** Build the generic status error thrown when a request fails without a typed envelope. */
const statusError = (functionPath: string, response: BridgeResponse): Error =>
    new Error(
        `createContainerBridge: request to "${functionPath}" failed (status ${String(response.status)}${response.statusText ? ` ${response.statusText}` : ""})`,
    );

/**
 * Parse the response body as JSON, mapping a non-JSON body to a clear error:
 * a status error when the response is not ok, otherwise a non-JSON-response
 * error (so a non-JSON success body can never reach the result unwrap).
 */
const parseResponseBody = async (response: BridgeResponse, functionPath: string): Promise<unknown> => {
    try {
        return await response.json();
    } catch {
        if (!response.ok) {
            throw statusError(functionPath, response);
        }

        throw new Error(`createContainerBridge: request to "${functionPath}" returned a non-JSON response (status ${String(response.status)})`);
    }
};

/**
 * Build a container→Cirrus bridge bound to a Worker URL + token.
 *
 * ```ts
 * const cirrus = createContainerBridge({ baseUrl: process.env.CIRRUS_URL!, token: process.env.CIRRUS_TOKEN });
 * const messages = await cirrus.query("messages:list", { limit: 20 });
 * await cirrus.mutation("messages:markProcessed", { id });
 * ```
 *
 * `query`/`mutation`/`action` are intent-revealing aliases of one `call` — the
 * wire is identical and the server dispatches by the function's registered
 * kind, so a query path called via `.mutation(...)` still runs as a query.
 */
const createContainerBridge = (options: ContainerBridgeOptions): ContainerBridge => {
    const fetchImpl: FetchLike = options.fetch ?? globalThis.fetch;

    const call = async <Result>(functionPath: string, args: Record<string, unknown> = {}, shardKey?: string): Promise<Result> => {
        if (typeof fetchImpl !== "function") {
            throw new TypeError("createContainerBridge: no `fetch` available — pass `fetch` in options for this runtime.");
        }

        const headers: Record<string, string> = { "content-type": "application/json" };

        if (options.token !== undefined) {
            headers.authorization = `Bearer ${options.token}`;
        }

        const response = await fetchImpl(joinUrl(options.baseUrl, RPC_PATH), {
            body: JSON.stringify({ args, functionPath, shardKey }),
            headers,
            method: "POST",
        });

        const body = await parseResponseBody(response, functionPath);

        if (typeof body === "object" && body !== null && "error" in body) {
            const { error } = body;

            if (typeof error === "object" && error !== null) {
                const { code, message } = error as { code?: unknown; message?: unknown };

                if (typeof code === "string" && typeof message === "string") {
                    throw new ContainerBridgeError(code, message);
                }
            }

            let detail: string;

            try {
                detail = JSON.stringify(error);
            } catch {
                detail = String(error);
            }

            throw new Error(
                `createContainerBridge: request to "${functionPath}" returned a malformed error envelope (status ${String(response.status)}): ${detail}`,
            );
        }

        if (!response.ok) {
            throw statusError(functionPath, response);
        }

        return (body as { result: Result }).result;
    };

    const run = async <Reference extends BridgeFunctionReference>(
        reference: Reference,
        args: ArgsOfReference<Reference>,
        shardKey?: string,
        // eslint-disable-next-line no-underscore-dangle -- `__cirrusRef` is the generated wire-format reference id
    ): Promise<ResultOfReference<Reference>> => call<ResultOfReference<Reference>>(reference.__cirrusRef, args as Record<string, unknown>, shardKey);

    return { action: call, call, mutation: call, query: call, run };
};

export type { BridgeFunctionReference, ContainerBridge, ContainerBridgeOptions, FetchLike };
export { ContainerBridgeError, createContainerBridge };
