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

/**
 * The RFC 9728 path-inserted protected-resource metadata path for `resource`.
 * `mcp()` has already validated the resource as an absolute URL by the time it
 * reaches here.
 */
const protectedResourcePath = (resource: string): string => `${PROTECTED_RESOURCE_PREFIX}${new URL(resource).pathname.replace(TRAILING_SLASH, "")}`;

/** The RFC 8414 path-inserted authorization-server metadata path for an issuer path. */
const authorizationServerPath = (issuerPath: string): string => `${AUTHORIZATION_SERVER_PREFIX}${issuerPath.replace(TRAILING_SLASH, "")}`;

/** A plugin as the discovery derivation reads it: an id, its options, and maybe the MCP mark. */
interface PluginLike {
    readonly id?: unknown;
    readonly [MCP_RESOURCE_KEY]?: unknown;
    readonly options?: unknown;
}

/** oauth-provider's options, as far as the derivation reads them. */
interface ProviderOptionsLike {
    readonly clientRegistrationDefaultResources?: unknown;
    readonly disableJwtPlugin?: unknown;
    readonly resources?: unknown;
}

/** The path of a path-bearing `baseURL`, which better-auth keeps in place of `basePath`. */
const baseUrlPath = (baseURL: unknown): string | undefined => {
    if (typeof baseURL !== "string") {
        return undefined;
    }

    try {
        const path = new URL(baseURL).pathname.replace(TRAILING_SLASH, "");

        return path === "" ? undefined : path;
    } catch {
        return undefined;
    }
};

/**
 * The issuer's path, derived the way oauth-provider derives the issuer: the
 * `jwt()` plugin's `jwt.issuer` when one is set and the provider does not set
 * `disableJwtPlugin`, else the auth base URL — the path of a path-bearing
 * `baseURL` (better-auth then ignores `basePath`), or `basePath`.
 */
const issuerPathOf = (options: LunoraAuthOptions, plugins: ReadonlyArray<PluginLike>, provider: ProviderOptionsLike | undefined): string => {
    const jwtOptions = plugins.find((plugin) => plugin.id === "jwt")?.options as undefined | { jwt?: { issuer?: unknown } };
    const issuer = provider?.disableJwtPlugin === true ? undefined : jwtOptions?.jwt?.issuer;

    if (typeof issuer === "string") {
        try {
            return new URL(issuer).pathname;
        } catch {
            // An unparseable issuer fails better-auth's own startup check; fall back.
        }
    }

    return baseUrlPath(options.baseURL) ?? options.basePath ?? DEFAULT_AUTH_BASE_PATH;
};

/** The identifier of each configured resource (a string, or `{ identifier }`). */
const resourceIdentifiers = (resources: unknown): string[] =>
    (Array.isArray(resources) ? resources : [])
        .map((resource: unknown) => (typeof resource === "object" && resource !== null ? (resource as { identifier?: unknown }).identifier : resource))
        .filter((identifier): identifier is string => typeof identifier === "string");

/**
 * The MCP resource of an `oauth-provider` plugin: the one Lunora's `mcp` recorded,
 * else — for `@better-auth/mcp`'s own `mcp`, or a copy of the plugin object that
 * dropped the mark — the provider's only resource. `undefined` for a plain
 * `oauthProvider()`.
 * @throws LunoraError `AUTH_MCP_RESOURCE_AMBIGUOUS` when an unmarked MCP-shaped
 * provider (it carries `clientRegistrationDefaultResources`, which `mcp()` always
 * sets) names several resources, so the MCP one cannot be told apart.
 */
const mcpResourceOf = (plugin: PluginLike): string | undefined => {
    const marked = plugin[MCP_RESOURCE_KEY];

    if (typeof marked === "string") {
        return marked;
    }

    const provider = plugin.options as ProviderOptionsLike | undefined;
    const resources = [...new Set(resourceIdentifiers(provider?.resources))];

    if (resources.length === 1) {
        return resources[0];
    }

    if (resources.length > 1 && Array.isArray(provider?.clientRegistrationDefaultResources)) {
        throw new LunoraError(
            "AUTH_MCP_RESOURCE_AMBIGUOUS",
            `@lunora/auth cannot tell which of the provider's resources (${resources.join(", ")}) is the MCP resource. Use \`mcp\` from "@lunora/auth/plugins", which records it, and pass the plugin object as is.`,
        );
    }

    return undefined;
};

/**
 * The exact `.well-known` paths this auth configuration serves outside its base
 * path: the protected-resource metadata for each MCP resource, and the
 * authorization-server metadata for the issuer. Empty unless an
 * `oauthProvider()` or `mcp()` plugin is configured.
 * @throws LunoraError `AUTH_MCP_RESOURCE_AMBIGUOUS` — see {@link mcpResourceOf}.
 */
const authDiscoveryPaths = (options: LunoraAuthOptions): ReadonlyArray<string> => {
    const plugins = (options.plugins ?? []) as ReadonlyArray<PluginLike>;
    const providers = plugins.filter((plugin) => plugin.id === "oauth-provider");

    if (providers.length === 0) {
        return [];
    }

    const resourcePaths = providers
        .map((plugin) => mcpResourceOf(plugin))
        .filter((resource): resource is string => resource !== undefined)
        .map((resource) => protectedResourcePath(resource));
    const issuerPath = issuerPathOf(options, plugins, providers[0]?.options as ProviderOptionsLike | undefined);

    return [...new Set([...resourcePaths, authorizationServerPath(issuerPath)])];
};

/** Per declaration object: one isolate's `options(env)` is fixed, so derive it once. */
const pathsByDeclaration = new WeakMap<object, ReadonlyArray<string>>();

/**
 * Derive {@link authDiscoveryPaths} for an `.auth()` declaration, memoised on the
 * declaration object. A framework-hosted worker rebuilds its options on every
 * request, and calling `options(env)` each time would rebuild every plugin.
 */
const authDiscoveryPathsFor = <Env>(declaration: { options: (env: Env) => LunoraAuthOptions }, env: Env): ReadonlyArray<string> => {
    let paths = pathsByDeclaration.get(declaration);

    if (paths === undefined) {
        paths = authDiscoveryPaths(declaration.options(env));
        pathsByDeclaration.set(declaration, paths);
    }

    return paths;
};

/** A 404 from better-auth (or the auth object) means "not mine": pass it over so the caller's 404 stands. */
const unlessNotFound = (response: Response | undefined): Response | undefined => (response?.status === 404 ? undefined : response);

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

    return unlessNotFound(await auth.handler(request));
};

export {
    authDiscoveryPaths,
    authDiscoveryPathsFor,
    authorizationServerPath,
    handleAuthDiscoveryRequest,
    isDiscoveryRequest,
    MCP_RESOURCE_KEY,
    protectedResourcePath,
    unlessNotFound,
};
