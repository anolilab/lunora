/**
 * Dev-server port pair for the checkout a process runs in.
 *
 * The playground (`:5173`) and the studio (`:5174`) used to be pinned, so two
 * git worktrees running dev servers at once fought over the same pair. Here the
 * pair is shifted by an offset: the main checkout and CI keep the legacy pair, a
 * linked worktree gets a stable offset hashed from its absolute root, and
 * `LUNORA_DEV_PORT_OFFSET` (an integer; `0` forces the legacy pair) overrides both.
 *
 * Both ports of the pair move together, and so does every other port in
 * {@link PINNED_PORT_BASES}. An offset that puts any of them on a browser-blocked
 * port (Fetch spec "bad ports") or out of range is skipped forward. Vite keeps `strictPort`: a taken port fails loudly, it never drifts.
 *
 * Zero-dependency (node built-ins and the sibling {@link file://./fnv1a.ts}), so
 * consumers import it by relative path and the bundler inlines it.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { fnv1aHex } from "./fnv1a";

export const LEGACY_PLAYGROUND_PORT = 5173;
export const LEGACY_STUDIO_PORT = 5174;

/**
 * The other ports this repo pins: the blog, the e2e example servers, and the workerd
 * inspector each example pins. They move with the pair, so checkouts that run the same
 * example at once do not collide on them.
 */
export const PINNED_PORT_BASES: readonly number[] = [5175, 5273, 5274, 5275, 5276, 5277, 5278, 9229, 9230, 9231, 9232, 9233];

/** Derived offsets fall in `1..OFFSET_RANGE`; `0` is reserved for the legacy pair. */
const OFFSET_RANGE = 2999;

const MAX_PORT = 65535;

/** Fetch spec "bad ports": browsers refuse to load these, so a dev server on one looks broken. */
export const BLOCKED_PORTS: ReadonlySet<number> = new Set([
    0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135,
    137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
    1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

const ENV_OFFSET = "LUNORA_DEV_PORT_OFFSET";

export type DevEnv = Readonly<Record<string, string | undefined>>;

export interface DevPorts {
    readonly offset: number;
    readonly playground: number;
    readonly studio: number;
    /** Where the offset came from: an explicit env var, the worktree hash, or the legacy pair. */
    readonly source: "derived" | "env" | "legacy";
}

export interface DevPortInputs {
    env: DevEnv;
    /** Absolute checkout root: the directory holding `.git`. */
    root: string;
    /** True for a linked git worktree, where `.git` is a file rather than a directory. */
    linked: boolean;
}

const isUsablePort = (port: number): boolean => port <= MAX_PORT && !BLOCKED_PORTS.has(port);

const isUsablePair = (offset: number): boolean =>
    [LEGACY_PLAYGROUND_PORT, LEGACY_STUDIO_PORT, ...PINNED_PORT_BASES].every((base) => isUsablePort(base + offset));

/** A pinned port (the `base`) moved by the checkout's offset. */
export const shiftedPort = (base: number, ports: DevPorts): number => base + ports.offset;

const withOffset = (offset: number, source: DevPorts["source"]): DevPorts => ({
    offset,
    playground: LEGACY_PLAYGROUND_PORT + offset,
    source,
    studio: LEGACY_STUDIO_PORT + offset,
});

/** The stable offset for `root`, before skipping blocked pairs. Same path, same value, across restarts. */
export const hashPortOffset = (root: string): number => (Number.parseInt(fnv1aHex(root), 16) % OFFSET_RANGE) + 1;

/** The offset for `root` once blocked or out-of-range pairs are skipped forward (wrapping inside `1..OFFSET_RANGE`). */
export const derivePortOffset = (root: string): number => {
    let offset = hashPortOffset(root);

    for (let attempt = 0; attempt < OFFSET_RANGE; attempt += 1) {
        if (isUsablePair(offset)) {
            return offset;
        }

        offset = (offset % OFFSET_RANGE) + 1;
    }

    throw new Error("[dev-ports] no usable dev port offset exists");
};

/** Resolve the pair from explicit inputs. Pure: no filesystem or process access. */
export const resolveDevPorts = ({ env, linked, root }: DevPortInputs): DevPorts => {
    const explicit = env[ENV_OFFSET]?.trim();

    if (explicit !== undefined && explicit !== "") {
        if (!/^\d+$/u.test(explicit)) {
            throw new Error(`[dev-ports] ${ENV_OFFSET} must be a non-negative integer, got "${explicit}".`);
        }

        const offset = Number(explicit);

        if (offset === 0) {
            return withOffset(0, "legacy");
        }

        if (!isUsablePair(offset)) {
            throw new Error(`[dev-ports] ${ENV_OFFSET}=${explicit} puts the dev ports out of range or on a browser-blocked port; pick another offset.`);
        }

        return withOffset(offset, "env");
    }

    if (env.CI !== undefined && env.CI !== "") {
        return withOffset(0, "legacy");
    }

    if (!linked) {
        return withOffset(0, "legacy");
    }

    return withOffset(derivePortOffset(root), "derived");
};

/**
 * Walk up from `start` to the nearest `.git` entry. `linked` is true when that
 * entry is a file, which is how git represents a linked worktree. Returns
 * `undefined` outside any checkout. The root is `realpath`ed so a symlinked path
 * hashes to the same offset as the real one.
 */
export const findCheckoutRoot = (start: string): { linked: boolean; root: string } | undefined => {
    let dir = resolve(start);

    while (true) {
        const marker = join(dir, ".git");

        if (existsSync(marker)) {
            return { linked: statSync(marker).isFile(), root: realpathSync(dir) };
        }

        const parent = dirname(dir);

        if (parent === dir) {
            return undefined;
        }

        dir = parent;
    }
};

/** The ports for the checkout containing `start` (default: the working directory). Node-only. */
export const devPortsFor = (env: DevEnv = process.env, start: string = process.cwd()): DevPorts => {
    const checkout = findCheckoutRoot(start);

    return resolveDevPorts({ env, linked: checkout?.linked ?? false, root: checkout?.root ?? resolve(start) });
};

/** One line for a dev server's startup log, so a human or agent reads the ports instead of guessing them. */
export const describeDevPorts = (ports: DevPorts): string =>
    `dev ports: playground :${String(ports.playground)}, studio :${String(ports.studio)} (offset ${String(ports.offset)}, ${ports.source})`;

/**
 * The `LUNORA_ORIGIN_URL` a `.dev.vars` file sets when it is a loopback URL on a port other than
 * `port`, else `undefined`. The scheduler dispatches its callbacks to that variable and cannot be
 * steered at runtime, so a worktree whose copy still names another checkout's port sends its
 * scheduled jobs to that checkout instead of failing.
 */
export const staleDevOrigin = (devVars: string, port: number): string | undefined => {
    const match = /^\s*LUNORA_ORIGIN_URL\s*=\s*["']?([^"'\s#]+)/mu.exec(devVars);

    if (match === null) {
        return undefined;
    }

    const value = match[1] as string;

    try {
        const url = new URL(value);

        return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.port !== String(port) ? value : undefined;
    } catch {
        return undefined;
    }
};
