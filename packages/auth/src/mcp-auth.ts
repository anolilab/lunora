/**
 * Lunora's wrapper over better-auth's `requireMcpAuth`, plus the discovery paths
 * an MCP route has to forward to the auth handler.
 *
 * better-auth makes `resource` optional and falls back to the auth `baseURL`
 * (`…/api/auth`). No token `mcp({ resource })` issues carries that audience, so
 * the default refuses every request with a 401 — and its challenge points
 * clients at a protected-resource document nobody serves. Here `resource` is
 * required, and checked before any request is served.
 */
import type { RequireMcpAuthOptions } from "@better-auth/mcp";
import { requireMcpAuth as betterAuthRequireMcpAuth } from "@better-auth/mcp";
import { LunoraError } from "@lunora/errors";

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

const TRAILING_SLASH = /\/$/u;

/** Parse `resource` as an absolute URL, or fail closed. */
const parseResource = (resource: unknown): URL => {
    if (typeof resource === "string" && resource !== "") {
        try {
            return new URL(resource);
        } catch {
            // Fall through to the error below.
        }
    }

    throw new LunoraError(
        "AUTH_MCP_RESOURCE_INVALID",
        `requireMcpAuth needs \`resource\` set to the absolute URL passed to mcp({ resource }), got ${JSON.stringify(resource)}. Without it no issued token's audience matches and every request is refused.`,
    );
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
    parseResource(options.resource);

    return betterAuthRequireMcpAuth(auth, handler, options);
};

/**
 * The two `.well-known` paths an MCP client fetches before it authorizes:
 * the RFC 9728 protected-resource metadata for `resource` (where the 401
 * challenge points), then the RFC 8414 authorization-server metadata for the
 * issuer. better-auth serves both, but outside the auth base path, so route
 * exactly these to `auth.handler`.
 *
 * Pass `authBasePath` when `createAuth` was given a `basePath` other than
 * `/api/auth`.
 * @throws LunoraError when `resource` is not an absolute URL.
 */
const mcpDiscoveryPaths = (resource: string, authBasePath: string = DEFAULT_AUTH_BASE_PATH): ReadonlyArray<string> => {
    const resourcePath = parseResource(resource).pathname.replace(TRAILING_SLASH, "");
    const issuerPath = authBasePath.replace(TRAILING_SLASH, "");

    return [`/.well-known/oauth-protected-resource${resourcePath}`, `/.well-known/oauth-authorization-server${issuerPath}`];
};

export type { LunoraRequireMcpAuthOptions };
export { mcpDiscoveryPaths, requireMcpAuth };
