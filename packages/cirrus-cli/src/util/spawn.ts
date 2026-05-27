import { spawn as nodeSpawn } from "node:child_process";

export interface SpawnDescriptor {
    args: ReadonlyArray<string>;
    command: string;
    cwd?: string;
    env?: Readonly<Record<string, string>>;
}

export interface SpawnResult {
    code: number;
}

/**
 * Injectable spawner. Tests pass a stub that just records the descriptor
 * instead of executing a real subprocess.
 */
export type Spawner = (descriptor: SpawnDescriptor) => Promise<SpawnResult>;

export const defaultSpawner: Spawner = (descriptor) => {
    return new Promise<SpawnResult>((resolve, reject) => {
        const child = nodeSpawn(descriptor.command, [...descriptor.args], {
            cwd: descriptor.cwd ?? process.cwd(),
            env: descriptor.env ? { ...process.env, ...descriptor.env } : process.env,
            stdio: "inherit",
        });

        child.on("error", (error) => {
            reject(error);
        });

        child.on("exit", (code) => {
            resolve({ code: code ?? 0 });
        });
    });
};

export interface RecordedSpawn {
    descriptor: SpawnDescriptor;
}

/**
 * Test helper: returns a spawner that records every invocation and resolves
 * with the configured exit code.
 */
export const createRecordingSpawner = (exitCode = 0): { calls: RecordedSpawn[]; spawner: Spawner } => {
    const calls: RecordedSpawn[] = [];

    const spawner: Spawner = async (descriptor) => {
        calls.push({ descriptor });

        return { code: exitCode };
    };

    return { calls, spawner };
};
