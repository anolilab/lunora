/**
 * `runChild`: the one way the daemon runs a one-shot child — output per
 * stream and line by line, stdin, a timeout that kills, and a non-zero exit
 * reported rather than thrown.
 */
import { describe, expect, it } from "vitest";

import { DIRECT_LAUNCH } from "../../src/daemon/capabilities";
import { describeFailure, runChild } from "../../src/daemon/child";

const SH = "/bin/sh";

const ENV = { PATH: "/usr/bin:/bin" } as const;

describe(runChild, () => {
    it("collects stdout and stderr apart, and hands each line over with its stream", async () => {
        expect.assertions(2);

        const lines: string[] = [];
        const result = await runChild(DIRECT_LAUNCH, SH, ["-c", "echo out; echo err >&2; echo out2"], {
            env: ENV,
            onLine: (line, stream) => {
                lines.push(`${stream}:${line}`);
            },
            timeoutMs: 10_000,
        });

        expect(result).toStrictEqual({ code: 0, signal: null, stderr: "err\n", stdout: "out\nout2\n", timedOut: false });
        expect(lines.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["stderr:err", "stdout:out", "stdout:out2"]);
    });

    it("reports a non-zero exit instead of rejecting", async () => {
        expect.assertions(2);

        const result = await runChild(DIRECT_LAUNCH, SH, ["-c", "echo nope >&2; exit 3"], { env: ENV, timeoutMs: 10_000 });

        expect(result).toMatchObject({ code: 3, timedOut: false });
        expect(describeFailure("sh", result)).toBe("sh exited 3: nope");
    });

    it("feeds stdin, and runs with exactly the environment given", async () => {
        expect.assertions(1);

        const result = await runChild(DIRECT_LAUNCH, SH, ["-c", String.raw`cat; printf "%s\n" "$HOME"`], { env: ENV, stdin: "piped\n", timeoutMs: 10_000 });

        expect(result.stdout).toBe("piped\n\n");
    });

    it("kills a child that outlives its timeout", async () => {
        expect.assertions(2);

        const result = await runChild(DIRECT_LAUNCH, SH, ["-c", "sleep 30"], { env: ENV, timeoutMs: 200 });

        expect(result).toMatchObject({ signal: "SIGKILL", timedOut: true });
        expect(describeFailure("sleep", result)).toBe("sleep timed out");
    });

    it("rejects only when the child cannot be started", async () => {
        expect.assertions(1);

        await expect(runChild(DIRECT_LAUNCH, "/nonexistent/binary", [], { env: ENV, timeoutMs: 1000 })).rejects.toThrow(/could not run \/nonexistent\/binary/u);
    });

    it("runs through a launch prefix", async () => {
        expect.assertions(1);

        const result = await runChild({ prefix: [SH, "-c", 'echo "prefixed $0"'] }, "target", [], { env: ENV, timeoutMs: 10_000 });

        expect(result.stdout).toBe("prefixed target\n");
    });
});
