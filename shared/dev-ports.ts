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
 * {@link PINNED_PORT_BASES}. A derived offset is a multiple of {@link OFFSET_STRIDE}: no two
 * pinned ports are a multiple of the stride apart, so two checkouts with different offsets never
 * share a port. The hash has only a fixed number of slots, though, so two linked worktrees can
 * hash to the same slot and get the same pair; set `LUNORA_DEV_PORT_OFFSET` on one of them. An explicit
 * `LUNORA_DEV_PORT_OFFSET` is checked for browser-blocked (Fetch spec "bad ports") and
 * out-of-range ports, and for an offset that would move one pinned port onto another. Vite keeps `strictPort`: a taken port fails loudly, it never drifts.
 *
 * Zero-dependency (node built-ins and the sibling {@link file://./fnv1a.ts}), so
 * consumers import it by relative path and the bundler inlines it.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
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

const MAX_PORT = 65535;

/**
 * The gap between derived offsets. The pinned ports' pairwise distances (1, 2, 98, 100..105,
 * 3951..4060, ...) never include a multiple of 200, so shifting by multiples of it keeps every
 * checkout's ports distinct from every other's.
 */
const OFFSET_STRIDE = 200;

/** Derived offsets are `1..OFFSET_SLOTS` strides; the highest pinned port still fits in range. */
const OFFSET_SLOTS = Math.floor((MAX_PORT - Math.max(LEGACY_STUDIO_PORT, ...PINNED_PORT_BASES)) / OFFSET_STRIDE);

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

const PORT_BASES: readonly number[] = [LEGACY_PLAYGROUND_PORT, LEGACY_STUDIO_PORT, ...PINNED_PORT_BASES];

const isUsablePair = (offset: number): boolean => PORT_BASES.every((base) => isUsablePort(base + offset));

/** The offsets a checkout can be assigned: the main checkout's 0, and every derived worktree slot. */
const ASSIGNABLE_OFFSETS: readonly number[] = [0, ...Array.from({ length: OFFSET_SLOTS }, (_, slot) => (slot + 1) * OFFSET_STRIDE)];

/**
 * An explicit offset that moves one base onto a base another assignable offset uses is a collision
 * that checkout would hit: a shift by `offset` lands on a port that `other` already owns. An offset
 * equal to `other` is the same checkout's own ports, not a shift, so it is not refused here.
 */
const collidesWithAssignedCheckout = (offset: number): boolean =>
    ASSIGNABLE_OFFSETS.some((other) => other !== offset && PORT_BASES.some((base) => PORT_BASES.some((target) => base + offset === target + other)));

/** A pinned port (the `base`) moved by the checkout's offset. */
export const shiftedPort = (base: number, ports: DevPorts): number => base + ports.offset;

const withOffset = (offset: number, source: DevPorts["source"]): DevPorts => ({
    offset,
    playground: LEGACY_PLAYGROUND_PORT + offset,
    source,
    studio: LEGACY_STUDIO_PORT + offset,
});

/** The stable offset for `root`. Same path, same value, across restarts. */
export const derivePortOffset = (root: string): number => ((Number.parseInt(fnv1aHex(root), 16) % OFFSET_SLOTS) + 1) * OFFSET_STRIDE;

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

        if (collidesWithAssignedCheckout(offset)) {
            throw new Error(`[dev-ports] ${ENV_OFFSET}=${explicit} moves a dev port onto a pinned port another checkout is assigned; pick another offset.`);
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

/** Whether `marker` is a `.git` file whose `gitdir:` points into a repository's `worktrees/` directory. */
const isLinkedWorktreePointer = (marker: string): boolean => statSync(marker).isFile() && /^gitdir:.*[/\\]worktrees[/\\]/mu.test(readFileSync(marker, "utf8"));

/**
 * Walk up from `start` to the nearest `.git` entry. `linked` is true when that
 * entry is a file pointing into a `worktrees/` directory, which is how git
 * represents a linked worktree. A submodule's `.git` file points into `modules/`
 * and is a primary checkout. Returns
 * `undefined` outside any checkout. The root is `realpath`ed so a symlinked path
 * hashes to the same offset as the real one.
 */
export const findCheckoutRoot = (start: string): { linked: boolean; root: string } | undefined => {
    let dir = resolve(start);

    while (true) {
        const marker = join(dir, ".git");

        if (existsSync(marker)) {
            return { linked: isLinkedWorktreePointer(marker), root: realpathSync(dir) };
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
 * The port the playground serves. The e2e harness can pin its own origin through
 * `LUNORA_E2E_BASE_URL`, and then Vite binds that URL's port rather than the derived one; a
 * stale-origin check that compares against the derived port would refuse the harness's own
 * `LUNORA_ORIGIN_URL`. A malformed or portless override falls back to the derived port.
 */
export const servedPlaygroundPort = (ports: DevPorts, env: DevEnv): number => {
    const base = env.LUNORA_E2E_BASE_URL;

    if (base === undefined || base === "") {
        return ports.playground;
    }

    try {
        const { port } = new URL(base);

        return port === "" ? ports.playground : Number(port);
    } catch {
        return ports.playground;
    }
};

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
