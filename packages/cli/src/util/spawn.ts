import { spawn as nodeSpawn } from "node:child_process";

export interface SpawnDescriptor {
    args: ReadonlyArray<string>;
    command: string;
    cwd?: string;
    env?: Readonly<Record<string, string>>;

    /**
     * Pipe this string into the child's stdin and close it. Used to feed
     * `wrangler secret put` its value without exposing it on the command
     * line or in env. When absent, stdin is inherited from the parent.
     */
    input?: string;
}

export interface SpawnResult {
    code: number;
}

/**
 * Injectable spawner. Tests pass a stub that just records the descriptor
 * instead of executing a real subprocess.
 */
export type Spawner = (descriptor: SpawnDescriptor) => Promise<SpawnResult>;

export const defaultSpawner: Spawner = (descriptor) =>
    new Promise<SpawnResult>((resolve, reject) => {
        const hasInput = typeof descriptor.input === "string";
        const child = nodeSpawn(descriptor.command, [...descriptor.args], {
            cwd: descriptor.cwd ?? process.cwd(),
            env: descriptor.env ? { ...process.env, ...descriptor.env } : process.env,
            // When the caller pipes input we need a writable stdin handle —
            // "inherit" gives us the parent's stdin which we can't write to.
            // stdout/stderr stay inherited so logs/errors land where the user
            // can see them in the terminal.
            stdio: hasInput ? ["pipe", "inherit", "inherit"] : "inherit",
        });

        child.on("error", (error) => {
            reject(error);
        });

        child.on("exit", (code) => {
            resolve({ code: code ?? 0 });
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
