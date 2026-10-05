/**
 * Supervision with fake children and fake timers: the restart backoff and the
 * stop budget, without spawning anything.
 */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { silentLogger } from "../../src/daemon/log";
import type { SpawnFunction } from "../../src/daemon/process";
import { restartDelay, SupervisedProcess } from "../../src/daemon/process";
import { allocatePorts } from "../../src/daemon/supervisor";

/** A child that exits only when a test says so — or, unless `stubborn`, on SIGTERM. */
// eslint-disable-next-line unicorn/prefer-event-target -- it stands in for a ChildProcess, which is an EventEmitter
class FakeChild extends EventEmitter {
    public readonly signals: string[] = [];

    public readonly stderr = new PassThrough();

    public readonly stdout = new PassThrough();

    public stubborn = false;

    public kill(signal: string): boolean {
        this.signals.push(signal);

        if (signal === "SIGKILL" || !this.stubborn) {
            this.exit(null, signal);
        }

        return true;
    }

    public exit(code: number | null, signal: string | null = null): void {
        this.emit("exit", code, signal);
    }
}

describe(SupervisedProcess, () => {
    let children: FakeChild[];
    let spawn: SpawnFunction;

    const supervised = (): SupervisedProcess =>
        new SupervisedProcess({
            args: [],
            command: "celld",
            env: {},
            logger: silentLogger,
            name: "celld test",
            spawn,
            timers: { clearTimeout: (handle) => clearTimeout(handle), now: () => Date.now(), setTimeout: (callback, ms) => setTimeout(callback, ms) },
        });

    beforeEach(() => {
        vi.useFakeTimers();
        children = [];
        spawn = () => {
            const child = new FakeChild();

            children.push(child);

            return child as unknown as ChildProcess;
        };
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("restarts a crashed child after 1 s, 2 s, 4 s … capped at 30 s", () => {
        expect.assertions(7);

        const process = supervised();

        process.start();

        expect(children).toHaveLength(1);

        const waits = [1000, 2000, 4000, 8000, 16_000, 30_000];

        for (const [index, wait] of waits.entries()) {
            children[index]?.exit(1);
            vi.advanceTimersByTime(wait - 1);
            vi.advanceTimersByTime(1);

            expect(children).toHaveLength(index + 2);
        }
    });

    it("resets the backoff once a child stayed up a minute", () => {
        expect.assertions(2);

        const process = supervised();

        process.start();
        children[0]?.exit(1);
        vi.advanceTimersByTime(1000);
        children[1]?.exit(1);
        vi.advanceTimersByTime(2000);

        expect(children).toHaveLength(3);

        vi.advanceTimersByTime(61_000);
        children[2]?.exit(1);
        vi.advanceTimersByTime(1000);

        expect(children).toHaveLength(4);
    });

    it("stops with SIGTERM and does not restart", async () => {
        expect.assertions(2);

        const process = supervised();

        process.start();
        await process.stop(10_000);
        vi.advanceTimersByTime(60_000);

        expect(children[0]?.signals).toStrictEqual(["SIGTERM"]);
        expect(children).toHaveLength(1);
    });

    it("kills a child that outlives the stop budget", async () => {
        expect.assertions(1);

        const process = supervised();

        process.start();
        (children[0] as FakeChild).stubborn = true;

        const stopped = process.stop(5000);

        vi.advanceTimersByTime(4999);
        vi.advanceTimersByTime(1);
        await stopped;

        expect(children[0]?.signals).toStrictEqual(["SIGTERM", "SIGKILL"]);
    });

    it("restarts a child that could not be started at all, which emits no exit, with the same backoff", () => {
        expect.assertions(3);

        const warnings: string[] = [];
        const process = new SupervisedProcess({
            args: [],
            command: "caddy",
            env: {},
            logger: { ...silentLogger, warn: (message: string) => warnings.push(message) },
            name: "caddy",
            spawn,
            timers: { clearTimeout: (handle) => clearTimeout(handle), now: () => Date.now(), setTimeout: (callback, ms) => setTimeout(callback, ms) },
        });

        process.start();
        // What Node does when it cannot enter the child's cwd: `error`, no pid, and never an `exit`.
        children[0]?.emit("error", new Error("spawn /usr/bin/setpriv EACCES"));

        expect(process.running).toBe(false);

        vi.advanceTimersByTime(1000);

        expect(children).toHaveLength(2);
        expect(warnings).toStrictEqual(["caddy could not start: spawn /usr/bin/setpriv EACCES; restarting in 1000 ms"]);
    });

    it("stops at once while a child that could not be started waits to be restarted, and while one is failing to start", async () => {
        expect.assertions(2);

        const process = supervised();

        process.start();
        children[0]?.emit("error", new Error("spawn EACCES"));
        await process.stop(10_000);
        vi.advanceTimersByTime(60_000);

        expect(children).toHaveLength(1);

        process.start();
        (children[1] as FakeChild).stubborn = true;

        const stopped = process.stop(10_000);

        children[1]?.emit("error", new Error("spawn EACCES"));
        await stopped;

        expect(children[1]?.signals).toStrictEqual(["SIGTERM"]);
    });

    it("keeps the last lines a child printed", async () => {
        expect.assertions(1);

        const process = supervised();

        process.start();
        children[0]?.stderr.write("warn: something\n");
        await vi.runAllTimersAsync();

        expect(process.recentOutput).toStrictEqual(["warn: something"]);
    });
});

describe(restartDelay, () => {
    it("never waits less than a second or more than thirty", () => {
        expect.assertions(2);

        expect(restartDelay(0)).toBe(1000);
        expect(restartDelay(100)).toBe(30_000);
    });
});

describe(allocatePorts, () => {
    it("hands out loopback port pairs and fails when the range is exhausted", () => {
        expect.assertions(3);

        const range = { first: 20_000, last: 20_003 };

        expect(allocatePorts(range, new Set())).toStrictEqual({ internalPort: 20_001, publicPort: 20_000 });
        expect(allocatePorts(range, new Set([20_000, 20_001]))).toStrictEqual({ internalPort: 20_003, publicPort: 20_002 });
        expect(() => allocatePorts(range, new Set([20_000, 20_001, 20_002, 20_003]))).toThrow(expect.objectContaining({ code: "PORTS_EXHAUSTED" }));
    });
});
