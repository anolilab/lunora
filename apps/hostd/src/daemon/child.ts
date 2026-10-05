/**
 * Running a one-shot child to completion: the probe the isolation self-check
 * starts as the fleet user, `find` emptying a fleet's directory, `celld
 * deploy` / `celld diagnose`, `nft`, and each binary's `--version`. Long-lived
 * children (the fleets' nodes, Caddy) are supervised instead (`process.ts`).
 *
 * One set of semantics for all of them: the child is started under a
 * {@link ChildLaunch} (as another user, through `setpriv`), with exactly the
 * environment given — never the daemon's own; its output is collected per
 * stream (bounded) and handed line by line to `onLine` as it arrives; past
 * `timeoutMs` it is killed with SIGKILL and the result says `timedOut`. A
 * non-zero exit is not an error here: the caller decides what it means. Only a
 * child that cannot be started at all rejects.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

import type { ChildLaunch } from "./capabilities";
import { launchCommand, launchIdentity } from "./capabilities";

/** Output kept per stream; a chatty child cannot grow the daemon without bound. */
const MAX_CAPTURED_BYTES = 1024 * 1024;

interface RunChildOptions {
    cwd?: string;
    /** The child's whole environment. */
    env: Readonly<Record<string, string>>;
    /** Each line the child prints, as it prints it, with the stream it came on. */
    onLine?: (line: string, stream: "stderr" | "stdout") => void;
    /** Written to the child's stdin, which is then closed (at once, without it). */
    stdin?: string;
    timeoutMs: number;
}

/** How a child ended, and what it printed. */
interface ChildResult {
    /** The exit code; `null` when a signal ended it. */
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    stdout: string;
    /** Whether it outlived `timeoutMs` and was killed. */
    timedOut: boolean;
}

/**
 * Run `command args` under `launch` to completion.
 * @throws {Error} only when the child cannot be started.
 */
const runChild = async (launch: ChildLaunch, command: string, args: ReadonlyArray<string>, options: RunChildOptions): Promise<ChildResult> =>
    new Promise((resolve, reject) => {
        const launched = launchCommand(launch, command, args, options.cwd);
        const child = spawn(launched.command, launched.args, {
            ...(launched.cwd === undefined ? {} : { cwd: launched.cwd }),
            env: { ...options.env },
            stdio: ["pipe", "pipe", "pipe"],
            ...launchIdentity(launch),
        });
        const captured = { stderr: "", stdout: "" };
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
            // A grandchild holding a pipe open would otherwise keep `close` from ever firing.
            child.stdout.destroy();
            child.stderr.destroy();
        }, options.timeoutMs);

        timer.unref();

        for (const stream of ["stdout", "stderr"] as const) {
            createInterface({ input: child[stream] }).on("line", (line) => {
                if (captured[stream].length < MAX_CAPTURED_BYTES) {
                    captured[stream] += `${line}\n`;
                }

                options.onLine?.(line, stream);
            });
        }

        child.once("error", (error) => {
            clearTimeout(timer);
            reject(new Error(`could not run ${command}: ${error.message}`));
        });
        child.once("close", (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, stderr: captured.stderr, stdout: captured.stdout, timedOut });
        });

        // An EPIPE from a child that exits without reading its input is not the caller's failure.
        child.stdin.on("error", () => undefined);
        child.stdin.end(options.stdin ?? "");
    });

/** A child's failure in one line: how it ended, and the start of what it printed on stderr (or stdout). */
const describeFailure = (command: string, result: ChildResult, maxLength = 300): string => {
    const status = result.code === null ? (result.signal ?? "on a signal") : String(result.code);
    const ending = result.timedOut ? "timed out" : `exited ${status}`;
    const printed = (result.stderr.trim() === "" ? result.stdout : result.stderr).trim().slice(0, maxLength);

    return `${command} ${ending}${printed === "" ? "" : `: ${printed}`}`;
};

export type { ChildResult, RunChildOptions };
export { describeFailure, runChild };
