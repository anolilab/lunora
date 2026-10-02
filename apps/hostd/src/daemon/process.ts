/**
 * One supervised child process (plan 458 W4, "Supervisor", after Noite's
 * runner): restarted when it exits on its own, with a backoff that doubles
 * from one second to thirty and resets once the child has stayed up a minute;
 * stopped with SIGTERM, then SIGKILL once a stop budget runs out.
 *
 * The spawn and the timers are injectable, so the backoff and the stop budget
 * are tested with fake children and fake timers.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { Logger } from "./log";

/** `node:child_process.spawn`, as far as supervision uses it. */
type SpawnFunction = (command: string, args: ReadonlyArray<string>, options: SpawnOptions) => ChildProcess;

interface Timers {
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
    now: () => number;
    setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

const REAL_TIMERS: Timers = {
    clearTimeout: (handle) => {
        clearTimeout(handle);
    },
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
};

/** Restart backoff: 1 s doubling to 30 s; a child up for a minute counts as healthy again. */
const RESTART_BACKOFF = { maxMs: 30_000, minMs: 1000, stableMs: 60_000 } as const;

/** Lines of output kept per child, for `diagnose`. */
const OUTPUT_LINES_KEPT = 50;

interface SupervisedOptions {
    args: ReadonlyArray<string>;
    command: string;
    cwd?: string;
    env: NodeJS.ProcessEnv;
    /** Run the child as this user (plan 458 W8 runs fleets as `lunora-fleet`). */
    gid?: number;
    logger: Logger;
    /** A label for log lines: `celld my-app`, `caddy`. */
    name: string;
    /** Each line the child prints, as it prints it. */
    onLine?: (line: string) => void;
    spawn?: SpawnFunction;
    timers?: Timers;
    uid?: number;
}

/** The delay before restart number `failures` (0-based): doubling from the minimum, capped. */
const restartDelay = (failures: number): number => Math.min(RESTART_BACKOFF.maxMs, RESTART_BACKOFF.minMs * 2 ** Math.min(failures, 16));

class SupervisedProcess {
    /** Restarts after an exit nobody asked for, since the last `start()`. */
    public restarts = 0;

    private child: ChildProcess | undefined;

    private failures = 0;

    private restartTimer: ReturnType<typeof setTimeout> | undefined;

    private startedAt = 0;

    private wanted = false;

    private readonly output: string[] = [];

    private readonly options: SupervisedOptions;

    private readonly timers: Timers;

    public constructor(options: SupervisedOptions) {
        this.options = options;
        this.timers = options.timers ?? REAL_TIMERS;
    }

    /** Whether a child is running right now. */
    public get running(): boolean {
        return this.child !== undefined;
    }

    /** The last lines the child printed. */
    public get recentOutput(): ReadonlyArray<string> {
        return this.output;
    }

    /** Start the child, and keep it running until {@link stop}. A no-op while it already runs. */
    public start(): void {
        this.wanted = true;
        this.failures = 0;
        this.restarts = 0;

        if (this.child === undefined && this.restartTimer === undefined) {
            this.spawnChild();
        }
    }

    /**
     * Stop the child: SIGTERM, then SIGKILL once `budgetMs` has passed. Resolves
     * when it has exited (or at once when none runs). It is not restarted.
     */
    public async stop(budgetMs: number): Promise<void> {
        this.wanted = false;

        if (this.restartTimer !== undefined) {
            this.timers.clearTimeout(this.restartTimer);
            this.restartTimer = undefined;
        }

        const { child } = this;

        if (child === undefined) {
            return;
        }

        await new Promise<void>((resolve) => {
            const killer = this.timers.setTimeout(() => {
                this.options.logger.warn(`${this.options.name} did not stop within ${String(budgetMs)} ms; killing it`);
                child.kill("SIGKILL");
            }, budgetMs);

            child.once("exit", () => {
                this.timers.clearTimeout(killer);
                resolve();
            });

            child.kill("SIGTERM");
        });
    }

    private remember(line: string): void {
        this.output.push(line);

        if (this.output.length > OUTPUT_LINES_KEPT) {
            this.output.shift();
        }

        this.options.onLine?.(line);
    }

    private spawnChild(): void {
        const spawn = this.options.spawn ?? nodeSpawn;
        const child = spawn(this.options.command, this.options.args, {
            ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
            env: this.options.env,
            ...(this.options.gid === undefined ? {} : { gid: this.options.gid }),
            stdio: ["ignore", "pipe", "pipe"],
            ...(this.options.uid === undefined ? {} : { uid: this.options.uid }),
        });

        this.child = child;
        this.startedAt = this.timers.now();

        for (const stream of [child.stdout, child.stderr]) {
            if (stream) {
                createInterface({ input: stream }).on("line", (line) => {
                    this.remember(line);
                });
            }
        }

        child.once("error", (error) => {
            this.remember(`spawn failed: ${error.message}`);
        });

        child.once("exit", (code, signal) => {
            this.onExit(code, signal);
        });
    }

    private onExit(code: number | null, signal: NodeJS.Signals | null): void {
        this.child = undefined;

        if (!this.wanted) {
            return;
        }

        if (this.timers.now() - this.startedAt >= RESTART_BACKOFF.stableMs) {
            this.failures = 0;
        }

        const delay = restartDelay(this.failures);

        this.failures += 1;
        this.restarts += 1;
        this.options.logger.warn(`${this.options.name} exited (${signal ?? `code ${String(code)}`}); restarting in ${String(delay)} ms`);
        this.restartTimer = this.timers.setTimeout(() => {
            this.restartTimer = undefined;

            if (this.wanted) {
                this.spawnChild();
            }
        }, delay);
    }
}

export type { SpawnFunction, SupervisedOptions, Timers };
export { REAL_TIMERS, RESTART_BACKOFF, restartDelay, SupervisedProcess };
