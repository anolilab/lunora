/**
 * Decide whether a URL may stand in for the deployment `lunora deploy` is about
 * to ship to, as the drift gate's stored-row evidence. Rows read anywhere else —
 * a dev worker, another environment — can fit a tightening that production's
 * rows break, and the gate would then wave the change through to production.
 */
import { readLinkedProject } from "@lunora/config";
import { findWranglerFile, readWranglerJsonc } from "@lunora/config/cloudflare";

interface WranglerNames {
    env?: Record<string, { name?: unknown } | undefined>;
    name?: unknown;
}

/** Host suffixes and exact names that only ever reach this machine or a private network. */
const PRIVATE_NAMES = new Set(["0.0.0.0", "[::1]", "[::]", "localhost"]);
const PRIVATE_SUFFIXES = [".local", ".localhost"];
const PRIVATE_IPV6_PREFIXES = ["[fc", "[fd", "[fe80:"];

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

/** Whether `host` can only be a dev worker, never a deployed one. */
const isPrivateHost = (host: string): boolean => {
    const lower = host.toLowerCase();

    return (
        PRIVATE_NAMES.has(lower) ||
        PRIVATE_SUFFIXES.some((suffix) => lower.endsWith(suffix)) ||
        PRIVATE_IPV6_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
        isPrivateIpv4(lower)
    );
};

/**
 * The Worker name Wrangler deploys for `environment`: the env block's own
 * `name`, else `<name>-<env>`, else the top-level `name`.
 */
const deployedWorkerName = (cwd: string, environment: string | undefined): string | undefined => {
    const wranglerPath = findWranglerFile(cwd);
    const parsed = wranglerPath === undefined ? undefined : readWranglerJsonc<WranglerNames>(wranglerPath).parsed;
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
 * Why `url` is not evidence about this deploy's target, or `undefined` when it
 * is. The link recorded for this `--env` is the target when there is one; a
 * `*.workers.dev` host must otherwise carry the Worker name Wrangler deploys. A
 * custom domain with no link cannot be compared, and is taken at its word.
 */
const rowCheckTargetRefusal = (cwd: string, environment: string | undefined, url: string): string | undefined => {
    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        return `refused ${url} as the deployment to read rows from: it is not a URL`;
    }

    if (isPrivateHost(parsed.hostname)) {
        return `refused ${parsed.origin} as the deployment to read rows from: it is a local or private address, not the worker this deploy ships to`;
    }

    const link = readLinkedProject(cwd);

    if (link?.workerUrl !== undefined && link.env === environment && URL.canParse(link.workerUrl)) {
        const linked = new URL(link.workerUrl).origin;

        if (linked === parsed.origin) {
            return undefined;
        }

        const scope = environment === undefined ? "" : ` for --env ${environment}`;

        return `refused ${parsed.origin} as the deployment to read rows from: this checkout is linked to ${linked}${scope}`;
    }

    const worker = deployedWorkerName(cwd, environment);

    if (worker !== undefined && parsed.hostname.endsWith(".workers.dev") && parsed.hostname.split(".")[0] !== worker) {
        return `refused ${parsed.origin} as the deployment to read rows from: this deploy ships the Worker "${worker}"${environment === undefined ? "" : ` (--env ${environment})`}`;
    }

    return undefined;
};

export default rowCheckTargetRefusal;
