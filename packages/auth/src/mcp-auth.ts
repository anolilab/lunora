/**
 * Lunora's wrappers over better-auth's `mcp` and `requireMcpAuth`, plus the
 * discovery paths an MCP route needs served.
 *
 * better-auth makes `requireMcpAuth`'s `resource` optional and falls back to the
 * auth `baseURL` (`…/api/auth`). No token `mcp({ resource })` issues carries that
 * audience, so the default refuses every request with a 401 — and its challenge
 * points clients at a protected-resource document nobody serves. Here `resource`
 * is required, and checked before any request is served.
 *
 * `mcp` is better-auth's, unchanged, except that it records its `resource` on the
 * plugin object, so the worker can derive the protected-resource path to serve
 * (see `./discovery`).
 */
import type { McpOptions, RequireMcpAuthOptions } from "@better-auth/mcp";
import { mcp as betterAuthMcp, requireMcpAuth as betterAuthRequireMcpAuth } from "@better-auth/mcp";
import { LunoraError } from "@lunora/errors";

import { authorizationServerPath, MCP_RESOURCE_KEY, protectedResourcePath } from "./discovery";
import { DEFAULT_AUTH_BASE_PATH } from "./handler";

/** better-auth's `requireMcpAuth` options, with `resource` required. */
type LunoraRequireMcpAuthOptions = {
    /**
     * The protected-resource URL tokens must be bound to — the same value passed
     * to `mcp({ resource })`.
     */
    resource: string;
} & RequireMcpAuthOptions;

/** The auth instance shape better-auth's `requireMcpAuth` accepts. */
type McpAuthInstance = Parameters<typeof betterAuthRequireMcpAuth>[0];

/** The protected handler: receives the request and the verified token claims. */
type McpProtectedHandler = Parameters<typeof betterAuthRequireMcpAuth>[1];

/** Check `resource` is an absolute URL before anything is served, or fail closed. */
const assertMcpResource = (resource: unknown): void => {
    if (typeof resource === "string" && URL.canParse(resource)) {
        return;
    }

    throw new LunoraError(
        "AUTH_MCP_RESOURCE_INVALID",
        `requireMcpAuth needs \`resource\` set to the absolute URL passed to mcp({ resource }), got ${JSON.stringify(resource)}. Without it no issued token's audience matches and every request is refused.`,
    );
};

/**
 * The MCP authorization server: better-auth's `oauthProvider` configured for MCP,
 * serving the RFC 9728 protected-resource metadata for `resource`. Lunora's
 * worker serves that document and the authorization-server metadata outside the
 * auth base path on its own; that needs this `mcp`, not `@better-auth/mcp`'s.
 */
const mcp = (options: McpOptions): ReturnType<typeof betterAuthMcp> => {
    const plugin = betterAuthMcp(options);

    // Non-enumerable: better-auth spreads and inspects plugin objects, and the mark
    // is for `./discovery` alone.
    Object.defineProperty(plugin, MCP_RESOURCE_KEY, { value: options.resource });

    return plugin;
};

/**
 * Protect an MCP route on the same deployment as the authorization server.
 * Verifies the bearer token's signature, issuer, audience and expiry, and hands
 * the verified claims to `handler`.
 * @throws LunoraError when `resource` is missing, empty or not an absolute URL.
 */
const requireMcpAuth = (
    auth: McpAuthInstance,
    handler: McpProtectedHandler,
    options: LunoraRequireMcpAuthOptions,
): ((request: Request) => Promise<Response>) => {
    assertMcpResource(options.resource);

    return betterAuthRequireMcpAuth(auth, handler, options);
};

/**
 * The two `.well-known` paths an MCP client fetches before it authorizes:
 * the RFC 9728 protected-resource metadata for `resource` (where the 401
 * challenge points), then the RFC 8414 authorization-server metadata for the
 * issuer.
 *
 * The Lunora worker already serves both for an `.auth()` declaration with
 * `mcp()`; this is for routing them yourself, e.g. in front of a hand-built
 * worker. Pass `authBasePath` when `createAuth` was given a `basePath` other
 * than `/api/auth`.
 * @throws TypeError when `resource` is not an absolute URL.
 */
const mcpDiscoveryPaths = (resource: string, authBasePath: string = DEFAULT_AUTH_BASE_PATH): ReadonlyArray<string> => [
    protectedResourcePath(resource),
    authorizationServerPath(authBasePath),
];

export type { LunoraRequireMcpAuthOptions };
export { mcp, mcpDiscoveryPaths, requireMcpAuth };
