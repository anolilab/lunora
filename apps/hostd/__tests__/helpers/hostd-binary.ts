/**
 * The Rust `lunora-hostd` the tests drive as a black box (apps/hostd/daemon).
 *
 * {@link buildHostd} compiles it with cargo, debug profile, which is the one
 * profile that reads the tests' timing knobs (`LUNORA_HOSTD_REPORT_TICK_MS`,
 * `LUNORA_HOSTD_LOG_FLUSH_MS`; see `daemon/src/cli.rs`). A build may report a
 * version of its own and trust release keys of its own — the shipped binary
 * trusts only `trusted-release-keys.json` — through the two build-time
 * variables `daemon/build.rs` reads. Each variant gets a target directory of
 * its own, so switching between them never rebuilds the dependencies.
 *
 * {@link startHostd} runs `lunora-hostd run` the way systemd would: its own
 * process, stopped with SIGTERM, its log on stderr.
 */
import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CRATE_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "daemon");

/** The `PATH` a box's daemon gets from its unit: system directories only. */
const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

interface BuildOptions {
    /** `{ [keyId]: SPKI PEM }`: the release keys this build trusts instead of the committed ones. */
    trustedKeys?: Record<string, string>;
    /** What `--version` prints and `hello` reports; `0.0.0` by default. */
    version?: string;
}

const built = new Map<string, string>();

/** Build `lunora-hostd` (debug) and return the path of the binary. Cached per variant within a run. */
const buildHostd = (options: BuildOptions = {}): string => {
    const variant = createHash("sha256")
        .update(JSON.stringify([options.version ?? "", options.trustedKeys ?? null]))
        .digest("hex")
        .slice(0, 12);
    const cached = built.get(variant);

    if (cached !== undefined) {
        return cached;
    }

    const targetDirectory = join(
        CRATE_DIRECTORY,
        "target",
        "test-builds",
        options.version === undefined && options.trustedKeys === undefined ? "default" : variant,
    );
    const environment: NodeJS.ProcessEnv = { ...process.env, CARGO_TARGET_DIR: targetDirectory };

    if (options.version !== undefined) {
        environment["LUNORA_HOSTD_VERSION"] = options.version;
    }

    if (options.trustedKeys !== undefined) {
        const keysFile = join(targetDirectory, "trusted-release-keys.json");

        mkdirSync(targetDirectory, { recursive: true });
        writeFileSync(keysFile, `${JSON.stringify({ keys: options.trustedKeys })}\n`);
        environment["LUNORA_HOSTD_TRUSTED_KEYS"] = keysFile;
    }

    // eslint-disable-next-line sonarjs/no-os-command-from-path -- cargo lives wherever the developer's toolchain put it (rustup, Homebrew); this builds a test binary, it is not the daemon
    execFileSync("cargo", ["build", "--locked", "--quiet", "--manifest-path", join(CRATE_DIRECTORY, "Cargo.toml")], { env: environment, stdio: "inherit" });

    const binary = join(targetDirectory, "debug", "lunora-hostd");

    built.set(variant, binary);

    return binary;
};

interface RunningHostd {
    /** Resolves with the exit code once the daemon has exited. */
    exited: Promise<number | null>;
    /** What the daemon logged so far. */
    logs: () => string;
    process: ChildProcess;
    /** SIGTERM, then the exit code. */
    stop: () => Promise<number | null>;
}

/** `{binary} run --config {configPath}`, with only `PATH` and `environment` in its environment. */
const startHostd = (binary: string, configPath: string, environment: Readonly<Record<string, string>> = {}): RunningHostd => {
    const child = spawn(binary, ["run", "--config", configPath], {
        env: { LUNORA_HOSTD_LOG_FLUSH_MS: "50", LUNORA_HOSTD_REPORT_TICK_MS: "100", PATH: SYSTEM_PATH, ...environment },
        stdio: ["ignore", "ignore", "pipe"],
    });
    let output = "";

    child.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
    });

    const exited = new Promise<number | null>((resolve) => {
        child.once("exit", (code) => {
            resolve(code);
        });
    });

    return {
        exited,
        logs: () => output,
        process: child,
        stop: async () => {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGTERM");
            }

            return exited;
        },
    };
};

/** Run `{binary} {args}` to completion. */
const runHostd = (
    binary: string,
    args: ReadonlyArray<string>,
    environment: Readonly<Record<string, string>> = {},
): { code: number; stderr: string; stdout: string } => {
    try {
        const stdout = execFileSync(binary, [...args], { encoding: "utf8", env: { PATH: SYSTEM_PATH, ...environment }, stdio: ["ignore", "pipe", "pipe"] });

        return { code: 0, stderr: "", stdout };
    } catch (error) {
        const failed = error as { status?: number; stderr?: string; stdout?: string };

        return { code: failed.status ?? 1, stderr: failed.stderr ?? "", stdout: failed.stdout ?? "" };
    }
};

/** Run `{binary} {args}` to completion without blocking the event loop (an in-process fake it talks to keeps answering). */
const execHostd = async (
    binary: string,
    args: ReadonlyArray<string>,
    environment: Readonly<Record<string, string>> = {},
): Promise<{ code: number | null; stderr: string; stdout: string }> =>
    new Promise((resolve, reject) => {
        const child = spawn(binary, [...args], { env: { PATH: SYSTEM_PATH, ...environment }, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        child.once("error", reject);
        child.once("close", (code) => {
            resolve({ code, stderr, stdout });
        });
    });

export type { BuildOptions, RunningHostd };
export { buildHostd, execHostd, runHostd, startHostd, SYSTEM_PATH };
