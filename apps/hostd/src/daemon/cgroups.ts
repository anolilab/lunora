/**
 * Per-fleet memory limits (plan 458 W8): one cgroup v2 child per fleet, with
 * `memory.max` set, under the cgroup systemd delegates to the unit
 * (`Delegate=yes`).
 *
 * cgroup v2 lets only leaf cgroups hold processes once a controller is
 * enabled for their children, so the daemon first moves itself into a `hostd`
 * child of its service cgroup, then enables the memory controller, then gives
 * each fleet a `fleet-{alias}` sibling. Caddy stays with the daemon. A fleet's
 * process is moved into its cgroup right after it is spawned — the first
 * milliseconds it runs are charged to `hostd`, which no fleet can use to get
 * past its limit.
 *
 * Delegation is only trusted when the daemon runs as a systemd service
 * (`…/{name}.service`, outside `user.slice`): anywhere else, the cgroup it sits
 * in is someone else's (a login session's, a container's) and is left alone.
 */
import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Where cgroup v2 is mounted. */
const CGROUP_ROOT = "/sys/fs/cgroup";

/** The child cgroup the daemon (and Caddy) move into. */
const HOSTD_CGROUP = "hostd";

/** Memory left to hostd, Caddy and the system when no `fleetMemoryMaxMb` is configured. */
const MEMORY_RESERVE_BYTES = 512 * 1024 * 1024;

/** The smallest default limit: a fleet below this cannot start a node. */
const MIN_FLEET_MEMORY_BYTES = 256 * 1024 * 1024;

const MIB = 1024 * 1024;

/** The unified (v2) hierarchy's line in `/proc/self/cgroup`: id 0, no controllers, then the path. */
const UNIFIED_LINE = /^0::(\/\S*)$/mu;

const WHITESPACE = /\s+/u;

/** The cgroup v2 path in `/proc/self/cgroup` (`0::/system.slice/lunora-hostd.service`), or `undefined` on a v1-only host. */
const cgroupPathOf = (procSelfCgroup: string): string | undefined => UNIFIED_LINE.exec(procSelfCgroup)?.[1];

/**
 * The service cgroup the daemon may manage, from the cgroup it is in: the
 * unit's own cgroup, or its parent when the daemon already moved into
 * `hostd`. `undefined` unless that is a systemd service outside `user.slice`.
 */
const delegatedServiceOf = (path: string): string | undefined => {
    const service = path.endsWith(`/${HOSTD_CGROUP}`) ? path.slice(0, -(HOSTD_CGROUP.length + 1)) : path;
    const leaf = service.split("/").at(-1) ?? "";

    if (!leaf.endsWith(".service") || service.startsWith("/user.slice/") || service.includes("..")) {
        return undefined;
    }

    return service;
};

/** A fleet's cgroup name. */
const fleetCgroupName = (alias: string): string => `fleet-${alias}`;

/** Each fleet's `memory.max`: the configured MiB, or the box's memory less a reserve, never under 256 MiB. */
const fleetMemoryMax = (totalMemoryBytes: number, configuredMb?: number): number =>
    configuredMb === undefined ? Math.max(MIN_FLEET_MEMORY_BYTES, totalMemoryBytes - MEMORY_RESERVE_BYTES) : configuredMb * MIB;

interface CgroupSetup {
    /** Each fleet's `memory.max`, in bytes. */
    memoryMax: number;
    /** The daemon's pid, moved into `hostd`. */
    pid: number;
    /** `/proc/self/cgroup`, as read. */
    procSelfCgroup: string;
    /** Where cgroup v2 is mounted (a temp directory in tests). */
    root?: string;
}

/** The fleets' cgroups under one delegated service cgroup. */
class CgroupManager {
    /**
     * Take over the delegated service cgroup: move the daemon into `hostd` and
     * enable the memory controller for its children.
     * @throws {Error} naming what is missing: no cgroup v2, no delegation, no memory controller, no write access.
     */
    public static setUp(setup: CgroupSetup): CgroupManager {
        const path = cgroupPathOf(setup.procSelfCgroup);

        if (path === undefined) {
            throw new Error("no cgroup v2 hierarchy (/proc/self/cgroup has no 0:: line)");
        }

        const service = delegatedServiceOf(path);

        if (service === undefined) {
            throw new Error(`not running as a systemd service with Delegate=yes (cgroup ${path})`);
        }

        const base = join(setup.root ?? CGROUP_ROOT, service);
        let controllers: string;

        try {
            controllers = readFileSync(join(base, "cgroup.controllers"), "utf8");
        } catch (error) {
            throw new Error(`cannot read ${join(base, "cgroup.controllers")}: ${(error as Error).message}`, { cause: error });
        }

        if (!controllers.split(WHITESPACE).includes("memory")) {
            throw new Error(`the memory controller is not delegated to ${service} (Delegate=yes in the unit)`);
        }

        try {
            mkdirSync(join(base, HOSTD_CGROUP), { recursive: true });
            writeFileSync(join(base, HOSTD_CGROUP, "cgroup.procs"), String(setup.pid));
            writeFileSync(join(base, "cgroup.subtree_control"), "+memory");
        } catch (error) {
            throw new Error(`cannot manage ${service}: ${(error as Error).message}`, { cause: error });
        }

        return new CgroupManager(base, setup.memoryMax);
    }

    /** The service cgroup's directory. */
    public readonly base: string;

    private readonly memoryMax: number;

    private constructor(base: string, memoryMax: number) {
        this.base = base;
        this.memoryMax = memoryMax;
    }

    /** The directory of `alias`'s cgroup. */
    public pathOf(alias: string): string {
        return join(this.base, fleetCgroupName(alias));
    }

    /**
     * Put `pid` (a fleet's node) into `alias`'s cgroup, creating it with its
     * `memory.max` (and no swap) first.
     * @throws {Error} when the cgroup cannot be made or the process moved.
     */
    public attach(alias: string, pid: number): void {
        const directory = this.pathOf(alias);

        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "memory.max"), String(this.memoryMax));

        try {
            writeFileSync(join(directory, "memory.swap.max"), "0");
        } catch {
            // No swap accounting on this kernel: memory.max still holds.
        }

        writeFileSync(join(directory, "cgroup.procs"), String(pid));
    }

    /** Remove `alias`'s cgroup once its node has exited; a cgroup still in use is left. */
    public release(alias: string): void {
        try {
            rmdirSync(this.pathOf(alias));
        } catch {
            // Gone already, or not empty yet: the next attach reuses it.
        }
    }
}

export type { CgroupSetup };
export { CGROUP_ROOT, CgroupManager, cgroupPathOf, delegatedServiceOf, fleetCgroupName, fleetMemoryMax, HOSTD_CGROUP, MEMORY_RESERVE_BYTES };
