import { spawn as nodeSpawn } from "node:child_process";

/**
 * Matches any character that would make cmd.exe re-split, redirect, or otherwise
 * reinterpret an unquoted argument: whitespace (re-split), the command
 * separators / redirection operators (`& | < > ^`), an env-var `%`, and a
 * literal `"` (which toggles cmd's quote state). Wrapping such a value in double
 * quotes neutralises the separators/redirection so an argument like
 * `C:\Dev&amp;Ops\dist` can't spawn `Ops\dist` as a second command.
 */
const NEEDS_CMD_QUOTING = /[\s"%&<>^|]/u;
// eslint-disable-next-line sonarjs/slow-regex -- linear (no nested quantifier); input is a bounded developer-supplied CLI argument
const BACKSLASH_RUN_BEFORE_QUOTE = /(\\*)"/gu;
// eslint-disable-next-line sonarjs/slow-regex -- linear; bounded CLI-argument input
const TRAILING_BACKSLASH_RUN = /(\\+)$/u;

export interface SpawnDescriptor {
    args: ReadonlyArray<string>;

    /**
     * Capture the child's stderr (in addition to streaming it to the parent).
     * Needed when a tool reports the *expected* outcome as an error there —
     * `wrangler vectorize create-metadata-index` writes "already exists" to
     * stderr, and without this the caller can only see a bare exit code and
     * would warn on every re-run. Composes with `stdoutToStderr`, so a caller
     * can keep stdout clean for `--format json` and still read the reason.
     */
    captureStderr?: boolean;

    /**
     * Capture the child's stdout (in addition to streaming it to the parent), so
     * the caller can parse it — used by `deploy` to read the deployed URL from
     * `wrangler deploy` output. Each chunk is still teed to the parent's stdout
     * so the user sees live progress. Mutually exclusive with `stdoutToStderr`.
     */
    captureStdout?: boolean;
    command: string;
    cwd?: string;
    env?: Readonly<Record<string, string>>;

    /**
     * Pipe this string into the child's stdin and close it. Used to feed
     * `wrangler secret put` its value without exposing it on the command
     * line or in env. When absent, stdin is inherited from the parent.
     */
    input?: string;

    /**
     * Route the child's stdout to the parent's STDERR instead of stdout. Set in
     * `--format json` mode so a spawned tool's human output (e.g. `wrangler
     * deploy`'s progress + the deployed URL) can't interleave with — and corrupt
     * — the single JSON document the command prints to stdout.
     */
    stdoutToStderr?: boolean;
}

export interface SpawnResult {
    code: number;
    /** The captured stderr, present only when the descriptor set `captureStderr`. */
    stderr?: string;
    /** The captured stdout, present only when the descriptor set `captureStdout`. */
    stdout?: string;
}

/**
 * Injectable spawner. Tests pass a stub that just records the descriptor
 * instead of executing a real subprocess.
 */
export type Spawner = (descriptor: SpawnDescriptor) => Promise<SpawnResult>;

/**
 * Map a command + args onto what `child_process.spawn` can actually execute on
 * this platform. On Windows the package-manager CLIs (`pnpm`, `npx`, `yarn`,
 * `bun`) are `.cmd`/`.ps1` shims that `spawn()` cannot start without a shell —
 * since Node's CVE-2024-27980 hardening the call fails outright (`EINVAL`, or
 * `ENOENT` for the extensionless name) and the child never gets a PID. Node
 * itself (`process.execPath`) is a real executable and needs no shell. With
 * `shell: true` Node joins command + args verbatim for cmd.exe, so any argument
 * carrying a cmd metacharacter (whitespace, `& | < > ^ % "`) is double-quoted
 * here — with CommandLineToArgvW-safe escaping of embedded quotes and trailing
 * backslashes — so a `--config` temp path under a spaced user dir, or a value
 * like `C:\Dev&amp;Ops\dist`, can't be re-split or run as a second command;
 * everything else passes through untouched. POSIX platforms return the input
 * unchanged.
 */
export const spawnShellCompat = (
    command: string,
    args: ReadonlyArray<string>,
    platform: NodeJS.Platform = process.platform,
): { args: string[]; command: string; shell: boolean } => {
    if (platform !== "win32" || command === process.execPath) {
        return { args: [...args], command, shell: false };
    }

    // An empty argument must still reach the child as an empty token; unquoted it
    // would vanish when cmd.exe re-splits, shifting every following positional.
    // Otherwise only quote when a metacharacter is present so ordinary args pass
    // through untouched.
    const quote = (value: string): string => {
        if (value === "") {
            return `""`;
        }

        if (!NEEDS_CMD_QUOTING.test(value)) {
            return value;
        }

        // Escape for the child's CommandLineToArgvW re-parse: any run of
        // backslashes immediately before a `"` (an embedded quote, or the closing
        // quote we append) must be doubled, and each embedded `"` becomes `\"`.
        // Without this, `C:\path\` before the closing quote would escape it and
        // re-split the value mid-argument.
        const escaped = value.replaceAll(BACKSLASH_RUN_BEFORE_QUOTE, String.raw`$1$1\"`).replace(TRAILING_BACKSLASH_RUN, "$1$1");

        return `"${escaped}"`;
    };

    return { args: args.map((argument) => quote(argument)), command: quote(command), shell: true };
};

export const defaultSpawner: Spawner = (descriptor) =>
    new Promise<SpawnResult>((resolve, reject) => {
        const hasInput = typeof descriptor.input === "string";
        const wantCapture = descriptor.captureStdout === true;
        // When the caller pipes input we need a writable stdin handle — "inherit"
        // gives us the parent's stdin which we can't write to. stderr always stays
        // inherited so errors land where the user can see them. stdout is normally
        // inherited; in `--format json` mode it is mapped to the parent's stderr fd
        // (2) so the child's human output never pollutes the JSON on stdout; and in
        // capture mode it is piped so we can buffer + tee it.
        let stdout: "inherit" | "pipe" | number = "inherit";

        if (wantCapture) {
            stdout = "pipe";
        } else if (descriptor.stdoutToStderr) {
            stdout = 2;
        }
        const exec = spawnShellCompat(descriptor.command, descriptor.args);
        const child = nodeSpawn(exec.command, exec.args, {
            cwd: descriptor.cwd ?? process.cwd(),
            env: descriptor.env ? { ...process.env, ...descriptor.env } : process.env,
            shell: exec.shell,
            stdio: [hasInput ? "pipe" : "inherit", stdout, descriptor.captureStderr === true ? "pipe" : "inherit"],
        });

        let captured = "";
        let capturedError = "";

        if (descriptor.captureStderr === true && child.stderr) {
            child.stderr.on("data", (chunk: Buffer) => {
                capturedError += chunk.toString("utf8");
                // Tee to the parent so the user still sees the tool's own output.
                process.stderr.write(chunk);
            });
        }

        if (wantCapture && child.stdout) {
            child.stdout.on("data", (chunk: Buffer) => {
                captured += chunk.toString("utf8");
                // Tee to the parent so the user still sees live deploy progress.
                process.stdout.write(chunk);
            });
        }

        child.on("error", (error) => {
            reject(error);
        });

        child.on("exit", (code, signal) => {
            // A signal-killed child reports `code === null`; treat that as a
            // failure (non-zero) rather than silently passing — e.g. an
            // OOM-killed `tsc` must not read as a clean type-check.
            resolve({
                code: code ?? (signal ? 1 : 0),
                stderr: descriptor.captureStderr === true ? capturedError : undefined,
                stdout: wantCapture ? captured : undefined,
            });
        });

        if (hasInput && child.stdin) {
            // End the write so the child sees EOF and exits its read loop.
            // Most CLIs (wrangler secret put included) read until EOF.
            child.stdin.end(descriptor.input);
        }
    });

export interface RecordedSpawn {
    descriptor: SpawnDescriptor;
}

/**
 * Test helper: returns a spawner that records every invocation and resolves
 * with the configured exit code.
 */
export const createRecordingSpawner = (exitCode = 0): { calls: RecordedSpawn[]; spawner: Spawner } => {
    const calls: RecordedSpawn[] = [];

    const spawner: Spawner = (descriptor) => {
        calls.push({ descriptor });

        return Promise.resolve({ code: exitCode });
    };

    return { calls, spawner };
};
