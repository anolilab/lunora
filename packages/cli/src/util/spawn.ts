import { spawn as nodeSpawn } from "node:child_process";

export interface SpawnDescriptor {
    args: ReadonlyArray<string>;

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
    /** The captured stdout, present only when the descriptor set `captureStdout`. */
    stdout?: string;
}

/**
 * Injectable spawner. Tests pass a stub that just records the descriptor
 * instead of executing a real subprocess.
 */
export type Spawner = (descriptor: SpawnDescriptor) => Promise<SpawnResult>;

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
        const child = nodeSpawn(descriptor.command, [...descriptor.args], {
            cwd: descriptor.cwd ?? process.cwd(),
            env: descriptor.env ? { ...process.env, ...descriptor.env } : process.env,
            stdio: [hasInput ? "pipe" : "inherit", stdout, "inherit"],
        });

        let captured = "";

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
            resolve({ code: code ?? (signal ? 1 : 0), stdout: wantCapture ? captured : undefined });
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
