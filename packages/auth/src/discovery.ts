/**
 * The OAuth discovery documents an MCP client fetches before it authorizes, and
 * which ones a given auth configuration serves.
 *
 * better-auth answers both — the RFC 9728 protected-resource metadata `mcp()`
 * serves for its resource, and the RFC 8414 authorization-server metadata
 * `oauthProvider()` (which `mcp()` is) serves for its issuer — but at
 * `/.well-known/…` paths outside the auth base path, which `handleAuthRequest`
 * never forwards. The worker serves them as a fallback once the app's own routes
 * have missed (`authDiscoveryHandler` in `@lunora/runtime`), for exactly the
 * paths derived here and nothing else under `/.well-known/`.
 */
import { LunoraError } from "@lunora/errors";

import type { LunoraAuth, LunoraAuthOptions } from "./create-auth";
import { DEFAULT_AUTH_BASE_PATH } from "./handler";

/**
 * Where Lunora's `mcp()` records the resource it was given, on the plugin object.
 * better-auth keeps it in a closure, so nothing else can tell which of the
 * provider's `resources` is the MCP one. `Symbol.for`, so a second copy of this
 * module in a bundle still reads the same key.
 */
const MCP_RESOURCE_KEY: unique symbol = Symbol.for("lunora.auth.mcpResource");

const TRAILING_SLASH = /\/$/u;

const PROTECTED_RESOURCE_PREFIX = "/.well-known/oauth-protected-resource";

const AUTHORIZATION_SERVER_PREFIX = "/.well-known/oauth-authorization-server";

/** Parse `resource` as an absolute URL, or fail closed. */
const parseMcpResource = (resource: unknown): URL => {
    if (typeof resource === "string" && resource !== "") {
        try {
            return new URL(resource);
        } catch {
            // Fall through to the error below.
        }
    }

    throw new LunoraError(
        "AUTH_MCP_RESOURCE_INVALID",
        `the MCP \`resource\` must be the absolute URL passed to mcp({ resource }), got ${JSON.stringify(resource)}. Without it no issued token's audience matches and every request is refused.`,
    );
};

/** The RFC 9728 path-inserted protected-resource metadata path for `resource`. */
const protectedResourcePath = (resource: string): string => `${PROTECTED_RESOURCE_PREFIX}${parseMcpResource(resource).pathname.replace(TRAILING_SLASH, "")}`;

/** The RFC 8414 path-inserted authorization-server metadata path for an issuer path. */
const authorizationServerPath = (issuerPath: string): string => `${AUTHORIZATION_SERVER_PREFIX}${issuerPath.replace(TRAILING_SLASH, "")}`;

/** A plugin as the discovery derivation reads it: an id, its options, and maybe the MCP mark. */
interface PluginLike {
    readonly id?: unknown;
    readonly [MCP_RESOURCE_KEY]?: unknown;
    readonly options?: unknown;
}

/**
 * The issuer's path. oauth-provider takes it from the `jwt()` plugin's
 * `jwt.issuer` when one is set, else from the auth base URL, whose path is the
 * base path.
 */
const issuerPathOf = (options: LunoraAuthOptions, plugins: ReadonlyArray<PluginLike>): string => {
    const jwtOptions = plugins.find((plugin) => plugin.id === "jwt")?.options as undefined | { jwt?: { issuer?: unknown } };
    const issuer = jwtOptions?.jwt?.issuer;

    if (typeof issuer === "string") {
        try {
            return new URL(issuer).pathname;
        } catch {
            // An unparseable issuer fails better-auth's own startup check; fall back.
        }
    }

    return options.basePath ?? DEFAULT_AUTH_BASE_PATH;
};

/**
 * The exact `.well-known` paths this auth configuration serves outside its base
 * path: the protected-resource metadata for each `mcp({ resource })` (only
 * Lunora's `mcp`, which records its resource), and the authorization-server
 * metadata for the issuer. Empty unless an `oauthProvider()` or `mcp()` plugin is
 * configured.
 */
const authDiscoveryPaths = (options: LunoraAuthOptions): ReadonlyArray<string> => {
    const plugins = (options.plugins ?? []) as ReadonlyArray<PluginLike>;

    if (!plugins.some((plugin) => plugin.id === "oauth-provider")) {
        return [];
    }

    const resourcePaths = plugins
        .map((plugin) => plugin[MCP_RESOURCE_KEY])
        .filter((resource): resource is string => typeof resource === "string")
        .map((resource) => protectedResourcePath(resource));

    return [...new Set([...resourcePaths, authorizationServerPath(issuerPathOf(options, plugins))])];
};

/** One derivation per auth instance; the options never change after `createAuth`. */
const pathsByAuth = new WeakMap<object, ReadonlySet<string>>();

/**
 * Whether `request` is a `GET`/`HEAD` for one of `paths`. Metadata documents are
 * read-only, and anything else is left to whatever answers after this.
 */
const isDiscoveryRequest = (request: Request, paths: ReadonlySet<string>): boolean =>
    (request.method === "GET" || request.method === "HEAD") && paths.has(new URL(request.url).pathname);

/**
 * Serve an OAuth discovery document from `auth` when `request` asks for one of the
 * paths {@link authDiscoveryPaths} derives from its options; `undefined` for
 * anything else, so the caller's own 404 stands. A 404 from better-auth itself is
 * also passed over as `undefined`.
 */
const handleAuthDiscoveryRequest = async (auth: LunoraAuth, request: Request): Promise<Response | undefined> => {
    let paths = pathsByAuth.get(auth);

    if (paths === undefined) {
        paths = new Set(authDiscoveryPaths(auth.options));
        pathsByAuth.set(auth, paths);
    }

    if (!isDiscoveryRequest(request, paths)) {
        return undefined;
    }

    const response = await auth.handler(request);

    return response.status === 404 ? undefined : response;
};

export {
    authDiscoveryPaths,
    authorizationServerPath,
    handleAuthDiscoveryRequest,
    isDiscoveryRequest,
    MCP_RESOURCE_KEY,
    parseMcpResource,
    protectedResourcePath,
};
