/**
 * The host tools and environment a celld deploy or dev session needs, checked
 * before anything is written: the `celld` binary and its version, `esbuild` for
 * a deploy's bundle, and the fleet bucket `celld deploy` writes to.
 */
import { execFile } from "node:child_process";

/**
 * The celld version `CELLD_CAPABILITIES` (`packages/platform/src/capabilities/celld.ts`)
 * is rated against. An older celld may lack what the matrix rates native.
 */
const CELLD_RATED_VERSION = "0.6.1";

const VERSION = /(\d{1,6})\.(\d{1,6})\.(\d{1,6})/u;

interface CelldCommandResult {
    code: number;
    stdout: string;
}

/** Runs one command and resolves its output; `undefined` when it cannot be started (not on PATH). */
type CelldCommandRunner = (command: string, args: ReadonlyArray<string>) => Promise<CelldCommandResult | undefined>;

interface CelldToolchainProbeOptions {
    /** A `--dry-run` deploy bundles but writes nothing, so it does not need the bucket. */
    dryRun?: boolean;
    /** The environment the bucket is read from (`CELLD_BUCKET`). */
    env?: Readonly<Record<string, string | undefined>>;
    /** `deploy` also needs `esbuild` on PATH and the fleet bucket; a dev session needs neither. */
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

/** Resolves a command's output, or `undefined` when the command cannot be started. */
const runCommand: CelldCommandRunner = async (command, args) =>
    new Promise((resolve) => {
        execFile(command, [...args], { windowsHide: true }, (error, stdout) => {
            // A spawn failure (`ENOENT`) has a string code; a non-zero exit has a numeric one.
            if (error !== null && typeof error.code === "string") {
                resolve(undefined);

                return;
            }

            resolve({ code: error === null ? 0 : Number(error.code ?? 1), stdout });
        });
    });

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
    const run = options.run ?? runCommand;
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
        errors.push(`\`celld --version\` exited with code ${String(celld.code)} — the celld on PATH does not run; reinstall it`);
    }

    if (options.purpose === "deploy") {
        const esbuild = await run("esbuild", ["--version"]);

        if (esbuild === undefined) {
            errors.push("esbuild is not on PATH — `celld deploy` bundles the worker with it");
        } else if (esbuild.code !== 0) {
            errors.push(
                `\`esbuild --version\` exited with code ${String(esbuild.code)} — the esbuild on PATH does not run, and \`celld deploy\` bundles with it`,
            );
        }

        if (options.dryRun !== true && (options.env?.["CELLD_BUCKET"] ?? "").trim() === "") {
            errors.push("CELLD_BUCKET is not set — `celld deploy` writes the deployment to the fleet bucket it names");
        }
    }

    return { errors, warnings };
};

export type { CelldCommandResult, CelldCommandRunner, CelldToolchainProbe, CelldToolchainProbeOptions };
export { CELLD_RATED_VERSION, probeCelldToolchain };
