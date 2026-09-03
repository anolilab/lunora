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
 * const auth = createAuth({
 *     database: env.DB,
 *     secret: env.AUTH_SECRET,
 *     plugins: [jwt(), mcp({ loginPage: "/login", consentPage: "/consent", resource: "https://api.example.com/mcp" })],
 * });
 *
 * export const handleMcp = createAuthedMcpFetchHandler({
 *     protect: (handler) => requireMcpAuth(auth, handler, { requiredScopes: ["lunora:read"] }),
 *     server: (claims) => ({
 *         // Writes need a second scope the read-only token does not carry.
 *         allowWrites: mcpTokenScopes(claims).has("lunora:write"),
 *         token: env.LUNORA_ADMIN_TOKEN,
 *         url: env.LUNORA_URL,
 *     }),
 * });
 * ```
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
import type { McpFetchHandler } from "./serve-stateless";
import { serveStateless } from "./serve-stateless";
import type { LunoraMcpServerOptions } from "./server";
import { createLunoraMcpServer, resolveClient } from "./server";

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

interface AuthedMcpFetchHandlerOptions {
    /** Largest accepted request body, in bytes. Defaults to `DEFAULT_MAX_REQUEST_BYTES` (128 KiB). */
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
    const sharedClient = typeof options.server === "function" ? undefined : resolveClient(options.server);

    return options.protect(async (request: Request, claims: McpAccessTokenClaims): Promise<Response> => {
        const resolved = typeof options.server === "function" ? await options.server(claims) : { ...options.server, client: sharedClient };

        return await serveStateless(createLunoraMcpServer(resolved), request, { maxRequestBytes: options.maxRequestBytes });
    });
};

export type { AuthedMcpFetchHandlerOptions, AuthedMcpServerOptions, McpAccessTokenClaims, McpAuthProtect };
export { createAuthedMcpFetchHandler, mcpTokenScopes };
