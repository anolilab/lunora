/**
 * The box the `test:hostd` lane drives (plan 458 W4 gate, W8 probe suite).
 *
 * It reads:
 *
 * - `LUNORA_CELLD_BIN` — celld (the pinned v0.6.0 release asset);
 * - `LUNORA_CADDY_BIN` — Caddy built with `caddy-ratelimit`;
 * - `LUNORA_HOSTD_S3_ENDPOINT` — an S3-compatible endpoint (moto in CI);
 * - `LUNORA_HOSTD_BIN` — the `lunora-hostd` single executable; without it the
 * lane runs `node dist/bin.mjs` (build the package first);
 * - `LUNORA_HOSTD_ISOLATION=1` — root on a systemd host (the CI runner, under
 * sudo): the box is set up with install.sh's own functions at the real paths
 * (`/opt`, `/etc`, `/var/lib/lunora-hostd`), hostd runs under the real unit,
 * and the isolation is asserted. Without it, hostd runs as the current user
 * in a temp directory, enrolled `--single-trust`.
 *
 * A gate that is on and finds a binary missing fails; it never skips.
 */
import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The `PATH` every process the lane starts gets: system directories only. */
const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** A system tool's absolute path; the lane never resolves a command through `PATH`. */
const tool = (name: string): string => {
    const found = ["/usr/sbin", "/usr/bin", "/sbin", "/bin"].map((directory) => join(directory, name)).find((path) => existsSync(path));

    if (found === undefined) {
        throw new Error(`the test:hostd lane needs ${name}`);
    }

    return found;
};

const INSTALL_SCRIPT = join(PACKAGE_DIRECTORY, "install", "install.sh");

/** The release the lane installs, as install.sh lays one out. */
const LANE_RELEASE = "hostd-v0_0_0-lane";

const required = (name: string): string => {
    const value = process.env[name];

    if (value === undefined || value === "") {
        throw new Error(`${name} is not set: the test:hostd lane needs it (see __tests__/integration/lane.ts)`);
    }

    return value;
};

/** Whether this run sets the box up as root under systemd, and asserts its isolation. */
const ISOLATED = process.env["LUNORA_HOSTD_ISOLATION"] === "1";

/** What a one-shot command printed and how it ended. */
interface RunResult {
    code: number | null;
    output: string;
}

/** Run `command args` to completion with `env`, capturing its output. */
const run = async (command: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv, cwd?: string): Promise<RunResult> =>
    new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";

        child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.once("error", reject);
        child.once("exit", (code) => {
            resolve({ code, output });
        });
    });

/** The enrolment flags both modes pass. */
interface EnrolInput {
    bucket: string;
    controlPlane: string;
    endpoint: string;
    token: string;
}

/** The S3 credentials the lane's bucket accepts (moto takes any). */
const LANE_CREDENTIALS = { AWS_ACCESS_KEY_ID: "lane-access-key", AWS_SECRET_ACCESS_KEY: "lane-secret-key" } as const;

/** How a box is laid out and run. */
interface LaneBoxOptions {
    /** Extra environment for the daemon (the systemd box gets it as a unit drop-in). */
    environment?: Readonly<Record<string, string>>;

    /**
     * Lay the first release out in the install directory, `current` included;
     * the lane's own release (the binaries under test) when absent.
     */
    layout?: (installDirectory: string) => Promise<void> | void;
}

interface LaneBox {
    configPath: string;
    dataDir: string;
    /** Enrol the box (`lunora-hostd enrol`), as install.sh would. */
    enrol: (input: EnrolInput) => Promise<RunResult>;
    /** Where the releases are: `{installDir}/current` the one that runs. */
    installDir: string;
    isolated: boolean;
    /** What hostd has logged so far. */
    logs: () => string;
    /** Remove everything the lane installed. */
    remove: () => Promise<void>;
    /** Start the daemon. Like systemd's `Restart=always`, a daemon that exits 0 (after replacing itself) is started again. */
    start: () => Promise<void>;
    /** Stop the daemon; resolves its exit status. */
    stop: () => Promise<number | null>;
}

const writeJson = (path: string, value: unknown): void => {
    writeFileSync(path, `${JSON.stringify(value, undefined, 4)}\n`);
};

/**
 * Lay a release out in `installDirectory`: the three binaries, a manifest,
 * `current` pointing at it. The systemd box copies the binaries (they must
 * live under `/opt`, owned by `lunora-hostd`); the local one links them,
 * which keeps each binary at the path a workstation's application firewall
 * already knows.
 */
const installRelease = (installDirectory: string, hostd: string | undefined, place: "copy" | "link"): void => {
    const release = join(installDirectory, LANE_RELEASE);
    const put = (source: string, name: string): void => {
        if (place === "copy") {
            copyFileSync(source, join(release, name));
            chmodSync(join(release, name), 0o755);
        } else {
            symlinkSync(source, join(release, name));
        }
    };

    mkdirSync(release, { recursive: true });
    put(required("LUNORA_CELLD_BIN"), "celld");
    put(required("LUNORA_CADDY_BIN"), "caddy");

    if (hostd === undefined) {
        // No single executable: the built bundle on this machine's node.
        writeFileSync(join(release, "lunora-hostd"), `#!/bin/sh\nexec "${process.execPath}" "${join(PACKAGE_DIRECTORY, "dist", "bin.mjs")}" "$@"\n`, {
            mode: 0o755,
        });
    } else {
        put(hostd, "lunora-hostd");
    }

    writeFileSync(join(release, "manifest.json"), "{}\n");
    symlinkSync(LANE_RELEASE, join(installDirectory, "current"));
};

/** The daemon as the current user, in a temp directory: functional, not isolated. */
const localBox = async (options: LaneBoxOptions): Promise<LaneBox> => {
    const root = mkdtempSync(join(tmpdir(), "lunora-hostd-lane-"));
    const installDirectory = join(root, "opt");
    const configPath = join(root, "etc", "config.json");
    const dataDirectory = join(root, "data");
    const hostd = join(installDirectory, "current", "lunora-hostd");
    let daemon: ChildProcess | undefined;
    let stopping = false;
    let output = "";

    mkdirSync(installDirectory, { recursive: true });

    if (options.layout === undefined) {
        installRelease(installDirectory, process.env["LUNORA_HOSTD_BIN"], "link");
    } else {
        await options.layout(installDirectory);
    }

    const spawnDaemon = (): void => {
        // `current/lunora-hostd` is resolved at each start: after an upgrade, the new release's.
        const child = spawn(hostd, ["run", "--config", configPath], { env: { PATH: SYSTEM_PATH, ...options.environment }, stdio: ["ignore", "pipe", "pipe"] });

        daemon = child;
        child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        child.once("exit", (code) => {
            if (code === 0 && !stopping) {
                setTimeout(spawnDaemon, 1000);
            }
        });
    };

    return {
        configPath,
        dataDir: dataDirectory,
        enrol: async (input) =>
            run(
                hostd,
                [
                    "enrol",
                    "--config",
                    configPath,
                    "--data-dir",
                    dataDirectory,
                    "--install-dir",
                    installDirectory,
                    "--control-plane",
                    input.controlPlane,
                    "--bucket",
                    input.bucket,
                    "--endpoint",
                    input.endpoint,
                    "--region",
                    "us-east-1",
                    "--ipv4",
                    "203.0.113.10",
                    "--single-trust",
                ],
                { ...LANE_CREDENTIALS, LUNORA_HOSTD_ENROL_TOKEN: input.token, PATH: SYSTEM_PATH },
            ),
        installDir: installDirectory,
        isolated: false,
        logs: () => output,
        remove: async () => {
            rmSync(root, { force: true, recursive: true });
        },
        start: async () => {
            stopping = false;
            spawnDaemon();
        },
        stop: async () =>
            new Promise((resolve) => {
                stopping = true;

                if (daemon?.exitCode !== null) {
                    resolve(daemon?.exitCode ?? null);

                    return;
                }

                daemon.once("exit", (code) => {
                    resolve(code);
                });
                daemon.kill("SIGTERM");
            }),
    };
};

/** Run install.sh's own functions (`script`, after sourcing it) as root, with `args` as `$@`. */
const installFunctions = async (script: string, args: ReadonlyArray<string> = [], env: NodeJS.ProcessEnv = {}): Promise<RunResult> =>
    run(tool("bash"), ["-c", `set -euo pipefail; source "${INSTALL_SCRIPT}"; ${script}`, "bash", ...args], { PATH: SYSTEM_PATH, ...env });

const mustSucceed = (result: RunResult, what: string): void => {
    if (result.code !== 0) {
        throw new Error(`${what} failed (${String(result.code)}):\n${result.output}`);
    }
};

/** The enrolment, as install.sh's `enrol` runs it: the token from `$LANE_TOKEN`, the flags as `$@`. */
const ENROL_SCRIPT = 'TOKEN="$LANE_TOKEN"; ENROL_ARGS=("$@"); enrol';

/** Where the systemd box's unit takes extra environment from (a drop-in). */
const LANE_DROP_IN = "/etc/systemd/system/lunora-hostd.service.d/lane.conf";

/** The daemon under the real systemd unit, set up by install.sh's functions at the real paths. */
const systemdBox = async (options: LaneBoxOptions): Promise<LaneBox> => {
    if (process.getuid?.() !== 0) {
        throw new Error("LUNORA_HOSTD_ISOLATION=1 needs root (run the lane under sudo)");
    }

    mustSucceed(await installFunctions("install_packages; create_users; create_directories"), "install_packages / create_users / create_directories");

    if (options.layout === undefined) {
        installRelease("/opt/lunora-hostd", required("LUNORA_HOSTD_BIN"), "copy");
    } else {
        await options.layout("/opt/lunora-hostd");
    }

    execFileSync(tool("chown"), ["-R", "-h", "lunora-hostd:lunora-hostd", "/opt/lunora-hostd"]);
    mustSucceed(await installFunctions("install_unit"), "install_unit");

    if (options.environment !== undefined) {
        mkdirSync(dirname(LANE_DROP_IN), { recursive: true });
        writeFileSync(
            LANE_DROP_IN,
            `[Service]\n${Object.entries(options.environment)
                .map(([name, value]) => `Environment=${name}=${value}\n`)
                .join("")}`,
        );
        execFileSync(tool("systemctl"), ["daemon-reload"]);
    }

    const configPath = "/etc/lunora-hostd/config.json";

    return {
        configPath,
        dataDir: "/var/lib/lunora-hostd",
        enrol: async (input) =>
            installFunctions(
                ENROL_SCRIPT,
                [
                    "--control-plane",
                    input.controlPlane,
                    "--bucket",
                    input.bucket,
                    "--endpoint",
                    input.endpoint,
                    "--region",
                    "us-east-1",
                    "--ipv4",
                    "203.0.113.10",
                ],
                { ...LANE_CREDENTIALS, LANE_TOKEN: input.token },
            ),
        installDir: "/opt/lunora-hostd",
        isolated: true,
        logs: () => {
            try {
                return execFileSync(tool("journalctl"), ["--unit", "lunora-hostd", "--no-pager", "--output", "cat"], { encoding: "utf8" });
            } catch {
                return "";
            }
        },
        remove: async () => {
            rmSync(dirname(LANE_DROP_IN), { force: true, recursive: true });
            mustSucceed(await run(tool("bash"), [INSTALL_SCRIPT, "--uninstall"], { PATH: SYSTEM_PATH }), "install.sh --uninstall");
        },
        start: async () => {
            mustSucceed(await installFunctions("start_service"), "start_service");
        },
        stop: async () => {
            execFileSync(tool("systemctl"), ["stop", "lunora-hostd"]);

            return Number(execFileSync(tool("systemctl"), ["show", "--property", "ExecMainStatus", "--value", "lunora-hostd"], { encoding: "utf8" }).trim());
        },
    };
};

/** The box for this run: the systemd one when `LUNORA_HOSTD_ISOLATION=1`. */
const createLaneBox = async (options: LaneBoxOptions = {}): Promise<LaneBox> => (ISOLATED ? systemdBox(options) : localBox(options));

/** Rewrite the enrolled config in place, so it keeps its owner and mode. */
const patchConfig = (path: string, patch: (config: Record<string, unknown>) => Record<string, unknown>): void => {
    writeJson(path, patch(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>));
};

export type { EnrolInput, LaneBox, LaneBoxOptions, RunResult };
export { createLaneBox, ISOLATED, LANE_CREDENTIALS, LANE_RELEASE, patchConfig, required, run, SYSTEM_PATH, tool };
