import { createContainerTestContext } from "@lunora/container";
import { describe, expect, it } from "vitest";

import { containerFsTool } from "../src/sandbox";
import type { SandboxContainerAccessor, SandboxInvokeArgs } from "../src/sandbox-component";
import { runContainerFsOp } from "../src/sandbox-component";
import type { AgentToolContext } from "../src/types";

/** A `sandbox: true` container's accessor, backed by the `@lunora/container` test double's in-memory disk. */
const sandboxAccessor = (): SandboxContainerAccessor =>
    createContainerTestContext({ sandbox: () => new Response("ok") }).sandbox as unknown as SandboxContainerAccessor;

const fsOp = (op: string, extra: Partial<SandboxInvokeArgs> = {}): SandboxInvokeArgs => {
    return { instance: "thread-1", kind: "containerFs", name: "sandbox", op, root: "/workspace", ...extra };
};

describe(runContainerFsOp, () => {
    it("writes under the root, creating parents, and reads it back from the same instance", async () => {
        expect.assertions(3);

        const accessor = sandboxAccessor();

        await expect(runContainerFsOp(accessor, fsOp("write", { content: "export {}", path: "src/main.ts" }))).resolves.toStrictEqual({
            bytes: 9,
            path: "src/main.ts",
            wrote: true,
        });
        await expect(runContainerFsOp(accessor, fsOp("read", { path: "src/main.ts" }))).resolves.toBe("export {}");
        await expect(runContainerFsOp(accessor, fsOp("ls", { path: "" }))).resolves.toStrictEqual({ entries: ["src/"] });
    });

    it("keeps each thread on its own disk", async () => {
        expect.assertions(1);

        const accessor = sandboxAccessor();

        await runContainerFsOp(accessor, fsOp("write", { content: "x", path: "a.txt" }));

        await expect(runContainerFsOp(accessor, fsOp("stat", { instance: "thread-2", path: "a.txt" }))).resolves.toStrictEqual({ exists: false });
    });

    it("stats a file, and removes it idempotently", async () => {
        expect.assertions(3);

        const accessor = sandboxAccessor();

        await runContainerFsOp(accessor, fsOp("write", { content: "abc", path: "a.txt" }));

        await expect(runContainerFsOp(accessor, fsOp("stat", { path: "a.txt" }))).resolves.toStrictEqual({ exists: true, size: 3, type: "file" });
        await expect(runContainerFsOp(accessor, fsOp("rm", { path: "a.txt" }))).resolves.toStrictEqual({ path: "a.txt", removed: true });
        await expect(runContainerFsOp(accessor, fsOp("rm", { path: "a.txt" }))).resolves.toStrictEqual({ path: "a.txt", removed: true });
    });

    it("refuses a path that escapes the root, an oversized write, and a dispatch with no instance", async () => {
        expect.assertions(3);

        const accessor = sandboxAccessor();

        await expect(runContainerFsOp(accessor, fsOp("read", { path: "../etc/passwd" }))).rejects.toThrow("escapes the sandbox root");
        await expect(runContainerFsOp(accessor, fsOp("write", { content: "x".repeat(1_000_001), path: "big" }))).rejects.toThrow("exceeds the max");
        await expect(runContainerFsOp(accessor, fsOp("read", { instance: undefined, path: "a" }))).rejects.toThrow("no `instance`");
    });
});

describe("runContainerFsOp read cap", () => {
    it("refuses a file that grew past the cap between stat and read, instead of truncating it", async () => {
        expect.assertions(1);

        const big = "x".repeat(1_000_001);
        const accessor = {
            any: () => {
                throw new Error("unused");
            },
            get: () => {
                return {
                    exec: async () => {
                        return { code: 0, stderr: "", stdout: "" };
                    },
                    fetch: async () => new Response(""),
                    files: {
                        mkdir: async () => {},
                        readDirectory: async () => [],
                        readFile: async () => new Response(big),
                        remove: async () => {},
                        stat: async () => {
                            return { size: 10, type: "file" };
                        },
                        writeFile: async () => {},
                    },
                };
            },
        } as unknown as SandboxContainerAccessor;

        await expect(runContainerFsOp(accessor, fsOp("read", { path: "grows.log" }))).rejects.toThrow("exceeds 1000000 bytes");
    });
});

describe(containerFsTool, () => {
    it("dispatches sandbox:invoke pinned to the thread's container and the root", async () => {
        expect.assertions(1);

        const seen: unknown[] = [];
        const context = {
            run: async (reference: { __lunoraRef: string }, args?: Record<string, unknown>) => {
                seen.push({ args, ref: reference["__lunoraRef"] });

                return { ok: true };
            },
            threadKey: "thread-9",
        } as unknown as AgentToolContext;

        await containerFsTool("sandbox", { root: "/src" }).execute({ op: "read", path: "a.txt" }, context);

        expect(seen).toStrictEqual([
            { args: { instance: "thread-9", kind: "containerFs", name: "sandbox", op: "read", path: "a.txt", root: "/src" }, ref: "sandbox:invoke" },
        ]);
    });

    it("gates the writing ops by default, and refuses a relative root", () => {
        expect.assertions(3);

        const gate = containerFsTool("sandbox").needsApproval as (input: { op: string }) => boolean;

        expect(gate({ op: "write" })).toBe(true);
        expect(gate({ op: "read" })).toBe(false);
        expect(() => containerFsTool("sandbox", { root: "workspace" })).toThrow("must be an absolute path");
    });
});
