import { afterEach, describe, expect, it, vi } from "vitest";

import { LunoraContainer } from "../src/do/index";
import { defineContainer } from "../src/index";
import { fakeDurableObjectContext, streamOf } from "./__helpers__/fake-context";

/** A native process whose exit the test controls. */
const controllableProcess = (overrides: Record<string, unknown> = {}) => {
    let exit: (code: number) => void = () => {};
    const kill = vi.fn<(signal?: number) => void>(() => {
        exit(143);
    });
    const resize = vi.fn<(cols: number, rows: number) => void>();
    const process = {
        exitCode: new Promise<number>((resolve) => {
            exit = resolve;
        }),
        isPty: false,
        kill,
        pid: 42,
        resize,
        stderr: streamOf("warn"),
        stdin: new WritableStream(),
        stdout: streamOf("hello"),
        ...overrides,
    };

    return {
        exit: (code: number) => {
            exit(code);
        },
        kill,
        process,
        resize,
    };
};

const spawnInstance = (exec: (...args: unknown[]) => Promise<unknown>, running = true) => {
    const context = fakeDurableObjectContext({ exec, running });
    const instance = new LunoraContainer(context as never, { API_KEY: "k" }, defineContainer({ image: "./app", secrets: ["API_KEY"] }), "runner");
    const started = vi.spyOn(instance, "start").mockResolvedValue(undefined);

    return { instance, inflight: () => (instance as unknown as { inflightRequests: number }).inflightRequests, started };
};

describe("lunoraContainer spawn", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("streams the process unbuffered, with the start env under the per-call env", async () => {
        expect.assertions(5);

        const { exit, process } = controllableProcess();
        const exec = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => process);
        const { instance } = spawnInstance(exec);
        const spawned = await instance.lunoraSpawn({ args: ["-c", "echo"], command: "sh", cwd: "/w", env: { LOG: "1" } });

        expect(exec).toHaveBeenCalledWith(["sh", "-c", "echo"], { cwd: "/w", env: { API_KEY: "k", LOG: "1" }, stderr: "pipe", stdout: "pipe" });
        expect(spawned.pid).toBe(42);
        await expect(new Response(spawned.stdout).text()).resolves.toBe("hello");
        await expect(new Response(spawned.stderr).text()).resolves.toBe("warn");

        exit(0);

        await expect(spawned.control.exitCode()).resolves.toBe(0);
    });

    it("counts the process in flight until it exits, and releases it once", async () => {
        expect.assertions(3);

        const { exit, process } = controllableProcess();
        const { inflight, instance } = spawnInstance(async () => process);
        const spawned = await instance.lunoraSpawn({ command: "sleep" });
        const other = await instance.lunoraSpawn({ command: "sleep" });

        expect(inflight()).toBe(2);

        exit(0);
        await spawned.control.exitCode();
        await other.control.exitCode();

        // Both processes share one exit here; each released exactly once.
        expect(inflight()).toBe(0);

        spawned.control.kill();

        expect(inflight()).toBe(0);
    });

    it("starts a stopped container first", async () => {
        expect.assertions(1);

        const { exit, process } = controllableProcess();
        const { instance, started } = spawnInstance(async () => process, false);

        await instance.lunoraSpawn({ command: "true" });
        exit(0);

        expect(started).toHaveBeenCalledTimes(1);
    });

    it("runs on a PTY with stdin when asked, and resizes it", async () => {
        expect.assertions(4);

        const { process, resize } = controllableProcess({ isPty: true, stderr: null });
        const exec = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => process);
        const { instance } = spawnInstance(exec);
        const spawned = await instance.lunoraSpawn({ command: "bash", pty: { cols: 100 }, stdin: true });

        expect(exec.mock.calls[0]![1]).toMatchObject({ pty: { cols: 100, rows: 24 }, stdin: "pipe" });
        expect(spawned.stdin).toBeInstanceOf(WritableStream);

        spawned.control.resize(120, 40);

        expect(resize).toHaveBeenCalledWith(120, 40);
        expect(spawned.isPty).toBe(true);
    });

    it("refuses resize on a process without a PTY", async () => {
        expect.assertions(1);

        const { process } = controllableProcess();
        const { instance } = spawnInstance(async () => process);
        const spawned = await instance.lunoraSpawn({ command: "ls" });

        expect(() => {
            spawned.control.resize(80, 24);
        }).toThrow("resize() needs a process spawned with `pty`");
    });

    it("kills the process when timeoutMs elapses", async () => {
        expect.assertions(2);

        const { kill, process } = controllableProcess();
        const { instance } = spawnInstance(async () => process);
        const spawned = await instance.lunoraSpawn({ command: "hang", timeoutMs: 5 });

        await expect(spawned.control.exitCode()).resolves.toBe(143);
        expect(kill).toHaveBeenCalledTimes(1);
    });

    it("releases the in-flight count when the process fails to start", async () => {
        expect.assertions(2);

        const { inflight, instance } = spawnInstance(async () => {
            throw new Error("no such file");
        });

        await expect(instance.lunoraSpawn({ command: "missing" })).rejects.toThrow("no such file");
        expect(inflight()).toBe(0);
    });

    it("refuses on a runtime without native exec", async () => {
        expect.assertions(1);

        const context = fakeDurableObjectContext({ running: true });
        const instance = new LunoraContainer(context as never, {}, defineContainer({ image: "./app" }), "runner");

        await expect(instance.lunoraSpawn({ command: "ls" })).rejects.toThrow("spawn() needs the runtime's native ctx.container.exec()");
    });
});
