/**
 * The build box's one way to run a tenant-influenced command.
 *
 * Kept apart from `server.mjs` so the process-tree handling can be tested on
 * its own: it is the boundary between one tenant's build and the next tenant's
 * workspace on a reused instance.
 */
import { spawn } from "node:child_process";

import { BuildError } from "./workspace.mjs";

const MAX_LOG_LINE_CHARS = 8000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * SIGKILL every process in the child's group.
 *
 * The child leads its own group (`detached: true`), so a negative pid reaches
 * whatever it forked as well — a `postinstall` that backgrounds a watcher, a
 * timed-out bundler's workers. Killing only the direct child leaves those
 * running as the same user into the next build on this instance, where they
 * can read that tenant's source and env.
 *
 * A descendant that called `setsid` has left the group and survives this;
 * the control plane contains it by giving each build an instance of its own
 * and destroying it afterwards (`src/builds/container-exec.ts`).
 * @param {number | undefined} pid The group leader's pid.
 */
const killGroup = (pid) => {
    if (pid === undefined) {
        return;
    }

    try {
        process.kill(-pid, "SIGKILL");
    } catch {
        // ESRCH: the group is already empty, which is the outcome wanted.
    }
};

/**
 * Run a command and hand each output line to `onLine` as it arrives.
 *
 * `shell: false` (the default, kept explicit) is the security-relevant part:
 * arguments never become a shell string, so a branch or commit value that
 * reaches an argument cannot inject a command. Resolves with the exit code —
 * a non-zero code is a result, not a throw, matching the exec contract.
 * @param {string} command Executable to run.
 * @param {string[]} args Arguments, passed unshelled.
 * @param {{ cwd?: string, env?: Record<string, string>, label?: string, timeoutMs?: number }} options Spawn options, the wall-clock kill, and how the phase is named if it fires.
 * @param {(line: string, stream: "stderr" | "stdout") => void} onLine Called once per output line.
 * @returns {Promise<number>} The process exit code.
 */
const run = (command, args, options, onLine) =>
    new Promise((resolve, reject) => {
        const { label, timeoutMs = DEFAULT_TIMEOUT_MS, ...spawnOptions } = options;
        const child = spawn(command, args, { ...spawnOptions, detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });

        // Line-buffered per stream: a chunk boundary lands mid-line often
        // enough that unbuffered forwarding produces split log lines.
        const pending = { stderr: "", stdout: "" };

        const pump = (stream, name) => {
            stream.setEncoding("utf8");
            stream.on("data", (text) => {
                pending[name] += text;

                const lines = pending[name].split("\n");

                pending[name] = lines.pop() ?? "";

                for (const line of lines) {
                    onLine(line.slice(0, MAX_LOG_LINE_CHARS), name);
                }
            });
        };

        pump(child.stdout, "stdout");
        pump(child.stderr, "stderr");

        const timer = setTimeout(() => {
            killGroup(child.pid);
            reject(new BuildError(`${label ?? "the command"} exceeded ${timeoutMs}ms and was killed`));
        }, timeoutMs);

        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });

        child.on("close", (code) => {
            clearTimeout(timer);
            // A clean exit can still leave a background process in the group;
            // nothing a build starts may outlive it.
            killGroup(child.pid);

            // Flush whatever the process wrote without a trailing newline.
            for (const name of ["stdout", "stderr"]) {
                if (pending[name] !== "") {
                    onLine(pending[name].slice(0, MAX_LOG_LINE_CHARS), name);
                }
            }

            resolve(code ?? 0);
        });
    });

export default run;
