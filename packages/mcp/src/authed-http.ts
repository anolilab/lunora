/**
 * Serve a Lunora MCP server over **OAuth-protected** Streamable HTTP, using
 * better-auth's MCP plugin as the authorization layer.
 *
 * `./http`'s `createMcpFetchHandler` serves anyone who can reach the URL. That
 * is right for a stdio binary on a developer's laptop and wrong for a public
 * endpoint: the tools carry the deployment's admin bearer, so the network path
 * IS the authorization. This module closes that by mounting the same handler
 * behind an OAuth 2.1 gate — the one MCP clients already know how to walk, via
 * the RFC 9728 protected-resource metadata better-auth's `mcp()` plugin serves.
 *
 * # Wiring
 *
 * The authorization server is a better-auth instance running the `mcp` plugin;
 * the resource server is this handler. On the same Worker:
 *
 * ```ts
 * import { createAuth } from "@lunora/auth";
 * import { jwt, mcp, requireMcpAuth } from "@lunora/auth/plugins";
 * import { createAuthedMcpFetchHandler, mcpTokenScopes } from "@lunora/mcp";
 *
 * const resource = "https://api.example.com/mcp";
 *
 * const auth = createAuth({
 *     database: env.DB,
 *     secret: env.AUTH_SECRET,
 *     plugins: [jwt(), mcp({ loginPage: "/login", consentPage: "/consent", resource, scopes: ["lunora:read", "lunora:write"] })],
 * });
 *
 * export const handleMcp = createAuthedMcpFetchHandler({
 *     // `resource` is required: tokens are audience-bound to it.
 *     protect: (handler) => requireMcpAuth(auth, handler, { requiredScopes: ["lunora:read"], resource }),
 *     server: (claims) => ({
 *         // Writes need a second scope the read-only token does not carry.
 *         allowWrites: mcpTokenScopes(claims).has("lunora:write"),
 *         token: env.LUNORA_ADMIN_TOKEN,
 *         url: env.LUNORA_URL,
 *     }),
 * });
 * ```
 *
 * `mcp()` must declare the `lunora:*` scopes: left out, it falls back to the
 * OIDC defaults and no client can be granted `lunora:read` at all. The
 * protected-resource and authorization-server metadata the 401 challenge sends
 * clients to sit outside `/api/auth/*`; a worker built with `.auth(...)` serves
 * them itself (after the app's own routes), and a hand-composed one routes the
 * paths `mcpDiscoveryPaths(resource)` returns to `auth.handler`.
 * `__tests__/authed-http.e2e.test.ts` runs this exact wiring against a real
 * better-auth instance.
 *
 * # Step-up for writes
 *
 * With `writeScope` (and its `challenge`, `createInsufficientScopeError` from
 * `@lunora/auth/plugins`) a token lacking the scope still lists the write tools,
 * and a `tools/call` to one throws the challenge, which the gate answers with a
 * 403 `insufficient_scope` naming the scope — so the client can re-authorize
 * instead of never learning the tools exist.
 *
 * `protect` is a lambda rather than an `auth` instance on purpose. better-auth
 * is not a dependency of this package (see the note on {@link McpAuthProtect}),
 * and the same seam accepts either better-auth entry point unchanged:
 * `requireMcpAuth(auth, handler, opts)` when the resource server shares a
 * deployment with the authorization server, or
 * `createMcpProtectedRequestHandler(…, handler)` when it does not — that form
 * takes explicit verification options instead of an auth instance.
 *
 * # Why `server` takes the claims
 *
 * A gate that only answers yes/no gives every authorized agent the same
 * capabilities, which throws away the scopes the token was issued with. Passing
 * the verified claims into the server factory is what lets one endpoint serve a
 * read-only agent and a read-write one from the same code — the write tools are
 * omitted from `tools/list` *and* refused at dispatch for the former, because
 * `allowWrites` is resolved per request rather than per deployment.
 */
import { LunoraError } from "@lunora/errors";

import type { McpFetchHandler } from "./serve-stateless";
import { readScreenedBody, serveStateless } from "./serve-stateless";
import type { LunoraMcpServerOptions } from "./server";
import { createLunoraMcpServer, resolveClient } from "./server";
import callToolName from "./tool-call";
import { WRITE_TOOL_NAMES } from "./tools";

/**
 * The verified access-token payload better-auth hands a protected handler.
 *
 * A JWT payload is an open bag of claims, so this is deliberately an index
 * signature with the two entries this module reads named. It is structurally
 * satisfied by `jose`'s `JWTPayload`, which is what better-auth passes.
 */
interface McpAccessTokenClaims {
    readonly [claim: string]: unknown;
    /** Space-delimited granted scopes (RFC 6749 §3.3). */
    readonly scope?: unknown;
    /** Subject — the user the token was issued for. */
    readonly sub?: string;
}

/**
 * The MCP auth gate: wraps a claims-aware handler into a plain fetch handler.
 *
 * Declared structurally here rather than imported from `@better-auth/mcp`,
 * following the same rule `./paid` follows for `@lunora/x402`: a type import
 * from a package this one does not depend on puts that package's `.d.ts` into
 * the build graph, and a consumer that never installs it never builds it
 * either — so the dts bundler looks for a `dist/` that does not exist and fails
 * the build. Structural typing costs nothing here because this module never
 * inspects the gate; it only applies it.
 *
 * Both better-auth entry points partially apply to this shape:
 * `(handler) => requireMcpAuth(auth, handler, opts)` and
 * `(handler) => createMcpProtectedRequestHandler(options, handler)`.
 */
type McpAuthProtect = (handler: (request: Request, claims: McpAccessTokenClaims) => Promise<Response>) => McpFetchHandler;

/** Server options, or a function deriving them from the request's verified claims. */
type AuthedMcpServerOptions = ((claims: McpAccessTokenClaims) => LunoraMcpServerOptions | Promise<LunoraMcpServerOptions>) | LunoraMcpServerOptions;

/**
 * Step-up for writes: both options or neither, so a `writeScope` with nothing to
 * raise the challenge cannot fail open.
 */
type AuthedMcpStepUpOptions =
    | {
          /**
           * Build the error that makes the gate answer 403 `insufficient_scope`
           * naming `scopes`. Pass `createInsufficientScopeError` from
           * `@lunora/auth/plugins`: better-auth only turns an error that factory
           * created into the challenge.
           */
          challenge: (scopes: string[]) => unknown;

          /**
           * The scope a `tools/call` to a write tool needs, e.g. `"lunora:write"`.
           * A token without it still sees the write tools in `tools/list`, and a
           * call to one is answered with the step-up challenge instead of running,
           * so the client can re-authorize for the scope and retry.
           */
          writeScope: string;
      }
    | { challenge?: never; writeScope?: never };

interface AuthedMcpFetchHandlerBaseOptions {
    /**
     * Largest accepted request body, in bytes — enforced while the body streams
     * in, not after it is buffered. Defaults to `DEFAULT_MAX_REQUEST_BYTES`
     * (128 KiB), which a value that is not a non-negative safe integer also
     * falls back to.
     */
    maxRequestBytes?: number;

    /**
     * The OAuth gate to mount the MCP server behind. Pass
     * `(handler) => requireMcpAuth(auth, handler, opts)` from
     * `@lunora/auth/plugins`.
     */
    protect: McpAuthProtect;

    /**
     * The Lunora MCP server to serve once a request is authorized — either a
     * fixed options object, or a function of the verified token claims so tool
     * exposure can follow the scopes the token actually carries.
     */
    server: AuthedMcpServerOptions;
}

type AuthedMcpFetchHandlerOptions = AuthedMcpFetchHandlerBaseOptions & AuthedMcpStepUpOptions;

/**
 * Parse an access token's `scope` claim into a set.
 *
 * RFC 6749 §3.3 makes `scope` a space-delimited string, and better-auth issues
 * it that way; anything else (absent, or a non-string an extension wrote)
 * yields an empty set rather than throwing, so a scope check on a malformed
 * token denies instead of crashing the tool call.
 */
const mcpTokenScopes = (claims: McpAccessTokenClaims): ReadonlySet<string> => {
    if (typeof claims.scope !== "string") {
        return new Set<string>();
    }

    return new Set(claims.scope.split(" ").filter((scope) => scope !== ""));
};

/**
 * Build an OAuth-protected stateless Streamable-HTTP fetch handler for a Lunora
 * MCP server.
 *
 * Unauthenticated requests never reach the MCP server at all: `protect` answers
 * them with the RFC 9728 `WWW-Authenticate` challenge that starts the client's
 * authorization flow. An authorized request builds a fresh proxy server from
 * `server` (resolved against the verified claims) and serves it through
 * {@link serveStateless}, exactly as the unprotected `createMcpFetchHandler`
 * does — the transport behaviour is identical, only the gate is new.
 *
 * A fixed `server` object names one deployment, so its `LunoraClient` is
 * resolved once and shared: the public-function registry memo in `./tools` is
 * keyed by client identity and never hits when each request builds its own. The
 * `(claims) => …` form is per-request by construction — the claims decide which
 * deployment and token to use — so it keeps a client per request.
 */
const createAuthedMcpFetchHandler = (options: AuthedMcpFetchHandlerOptions): McpFetchHandler => {
    const { challenge, maxRequestBytes, writeScope } = options;
    // The type already pairs the two; this is for a caller the type cannot see
    // (plain JS, a cast), so it reads them untyped. A `writeScope` that cannot raise
    // its challenge would let every write through, so it refuses to build instead.
    const untyped: { challenge?: unknown; writeScope?: unknown } = options;

    if (
        (untyped.writeScope !== undefined || untyped.challenge !== undefined) &&
        (typeof untyped.writeScope !== "string" || untyped.writeScope === "" || typeof untyped.challenge !== "function")
    ) {
        throw new LunoraError(
            "MCP_STEP_UP_MISCONFIGURED",
            "createAuthedMcpFetchHandler: `writeScope` (a non-empty scope) and `challenge` must be set together.",
        );
    }

    const sharedClient = typeof options.server === "function" ? undefined : resolveClient(options.server);

    return options.protect(async (request: Request, claims: McpAccessTokenClaims): Promise<Response> => {
        let parsedBody: unknown;

        if (writeScope !== undefined) {
            // Peek the message through the same bounded read the transport uses, and
            // hand it on so the stream is read once. A body that is too large or not
            // JSON is refused here, before any tool can run.
            const screened = await readScreenedBody(request, maxRequestBytes);

            if ("response" in screened) {
                return screened.response;
            }

            ({ parsedBody } = screened);

            // A batch is refused by the transport whatever it holds; the check is per
            // message so a write tucked inside one is challenged rather than relying
            // on that. Anything that is not a `tools/call` to a write tool passes.
            const messages: unknown[] = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
            const callsWriteTool = messages.some((message) => WRITE_TOOL_NAMES.has(callToolName(message) ?? ""));

            if (callsWriteTool && !mcpTokenScopes(claims).has(writeScope)) {
                throw challenge([writeScope]);
            }
        }

        const resolved = typeof options.server === "function" ? await options.server(claims) : { ...options.server, client: sharedClient };

        return await serveStateless(createLunoraMcpServer(resolved), request, parsedBody === undefined ? { maxRequestBytes } : { maxRequestBytes, parsedBody });
    });
};

export type { AuthedMcpFetchHandlerOptions, AuthedMcpServerOptions, AuthedMcpStepUpOptions, McpAccessTokenClaims, McpAuthProtect };
export { createAuthedMcpFetchHandler, mcpTokenScopes };
