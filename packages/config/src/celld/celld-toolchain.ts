/**
 * The host tools and environment a celld deploy or dev session needs, checked
 * before anything is written: the `celld` binary and its version, the `esbuild`
 * celld bundles a Worker with (in `celld dev` too), and the fleet bucket
 * `celld deploy` writes to.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

/**
 * The celld version `CELLD_CAPABILITIES` (`packages/platform/src/capabilities/celld.ts`)
 * is rated against. An older celld may lack what the matrix rates native.
 */
const CELLD_RATED_VERSION = "0.6.1";

/** How long a version probe gets before the tool counts as hung. */
const PROBE_TIMEOUT_MS = 10_000;

/** The `error` of a command that was killed for running past {@link PROBE_TIMEOUT_MS}. */
const TIMED_OUT = "ETIMEDOUT";

/** A command `cmd.exe` would re-split or interpret. */
const CMD_UNSAFE = /[\s&|<>^%"]/u;

/** A command that names a location, which `cmd.exe` does not look up on `PATH`. */
const PATH_SEPARATOR = /[/\\]/u;

const VERSION = /(\d{1,6})\.(\d{1,6})\.(\d{1,6})/u;

interface CelldCommandResult {
    code: number;
    /** The launch error (`EACCES`) of a command that exists but could not start. */
    error?: string;
    stdout: string;
}

/** Runs one command and resolves its output; `undefined` when it does not exist (not on PATH). */
type CelldCommandRunner = (command: string, args: ReadonlyArray<string>) => Promise<CelldCommandResult | undefined>;

interface CelldToolchainProbeOptions {
    /** A `--dry-run` deploy bundles but writes nothing, so it does not need the bucket. */
    dryRun?: boolean;
    /** The environment `CELLD_BUCKET` and `CELLD_ESBUILD` are read from, and the tools are looked up and run with. */
    env?: Readonly<Record<string, string | undefined>>;
    /** `deploy` also needs the fleet bucket; a dev session does not. */
    purpose: "deploy" | "dev";
    /** Injected for tests; defaults to running the command with `execFile`. */
    run?: CelldCommandRunner;
}

interface CelldToolchainProbe {
    /** Problems that stop the deploy or dev session. */
    errors: string[];
    /** Problems that do not stop it. */
    warnings: string[];
}

/**
 * What `execFile` is given for a command. On Windows an npm-installed tool is a `.cmd` shim, which
 * `execFile` cannot start without a shell (Node refuses it since CVE-2024-27980), and `cmd.exe`
 * re-splits a command with whitespace or metacharacters, so those are quoted.
 */
const launchOptions = (command: string, platform: NodeJS.Platform): { command: string; shell: boolean } =>
    platform === "win32" ? { command: CMD_UNSAFE.test(command) ? `"${command.replaceAll('"', "")}"` : command, shell: true } : { command, shell: false };

/**
 * Whether `cmd.exe` would find `command`: in the working directory and on `PATH` for a bare name,
 * with each `PATHEXT` suffix. It is looked up here because a command `cmd.exe` cannot find exits
 * with code 1 instead of raising `ENOENT`, which reads like a broken install.
 */
const windowsCommandExists = (command: string, env: Readonly<Record<string, string | undefined>>, exists: (path: string) => boolean): boolean => {
    const suffixes = ["", ...(env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((suffix) => suffix !== "")];
    const directories = PATH_SEPARATOR.test(command)
        ? [""]
        : [
              "",
              ...(env["PATH"] ?? env["Path"] ?? "")
                  .split(";")
                  .map((directory) => directory.replaceAll('"', ""))
                  .filter((directory) => directory !== ""),
          ];

    return directories.some((directory) => suffixes.some((suffix) => exists(win32.join(directory, `${command}${suffix}`))));
};

/** Resolves a command's output, or `undefined` when the command does not exist. */
const runCommand = async (
    command: string,
    args: ReadonlyArray<string>,
    {
        env = process.env,
        exists = existsSync,
        platform = process.platform,
        timeoutMs = PROBE_TIMEOUT_MS,
    }: { env?: Readonly<Record<string, string | undefined>>; exists?: (path: string) => boolean; platform?: NodeJS.Platform; timeoutMs?: number } = {},
): Promise<CelldCommandResult | undefined> =>
    new Promise((resolve) => {
        if (platform === "win32" && !windowsCommandExists(command, env, exists)) {
            resolve(undefined);

            return;
        }

        const launch = launchOptions(command, platform);

        execFile(launch.command, [...args], { env, killSignal: "SIGKILL", shell: launch.shell, timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
            // A hung tool was killed, so it has neither an exit code nor a launch error.
            if (error !== null && error.killed === true) {
                resolve({ code: 1, error: TIMED_OUT, stdout });

                return;
            }

            // A spawn failure has a string code (`ENOENT`, `EACCES`); a non-zero exit has a numeric one.
            if (error !== null && typeof error.code === "string") {
                resolve(error.code === "ENOENT" ? undefined : { code: 1, error: error.code, stdout });

                return;
            }

            resolve({ code: error === null ? 0 : Number(error.code ?? 1), stdout });
        });
    });

/** How a command that exists failed: it hung, could not start, or exited nonzero. */
const failure = (result: CelldCommandResult): string => {
    if (result.error === TIMED_OUT) {
        return `did not exit within ${String(PROBE_TIMEOUT_MS / 1000)}s`;
    }

    return result.error === undefined ? `exited with code ${String(result.code)}` : `could not start (${result.error})`;
};

/** Whether `version` (`x.y.z`) is older than `rated`. */
const isOlder = (version: readonly [number, number, number], rated: string): boolean => {
    const [major, minor, patch] = rated.split(".").map(Number) as [number, number, number];

    if (version[0] !== major) {
        return version[0] < major;
    }

    if (version[1] !== minor) {
        return version[1] < minor;
    }

    return version[2] < patch;
};

/** The warning `celld --version`'s output earns, if any: unreadable, or older than the rated version. */
const celldVersionWarning = (stdout: string): string | undefined => {
    const found = VERSION.exec(stdout);

    if (found === null) {
        return "could not read a version from `celld --version`, so its version is unchecked";
    }

    const version = [Number(found[1]), Number(found[2]), Number(found[3])] as const;

    return isOlder(version, CELLD_RATED_VERSION)
        ? `celld ${version.join(".")} is older than ${CELLD_RATED_VERSION}, the version the celld capability matrix is rated against — some ratings may not hold; upgrade celld`
        : undefined;
};

/**
 * Check the celld toolchain a deploy or dev session will run.
 * @returns the errors that stop it and the warnings that do not. Nothing is written.
 */
const probeCelldToolchain = async (options: CelldToolchainProbeOptions): Promise<CelldToolchainProbe> => {
    // Read once: the tools must run with the environment their settings come from.
    const env = options.env ?? process.env;
    const run = options.run ?? ((command, args) => runCommand(command, args, { env }));
    const errors: string[] = [];
    const warnings: string[] = [];
    const celld = await run("celld", ["--version"]);

    if (celld === undefined) {
        errors.push("celld is not on PATH — install it (curl -fsSL https://celld.dev/install.sh | sh) to run the celld target");
    } else if (celld.code === 0) {
        const warning = celldVersionWarning(celld.stdout);

        if (warning !== undefined) {
            warnings.push(warning);
        }
    } else {
        errors.push(`\`celld --version\` ${failure(celld)} — the celld on PATH does not run; reinstall it`);
    }

    // celld runs the esbuild `CELLD_ESBUILD` names, else the one on PATH.
    const configured = (env["CELLD_ESBUILD"] ?? "").trim();
    const esbuildCommand = configured === "" ? "esbuild" : configured;
    const esbuild = await run(esbuildCommand, ["--version"]);

    if (esbuild === undefined) {
        errors.push(
            configured === ""
                ? "esbuild is not on PATH — celld bundles the worker with it"
                : `CELLD_ESBUILD names ${configured}, which does not exist — celld bundles the worker with it`,
        );
    } else if (esbuild.code !== 0) {
        errors.push(`\`${esbuildCommand} --version\` ${failure(esbuild)} — the esbuild celld bundles the worker with does not run`);
    }

    if (options.purpose === "deploy" && options.dryRun !== true && (env["CELLD_BUCKET"] ?? "").trim() === "") {
        errors.push("CELLD_BUCKET is not set — `celld deploy` writes the deployment to the fleet bucket it names");
    }

    return { errors, warnings };
};

export type { CelldCommandRunner, CelldToolchainProbe, CelldToolchainProbeOptions };
export { launchOptions, probeCelldToolchain, runCommand };
