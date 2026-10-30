/**
 * Decide whether a URL may stand in for the deployment `lunora deploy` is about
 * to ship to, as the drift gate's stored-row evidence. Rows read anywhere else —
 * a dev worker, another environment — can fit a tightening that production's
 * rows break, and the gate would then wave the change through to production.
 */
import { readLinkedProject } from "@lunora/config";
import { findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";

import { normalizeAdminBaseUrl } from "./admin-url";

interface WranglerTarget {
    name?: unknown;
    route?: unknown;
    routes?: unknown;
}

interface WranglerNames extends WranglerTarget {
    env?: Record<string, WranglerTarget | undefined>;
}

/** Host suffixes and exact names that only ever reach this machine or a private network. */
const PRIVATE_NAMES = new Set(["0.0.0.0", "[::1]", "[::]", "localhost"]);
const PRIVATE_SUFFIXES = [".local", ".localhost"];
const PRIVATE_IPV6_PREFIXES = ["[fc", "[fd", "[fe80:"];
const URL_SCHEME = /^[a-z]+:\/\//u;

/** Whether a dotted IPv4 address is loopback, link-local or in an RFC 1918 range. */
const isPrivateIpv4 = (host: string): boolean => {
    const octets = host.split(".").map(Number);

    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
        return false;
    }

    const [first = -1, second = -1] = octets;

    return (
        first === 127 ||
        first === 10 ||
        (first === 192 && second === 168) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 169 && second === 254)
    );
};

const IPV4_MAPPED_PREFIX = "[::ffff:";

/**
 * The IPv4 address an IPv4-mapped IPv6 host (`[::ffff:127.0.0.1]`) carries, which
 * `URL` normalises to hex groups (`[::ffff:7f00:1]`); `undefined` for any other host.
 */
const mappedIpv4 = (host: string): string | undefined => {
    if (!host.startsWith(IPV4_MAPPED_PREFIX) || !host.endsWith("]")) {
        return undefined;
    }

    const rest = host.slice(IPV4_MAPPED_PREFIX.length, -1);

    if (rest.includes(".")) {
        return rest;
    }

    const [high = 0, low = 0] = rest.split(":").map((group) => Number.parseInt(group, 16));

    return [Math.floor(high / 256), high % 256, Math.floor(low / 256), low % 256].join(".");
};

/**
 * A hostname in the one spelling every comparison below uses: lowercase, without the trailing dot of a fully qualified name.
 * DNS treats `app.workers.dev.` and `app.workers.dev` as one host, but a suffix or equality test does not, and `localhost.` would pass as a deployed worker.
 * The URL parser has already lowercased, punycoded and normalised IP literals.
 */
const canonicalHost = (hostname: string): string => {
    let end = hostname.length;

    while (end > 0 && hostname[end - 1] === ".") {
        end -= 1;
    }

    return hostname.slice(0, end).toLowerCase();
};

/** Whether `host` can only be a dev worker, never a deployed one. */
const isPrivateHost = (host: string): boolean => {
    const lower = host.toLowerCase();
    const mapped = mappedIpv4(lower);

    if (mapped !== undefined) {
        return isPrivateIpv4(mapped);
    }

    return (
        PRIVATE_NAMES.has(lower) ||
        PRIVATE_SUFFIXES.some((suffix) => lower.endsWith(suffix)) ||
        PRIVATE_IPV6_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
        isPrivateIpv4(lower)
    );
};

const readWranglerNames = (cwd: string): WranglerNames | undefined => {
    const wranglerPath = findWranglerFile(cwd);

    return wranglerPath === undefined ? undefined : readWranglerJsonc<WranglerNames>(wranglerPath).parsed;
};

/**
 * The Worker name Wrangler deploys for `environment`: the env block's own
 * `name`, else `<name>-<env>`, else the top-level `name`.
 */
const deployedWorkerName = (parsed: WranglerNames | undefined, environment: string | undefined): string | undefined => {
    const name = typeof parsed?.name === "string" && parsed.name !== "" ? parsed.name : undefined;

    if (environment === undefined) {
        return name;
    }

    const own = parsed?.env?.[environment]?.name;

    if (typeof own === "string" && own !== "") {
        return own;
    }

    return name === undefined ? undefined : `${name}-${environment}`;
};

/**
 * A route pattern as `host` plus the path prefix it is scoped to (`example.com/*` → `example.com`, `example.com/prod/*` →
 * `example.com/prod/`). Two environments can share a host and differ only by path, so the path is part of the route.
 */
/** `text` without any run of `char` at its end. */
const trimEnd = (text: string, char: string): string => {
    let end = text.length;

    while (end > 0 && text[end - 1] === char) {
        end -= 1;
    }

    return text.slice(0, end);
};

const routeKey = (pattern: string): string => {
    const bare = pattern.replace(URL_SCHEME, "");
    const slash = bare.indexOf("/");
    const host = (slash === -1 ? bare : bare.slice(0, slash)).toLowerCase();
    const path = slash === -1 ? "" : trimEnd(bare.slice(slash), "*");

    return path === "/" ? host : `${host}${path}`;
};

/** The route key of every `route` / `routes` pattern one config block declares. */
const routeHosts = (block: WranglerTarget | undefined): string[] => {
    const entries: unknown[] = [block?.route, ...(Array.isArray(block?.routes) ? (block.routes as unknown[]) : [])];

    return entries.flatMap((entry) => {
        const pattern = typeof entry === "string" ? entry : (entry as { pattern?: unknown } | undefined)?.pattern;

        return typeof pattern === "string" && pattern !== "" ? [routeKey(pattern)] : [];
    });
};

/** Whether `host` falls under a route host, where a leading `*` matches any prefix as Cloudflare's route patterns do. */
const matchesRouteHost = (host: string, urlPath: string, route: string): boolean => {
    const slash = route.indexOf("/");
    const routeHost = slash === -1 ? route : route.slice(0, slash);
    const routePath = slash === -1 ? "" : route.slice(slash);
    const hostMatches = routeHost.startsWith("*") ? host.endsWith(routeHost.slice(1)) || `.${host}` === routeHost.slice(1) : host === routeHost;

    // A route scoped to a path covers a URL under that path only; `/prod/*` covers `/prod` and `/prod/api`, not `/production`.
    return hostMatches && (routePath === "" || `${trimEnd(urlPath, "/")}/`.startsWith(routePath));
};

/**
 * The route hosts `environment` deploys to. Routes are inheritable in Wrangler, so an env block
 * without its own takes the top-level ones.
 */
const ownRouteHosts = (parsed: WranglerNames | undefined, environment: string | undefined): string[] => {
    if (environment !== undefined) {
        const own = routeHosts(parsed?.env?.[environment]);

        if (own.length > 0) {
            return own;
        }
    }

    return routeHosts(parsed);
};

/** The other environment (`--env` name, or `production` for the top level) that declares a route `host` matches. */
const otherEnvironmentRoutingTo = (parsed: WranglerNames | undefined, environment: string | undefined, host: string, urlPath: string): string | undefined => {
    const blocks: [string, WranglerTarget | undefined][] = [["production", parsed], ...Object.entries(parsed?.env ?? {})];
    const own = new Set(ownRouteHosts(parsed, environment));

    for (const [label, block] of blocks) {
        if (
            label !== (environment ?? "production") &&
            routeHosts(block).some((routeHost) => !own.has(routeHost) && matchesRouteHost(host, urlPath, routeHost))
        ) {
            return label;
        }
    }

    return undefined;
};

/** Origin plus path without a trailing slash: the admin routes hang off the whole base URL, so two paths on one host may be two Workers. */
const deploymentKey = (url: URL): string => normalizeAdminBaseUrl(`${url.origin}${url.pathname}`);

/** Why the project link rules `parsed` out, `null` when the link names it, or `undefined` when the link cannot say. */
const linkRefusal = (cwd: string, environment: string | undefined, parsed: URL, refused: string, scope: string): string | null | undefined => {
    const link = readLinkedProject(cwd);
    const linked = link?.workerUrl !== undefined && URL.canParse(link.workerUrl) ? new URL(link.workerUrl) : undefined;

    if (linked === undefined) {
        return undefined;
    }

    if (link?.env === environment) {
        // eslint-disable-next-line unicorn/no-null -- `null` is "the link vouches for it", distinct from `undefined`, "the link is silent"
        return deploymentKey(linked) === deploymentKey(parsed) ? null : `${refused}: this checkout is linked to ${deploymentKey(linked)}${scope}`;
    }

    if (linked.origin !== parsed.origin) {
        return undefined;
    }

    const owner = link?.env === undefined ? "production" : `--env ${link.env}`;

    return `${refused}: this checkout links it to ${owner}, not this deploy${scope}`;
};

/** Why the config rules out a custom domain: another env's route, or not one of the routes this env deploys to. */
const customDomainRefusal = (
    wrangler: WranglerNames | undefined,
    environment: string | undefined,
    host: string,
    urlPath: string,
    refused: string,
    scope: string,
): string | undefined => {
    const other = otherEnvironmentRoutingTo(wrangler, environment, host, urlPath);

    if (other !== undefined) {
        return `${refused}: wrangler routes it to ${other === "production" ? "production" : `--env ${other}`}, not this deploy${scope}`;
    }

    const own = ownRouteHosts(wrangler, environment);

    if (own.some((route) => matchesRouteHost(host, urlPath, route))) {
        return undefined;
    }

    // Only a project that declares no routes anywhere has nothing to compare a custom domain with.
    if (own.length === 0 && Object.values(wrangler?.env ?? {}).every((block) => routeHosts(block).length === 0)) {
        return undefined;
    }

    return `${refused}: this deploy${scope} routes to ${own.length === 0 ? "no declared route" : own.join(", ")}, not ${host}`;
};

/** Why the wrangler config rules `host` out: a `*.workers.dev` name it does not deploy, or a custom domain another env routes to or this env does not. */
const wranglerRefusal = (cwd: string, environment: string | undefined, host: string, urlPath: string, refused: string, scope: string): string | undefined => {
    const wrangler = readWranglerNames(cwd);

    if (host.endsWith(".workers.dev")) {
        const worker = deployedWorkerName(wrangler, environment);

        if (worker !== undefined && host.split(".")[0] !== worker) {
            return `${refused}: this deploy ships the Worker "${worker}"${scope}`;
        }

        // The Worker name is only the first label; the account subdomain after it cannot be read from the config, so a
        // same-named Worker in another account would pass. Only a link recorded for this deploy ties the host to the account.
        return `${refused}: no link ties this *.workers.dev host to your account${scope}; run \`lunora link --url https://${host}${environment === undefined ? "" : ` --env ${environment}`}\` once the Worker is deployed, then deploy again (or confirm the drift yourself with --allow-schema-drift)`;
    }

    return customDomainRefusal(wrangler, environment, host, urlPath, refused, scope);
};

/** Why the config rules out a URL the project link vouches for: another Worker's name, or a route that belongs to another env. */
const staleLinkRefusal = (cwd: string, environment: string | undefined, parsed: URL, refused: string, scope: string): string | undefined => {
    const wrangler = readWranglerNames(cwd);
    const host = canonicalHost(parsed.hostname);

    if (host.endsWith(".workers.dev")) {
        const worker = deployedWorkerName(wrangler, environment);

        return worker === undefined || host.split(".")[0] === worker
            ? undefined
            : `${refused}: this deploy ships the Worker "${worker}", not the one the link names${scope}`;
    }

    return customDomainRefusal(wrangler, environment, host, parsed.pathname, refused, scope);
};

/**
 * Why `url` is not evidence about this deploy's target, or `undefined` when it
 * is. The link recorded for this `--env` is the target when there is one; a
 * `*.workers.dev` host must otherwise carry the Worker name Wrangler deploys,
 * and a custom domain must match a route this env declares. A custom domain on
 * a project that declares no routes at all cannot be compared, and is taken at
 * its word.
 */
const rowCheckTargetRefusal = (cwd: string, environment: string | undefined, url: string): string | undefined => {
    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        return `refused ${url} as the deployment to read rows from: it is not a URL`;
    }

    const refused = `refused ${deploymentKey(parsed)} as the deployment to read rows from`;
    const scope = environment === undefined ? "" : ` (--env ${environment})`;

    const host = canonicalHost(parsed.hostname);

    if (isPrivateHost(host)) {
        return `${refused}: it is a local or private address, not the worker this deploy ships to`;
    }

    const fromLink = linkRefusal(cwd, environment, parsed, refused, scope);

    if (fromLink === undefined) {
        return wranglerRefusal(cwd, environment, host, parsed.pathname, refused, scope);
    }

    // A link names the URL a deploy once published. Since then the Worker may have been renamed or the env's routes moved, so a
    // link that matches is still held against what Wrangler deploys now.
    return fromLink ?? staleLinkRefusal(cwd, environment, parsed, refused, scope);
};

export default rowCheckTargetRefusal;
