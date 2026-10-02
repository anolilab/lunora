/**
 * Fleet isolation on the box (plan 458 W8) and the self-check that decides
 * whether fleets may start at all.
 *
 * The box is single-customer, but its apps run third-party npm code. What
 * stands between that code (should it escape its isolate) and hostd's key,
 * the celld operator API and the rest of the machine:
 *
 * - **its own user.** Every celld process (nodes, `celld deploy`, `celld
 * diagnose`) runs as `lunora-fleet`, with no capabilities, `no_new_privs`, and
 * an allowlisted environment (`fleet-environment.ts`). `/etc/lunora-hostd`
 * (key, bucket credentials) is `lunora-hostd`'s, mode 0700;
 * - **an egress policy** (`nftables.ts`): no loopback, private, link-local,
 * metadata or CGNAT address, except DNS and the bucket endpoint;
 * - **a memory limit** per fleet (`cgroups.ts`).
 *
 * Each of the three is checked at start: the fleet user exists and a process
 * started as it really has its uid and no capabilities; the nftables table is
 * loaded; the delegated cgroup takes the memory controller. All three pass:
 * `enforced`. One fails and the box was enrolled with `--single-trust`:
 * `single-trust`, fleets start with whatever does work. One fails otherwise:
 * `refused`, and no fleet starts — a `deploy` fails with `ISOLATION_FAILED`.
 * The outcome, with each failed check, goes to the control plane in every
 * `hello` and to `diagnose`.
 */
import { spawn } from "node:child_process";
import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";

import { HOSTD_PROTOCOL_LIMITS } from "../wire/constants";
import type { BoxIsolation, IsolationStatus } from "../wire/types";
import type { Account } from "./accounts";
import { lookupAccount } from "./accounts";
import type { ChildLaunch } from "./capabilities";
import { dropCapabilitiesPrefix, hasCapability, launchCommand, launchIdentity, parseProcessStatus } from "./capabilities";
import { CgroupManager, fleetMemoryMax } from "./cgroups";
import type { HostdConfig } from "./config";
import { CHILD_PATH } from "./fleet-environment";
import { truncateUtf8 } from "./job-error";
import type { Logger } from "./log";
import type { FirewallSystem } from "./nftables";
import { EgressFirewall } from "./nftables";

/** One check's outcome. */
type CheckResult = { ok: false; reason: string } | { ok: true };

/** The three checks, by what they protect. */
interface IsolationChecks {
    /** Per-fleet memory limits through the delegated cgroup. */
    cgroup: CheckResult;
    /** The egress table for the fleet user. */
    egress: CheckResult;
    /** Fleets run as their own user, without capabilities. */
    user: CheckResult;
}

/** What the self-check decided. */
interface IsolationReport {
    /** Each failed check, for `hello` and `diagnose`. */
    problems: string[];
    /** Whether fleets may start. */
    startsFleets: boolean;
    status: IsolationStatus;
}

/** Each check, in the order its problem is reported, with the name it is reported under. */
const CHECKS: ReadonlyArray<readonly [keyof IsolationChecks, string]> = [
    ["user", "fleet user"],
    ["egress", "egress policy"],
    ["cgroup", "memory limits"],
];

/**
 * The decision table: every check passed → `enforced`; a check failed →
 * `single-trust` when the box was enrolled with `--single-trust` (fleets
 * start), `refused` otherwise (they do not).
 */
const decideIsolation = (checks: IsolationChecks, singleTrust: boolean): IsolationReport => {
    const problems = CHECKS.flatMap(([name, label]) => {
        const check = checks[name];

        return check.ok ? [] : [`${label}: ${check.reason}`];
    });

    if (problems.length === 0) {
        return { problems, startsFleets: true, status: "enforced" };
    }

    return singleTrust ? { problems, startsFleets: true, status: "single-trust" } : { problems, startsFleets: false, status: "refused" };
};

/** The report as `hello.isolation` carries it, held to the protocol's caps. */
const helloIsolation = (report: IsolationReport): BoxIsolation => {
    const problems = report.problems
        .slice(0, HOSTD_PROTOCOL_LIMITS.maxIsolationProblems)
        .map((problem) => truncateUtf8(problem, HOSTD_PROTOCOL_LIMITS.maxIsolationProblemBytes));

    return problems.length === 0 ? { status: report.status } : { problems, status: report.status };
};

/** What the self-check reads and runs; injected for tests. */
interface IsolationSystem {
    /** Where cgroup v2 is mounted; the real `/sys/fs/cgroup` when absent. */
    cgroupRoot?: string;
    firewall?: FirewallSystem;
    pid: number;
    /** Start `cat /proc/self/status` exactly as a fleet would be started; resolves with what it printed. */
    probe: (launch: ChildLaunch) => Promise<string>;
    /** A file's text, or `undefined` when it cannot be read. */
    readText: (path: string) => string | undefined;
    /** The `setpriv` executable, when installed. */
    setpriv: string | undefined;
    totalMemoryBytes: number;
}

/** Run `cat /proc/self/status` under `launch`. */
const probeLaunch = async (launch: ChildLaunch): Promise<string> =>
    new Promise((resolve, reject) => {
        const { args, command } = launchCommand(launch, "cat", ["/proc/self/status"]);
        const child = spawn(command, args, { env: { PATH: CHILD_PATH }, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, ...launchIdentity(launch) });
        let output = "";
        let errors = "";

        child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
            errors += chunk.toString();
        });
        child.once("error", (error) => {
            reject(error);
        });
        child.once("exit", (code) => {
            if (code === 0) {
                resolve(output);
            } else {
                reject(new Error(`${command} exited ${String(code)}: ${errors.trim().slice(0, 300)}`));
            }
        });
    });

const readTextOrUndefined = (path: string): string | undefined => {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return undefined;
    }
};

const SETPRIV_CANDIDATES = ["/usr/bin/setpriv", "/bin/setpriv"] as const;

/** The machine the daemon runs on. */
const realIsolationSystem = (): IsolationSystem => {
    return {
        pid: process.pid,
        probe: probeLaunch,
        readText: readTextOrUndefined,
        setpriv: SETPRIV_CANDIDATES.find((path) => existsSync(path)),
        totalMemoryBytes: totalmem(),
    };
};

/**
 * Give the fleet group passage through the data directory: `dataDir`,
 * `fleets/` and `releases/` become `{owner}:{fleet group}` 0710 — the fleet
 * user can reach its own working directory and the release it deploys, and
 * list neither.
 */
const prepareDataDirectory = (dataDirectory: string, account: Account): void => {
    for (const path of [dataDirectory, join(dataDirectory, "fleets"), join(dataDirectory, "releases")]) {
        mkdirSync(path, { mode: 0o710, recursive: true });
        chownSync(path, -1, account.gid);
        chmodSync(path, 0o710);
    }
};

/** Make a release directory readable to the fleet group (`celld deploy` runs as the fleet user): dirs 0750, files 0640. */
const shareWithFleet = (directory: string, account: Account): void => {
    chownSync(directory, -1, account.gid);
    chmodSync(directory, 0o750);

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);

        if (entry.isDirectory()) {
            shareWithFleet(path, account);
        } else if (entry.isFile()) {
            chownSync(path, -1, account.gid);
            chmodSync(path, 0o640);
        }
    }
};

/**
 * A fleet's working directory (`{dataDir}/fleets/{alias}`), created when
 * missing: the fleet user's own, mode 0700, when fleets run as one.
 * @returns its path
 */
const ensureFleetDirectory = (dataDirectory: string, alias: string, account: Account | undefined): string => {
    const directory = join(dataDirectory, "fleets", alias);

    if (!existsSync(directory)) {
        mkdirSync(directory, { mode: 0o700, recursive: true });

        if (account !== undefined) {
            chownSync(directory, account.uid, account.gid);
        }
    }

    return directory;
};

/** Run `command args` under `launch` to completion; rejects on a non-zero exit. */
const runUnder = async (launch: ChildLaunch, command: string, args: ReadonlyArray<string>): Promise<void> =>
    new Promise((resolve, reject) => {
        const launched = launchCommand(launch, command, args);
        const child = spawn(launched.command, launched.args, {
            env: { PATH: CHILD_PATH },
            stdio: ["ignore", "ignore", "pipe"],
            timeout: 120_000,
            ...launchIdentity(launch),
        });
        let errors = "";

        child.stderr.on("data", (chunk: Buffer) => {
            errors += chunk.toString();
        });
        child.once("error", reject);
        child.once("exit", (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${command} exited ${String(code)}: ${errors.trim().slice(0, 300)}`));
            }
        });
    });

/**
 * Delete a fleet's working directory. A fleet user's directory is emptied as
 * that user (the daemon may not read it), then removed by the daemon, which
 * owns `fleets/`.
 */
const removeFleetDirectory = async (dataDirectory: string, alias: string, launch: ChildLaunch, account: Account | undefined): Promise<void> => {
    const directory = join(dataDirectory, "fleets", alias);

    if (account !== undefined && existsSync(directory)) {
        await runUnder(launch, "find", [directory, "-mindepth", "1", "-delete"]);
    }

    rmSync(directory, { force: true, recursive: true });
};

/** The box's isolation, as set up at start. */
interface Isolation {
    /** The fleet user, when fleets run as one. */
    account?: Account;
    /** How Caddy is started: without the capabilities it does not need. */
    caddy: ChildLaunch;
    cgroups?: CgroupManager;
    /** How every celld process is started. */
    fleet: ChildLaunch;
    report: IsolationReport;
    /** Stop the egress table's refresh. */
    stop: () => void;
}

const failure = (reason: string): CheckResult => {
    return { ok: false, reason };
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Whether a process started under `launch` runs as `account` with no capabilities. */
const checkFleetUser = async (system: IsolationSystem, launch: ChildLaunch, account: Account): Promise<CheckResult> => {
    const { user } = account;
    let output: string;

    try {
        output = await system.probe(launch);
    } catch (error) {
        return failure(`cannot start a process as ${user} (${errorText(error)}); the daemon needs CAP_SETUID and CAP_SETGID, which the systemd unit grants`);
    }

    const privileges = parseProcessStatus(output);

    if (privileges?.uid !== account.uid) {
        return failure(`a process started as ${user} did not run with uid ${String(account.uid)}`);
    }

    if (privileges.effective !== 0n || privileges.ambient !== 0n || !privileges.noNewPrivs) {
        return failure(`a process started as ${user} kept capabilities or may gain new ones`);
    }

    return { ok: true };
};

/**
 * The `setpriv` prefixes for fleets (drop everything) and Caddy (keep port
 * binding when the daemon holds it). Used whenever setpriv is installed, so
 * every child runs with `no_new_privs`; essential when the daemon holds
 * ambient capabilities (the systemd unit's), which children would inherit.
 */
const childPrefixes = (system: IsolationSystem, ambient: bigint): { caddy: string[]; fleet: string[] } => {
    if (system.setpriv === undefined) {
        return { caddy: [], fleet: [] };
    }

    const keep = hasCapability(ambient, "net_bind_service") ? (["net_bind_service"] as const) : [];

    return { caddy: dropCapabilitiesPrefix(system.setpriv, keep), fleet: dropCapabilitiesPrefix(system.setpriv) };
};

/** The fleet-user check, and the account when it passed. */
const setUpFleetUser = async (
    config: HostdConfig,
    system: IsolationSystem,
    ambient: bigint,
    prefix: ReadonlyArray<string>,
): Promise<{ account?: Account; check: CheckResult }> => {
    const account = lookupAccount(config.fleetUser, system.readText("/etc/passwd") ?? "");

    if (account === undefined) {
        return { check: failure(`no local user ${config.fleetUser} (install.sh creates it)`) };
    }

    if (ambient !== 0n && system.setpriv === undefined) {
        return { check: failure("setpriv (util-linux) is not installed, so children would inherit the daemon's capabilities") };
    }

    const check = await checkFleetUser(system, { gid: account.gid, prefix, uid: account.uid }, account);

    if (!check.ok) {
        return { check };
    }

    try {
        prepareDataDirectory(config.dataDir, account);
    } catch (error) {
        return { check: failure(`cannot hand ${config.dataDir} to group ${config.fleetUser}: ${errorText(error)}`) };
    }

    return { account, check };
};

/** The egress check: the table installed for `account`, and its refresher when it passed. */
const setUpEgress = async (
    config: HostdConfig,
    logger: Logger,
    system: IsolationSystem,
    account: Account | undefined,
): Promise<{ check: CheckResult; firewall?: EgressFirewall }> => {
    if (account === undefined) {
        return { check: failure("not applied: fleets do not run as their own user") };
    }

    const firewall = new EgressFirewall({
        bucket: config.bucket,
        fleetUid: account.uid,
        logger,
        ...(system.firewall === undefined ? {} : { system: system.firewall }),
    });

    try {
        await firewall.install();

        return { check: { ok: true }, firewall };
    } catch (error) {
        firewall.stop();

        return { check: failure(`could not install the nftables table (${errorText(error)}); the daemon needs CAP_NET_ADMIN and nft`) };
    }
};

/** The memory-limit check, and the cgroups when it passed. */
const setUpCgroups = (config: HostdConfig, system: IsolationSystem): { cgroups?: CgroupManager; check: CheckResult } => {
    try {
        const cgroups = CgroupManager.setUp({
            memoryMax: fleetMemoryMax(system.totalMemoryBytes, config.fleetMemoryMaxMb),
            pid: system.pid,
            procSelfCgroup: system.readText("/proc/self/cgroup") ?? "",
            ...(system.cgroupRoot === undefined ? {} : { root: system.cgroupRoot }),
        });

        return { cgroups, check: { ok: true } };
    } catch (error) {
        return { check: failure(errorText(error)) };
    }
};

const logReport = (report: IsolationReport, logger: Logger): void => {
    for (const problem of report.problems) {
        logger.warn(`isolation: ${problem}`);
    }

    if (report.status === "refused") {
        logger.error("isolation self-check failed: no fleet starts on this box. Fix the problems above, or enrol with --single-trust to run fleets anyway");
    } else {
        logger.info(`isolation: ${report.status}`);
    }
};

/**
 * Set up and check the box's isolation: the fleet user, the egress table, the
 * memory cgroups — then decide whether fleets may start.
 */
const setUpIsolation = async (config: HostdConfig, logger: Logger, system: IsolationSystem = realIsolationSystem()): Promise<Isolation> => {
    const ambient = parseProcessStatus(system.readText("/proc/self/status") ?? "")?.ambient ?? 0n;
    const prefixes = childPrefixes(system, ambient);
    const user = await setUpFleetUser(config, system, ambient, prefixes.fleet);
    const egress = await setUpEgress(config, logger, system, user.account);
    const memory = setUpCgroups(config, system);
    const report = decideIsolation({ cgroup: memory.check, egress: egress.check, user: user.check }, config.singleTrust);
    const { account } = user;

    logReport(report, logger);

    return {
        ...(account === undefined ? {} : { account }),
        caddy: { prefix: prefixes.caddy },
        ...(memory.cgroups === undefined ? {} : { cgroups: memory.cgroups }),
        fleet: account === undefined ? { prefix: prefixes.fleet } : { gid: account.gid, prefix: prefixes.fleet, uid: account.uid },
        report,
        stop: () => {
            egress.firewall?.stop();
        },
    };
};

export type { CheckResult, Isolation, IsolationChecks, IsolationReport, IsolationSystem };
export {
    decideIsolation,
    ensureFleetDirectory,
    helloIsolation,
    prepareDataDirectory,
    realIsolationSystem,
    removeFleetDirectory,
    setUpIsolation,
    shareWithFleet,
};
