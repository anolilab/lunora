import { isLunoraError } from "@lunora/errors";
import { describe, expect, it, vi } from "vitest";

import type { SandboxContainerInstanceHandle } from "../src/index";
import { createContainerContext, createContainerTestContext, getContainer } from "../src/index";

/** A namespace whose every stub is `stub`, recording the instance names it was asked for. */
const namespaceOf = (stub: Record<string, unknown>) => {
    const names: string[] = [];

    return {
        names,
        namespace: {
            get: (id: unknown) => {
                names.push(String(id));

                return { fetch: async () => new Response("ok"), ...stub };
            },
            idFromName: (name: string) => name,
        },
    };
};

describe("ctx.containers sandbox + spawn", () => {
    it("forwards the sandbox helpers to the container DO's RPCs, with every argument", async () => {
        expect.assertions(3);

        const lunoraRename = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
        const lunoraBackup = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => {
            return { id: "b1" };
        });
        const { namespace } = namespaceOf({ lunoraBackup, lunoraRename });
        const box = createContainerContext({ CONTAINER_BOX: namespace }, [{ binding: "CONTAINER_BOX", exportName: "box" }]).box!.get(
            "u1",
        ) as SandboxContainerInstanceHandle;

        await box.files.rename("a", "b", { cwd: "/w" });

        await expect(box.backup("/workspace", { name: "n" })).resolves.toStrictEqual({ id: "b1" });
        expect(lunoraRename).toHaveBeenCalledWith("a", "b", { cwd: "/w" });
        expect(lunoraBackup).toHaveBeenCalledWith("/workspace", { name: "n" });
    });

    it("tells a container without `sandbox: true` how to get the helpers", async () => {
        expect.assertions(2);

        const { namespace } = namespaceOf({});
        const box = createContainerContext({ CONTAINER_BOX: namespace }, [{ binding: "CONTAINER_BOX", exportName: "box" }]).box!.get(
            "u1",
        ) as SandboxContainerInstanceHandle;
        const error = await box.files.stat("/x").then(
            () => undefined,
            (error_: unknown) => error_,
        );

        expect(isLunoraError(error) && error.code).toBe("BAD_REQUEST");
        expect((error as Error).message).toContain("sandbox helpers need `sandbox: true`");
    });

    it("spawns through the DO and kills the process when the caller's signal aborts", async () => {
        expect.assertions(3);

        const kill = vi.fn<() => void>();
        const lunoraSpawn = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => {
            return {
                control: { exitCode: async () => new Promise<number>(() => {}), kill, resize: () => {} },
                isPty: false,
                pid: 9,
                stderr: null,
                stdin: null,
                stdout: null,
            };
        });
        const { namespace } = namespaceOf({ lunoraSpawn });
        const box = createContainerContext({ CONTAINER_BOX: namespace }, [{ binding: "CONTAINER_BOX", exportName: "box" }]).box!.get("u1");
        const controller = new AbortController();
        const process = await box.spawn("make", { args: ["build"], signal: controller.signal, timeoutMs: 1000 });

        controller.abort();

        expect(process.pid).toBe(9);
        expect(lunoraSpawn).toHaveBeenCalledWith({ args: ["build"], command: "make", timeoutMs: 1000 });
        expect(kill).toHaveBeenCalledTimes(1);
    });

    it("getContainer reaches a named instance straight off the Worker env", async () => {
        expect.assertions(2);

        const { names, namespace } = namespaceOf({});
        const handle = getContainer({ CONTAINER_BOX: namespace }, "box", "user-1");

        await expect(handle.fetch("/").then(async (response) => response.text())).resolves.toBe("ok");
        expect(names).toStrictEqual(["user-1"]);
    });
});

describe("createContainerTestContext files", () => {
    const box = (): SandboxContainerInstanceHandle =>
        createContainerTestContext({ box: () => new Response("ok") }).box!.get("u1") as SandboxContainerInstanceHandle;

    it("keeps one in-memory disk per instance", async () => {
        expect.assertions(4);

        const containers = createContainerTestContext({ box: () => new Response("ok") });
        const first = containers.box!.get("u1") as SandboxContainerInstanceHandle;

        await first.files.mkdir("/work/src", { recursive: true });
        await first.files.writeFile("src/main.ts", "export {}", { cwd: "/work" });

        await expect(
            (containers.box!.get("u1") as SandboxContainerInstanceHandle).files.readFile("/work/src/main.ts").then(async (r) => r.text()),
        ).resolves.toBe("export {}");
        await expect(first.files.readDirectory("/work")).resolves.toStrictEqual([{ name: "src", type: "directory" }]);
        await expect(first.files.stat("/work/src/main.ts")).resolves.toMatchObject({ size: 9n, type: "file" });
        await expect((containers.box!.get("u2") as SandboxContainerInstanceHandle).files.stat("/work")).rejects.toThrow("ENOENT");
    });

    it("answers missing paths and non-empty directories the way Linux does", async () => {
        expect.assertions(4);

        const handle = box();

        await handle.files.mkdir("/a");
        await handle.files.writeFile("/a/f", "x");

        await expect(handle.files.writeFile("/missing/f", "x")).rejects.toThrow("ENOENT");
        await expect(handle.files.remove("/a")).rejects.toThrow("ENOTEMPTY");
        await expect(handle.files.remove("/nope", { force: true })).resolves.toBeUndefined();

        await handle.files.rename("/a", "/b");

        await expect(handle.files.readFile("/b/f").then(async (r) => r.text())).resolves.toBe("x");
    });

    it("refuses to move a directory into its own subtree, as Linux does", async () => {
        expect.assertions(2);

        const handle = box();

        await handle.files.mkdir("/a/b", { recursive: true });

        await expect(handle.files.rename("/a", "/a/b/c")).rejects.toThrow("EINVAL");
        await expect(handle.files.readDirectory("/a")).resolves.toStrictEqual([{ name: "b", type: "directory" }]);
    });

    it("says spawn and backups need a real container", async () => {
        expect.assertions(2);

        await expect(box().spawn("ls")).rejects.toThrow("spawn() needs a real container");
        await expect(box().backup("/w")).rejects.toThrow("backup() needs a real container");
    });
});
