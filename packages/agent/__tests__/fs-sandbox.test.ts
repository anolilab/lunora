import { describe, expect, it } from "vitest";

import { fsTool } from "../src/sandbox";
import type { R2BucketLike, SandboxInvokeArgs } from "../src/sandbox-component";
import { resolveFsKey, runFsOp } from "../src/sandbox-component";
import type { AgentToolContext } from "../src/types";

const ESCAPE_ROOT_PATTERN = /escapes the sandbox root/u;
const NO_FILE_PATTERN = /no file/u;
const REQUIRES_BUCKET_PATTERN = /requires an R2 `bucket`/u;
const EXCEEDS_MAX_PATTERN = /exceeds the max/u;
const MAX_PATTERN = /max/u;

/** In-memory `R2BucketLike` double: a `Map` of key → contents. */
const memoryBucket = (): { bucket: R2BucketLike; store: Map<string, string> } => {
    const store = new Map<string, string>();

    return {
        bucket: {
            delete: async (key) => {
                store.delete(key);
            },
            get: async (key) => (store.has(key) ? { text: async () => store.get(key) ?? "" } : null),
            head: async (key) => (store.has(key) ? { key, size: (store.get(key) ?? "").length } : null),
            list: async (options) => {
                return {
                    objects: [...store.keys()]
                        .filter((key) => key.startsWith(options?.prefix ?? ""))
                        .map((key) => {
                            return { key, size: (store.get(key) ?? "").length };
                        }),
                };
            },
            put: async (key, value) => {
                store.set(key, value);
            },
        },
        store,
    };
};

const fs = (op: string, extra: Partial<SandboxInvokeArgs> = {}): SandboxInvokeArgs => {
    return { kind: "fs", op, ...extra };
};

describe(resolveFsKey, () => {
    it("scopes a path under the root and normalizes . and empty segments", () => {
        expect(resolveFsKey("agents/coder", "notes.txt")).toBe("agents/coder/notes.txt");
        expect(resolveFsKey("/agents/coder/", "/sub//./a.txt")).toBe("agents/coder/sub/a.txt");
        expect(resolveFsKey("", "a/b.txt")).toBe("a/b.txt");
        // `..` within the relative path is allowed (stays under root).
        expect(resolveFsKey("agents/coder", "dir/../a.txt")).toBe("agents/coder/a.txt");
    });

    it("rejects a `..` that escapes the sandbox root", () => {
        expect(() => resolveFsKey("agents/coder", "../secret")).toThrow(ESCAPE_ROOT_PATTERN);
        expect(() => resolveFsKey("agents/coder", "a/../../secret")).toThrow(ESCAPE_ROOT_PATTERN);
    });
});

describe(runFsOp, () => {
    const root = "agents/coder";

    it("write then read round-trips under the scoped key", async () => {
        const { bucket, store } = memoryBucket();

        await runFsOp(bucket, root, fs("write", { content: "hello", path: "notes.txt" }));

        expect(store.get("agents/coder/notes.txt")).toBe("hello");
        await expect(runFsOp(bucket, root, fs("read", { path: "notes.txt" }))).resolves.toBe("hello");
    });

    it("lists directory entries as root-relative paths", async () => {
        const { bucket } = memoryBucket();

        await runFsOp(bucket, root, fs("write", { content: "a", path: "src/a.txt" }));
        await runFsOp(bucket, root, fs("write", { content: "b", path: "src/b.txt" }));

        await expect(runFsOp(bucket, root, fs("ls", { path: "src" }))).resolves.toStrictEqual({ entries: ["src/a.txt", "src/b.txt"] });
    });

    it("stat reports existence and size; read of a missing file throws NOT_FOUND", async () => {
        const { bucket } = memoryBucket();

        await runFsOp(bucket, root, fs("write", { content: "12345", path: "f.txt" }));

        await expect(runFsOp(bucket, root, fs("stat", { path: "f.txt" }))).resolves.toStrictEqual({ exists: true, size: 5 });
        await expect(runFsOp(bucket, root, fs("stat", { path: "missing" }))).resolves.toStrictEqual({ exists: false });
        await expect(runFsOp(bucket, root, fs("read", { path: "missing" }))).rejects.toThrow(NO_FILE_PATTERN);
    });

    it("rm deletes the scoped key", async () => {
        const { bucket, store } = memoryBucket();

        await runFsOp(bucket, root, fs("write", { content: "x", path: "f.txt" }));
        await runFsOp(bucket, root, fs("rm", { path: "f.txt" }));

        expect(store.has("agents/coder/f.txt")).toBe(false);
    });

    it("reports the UTF-8 byte count on write, not the UTF-16 char length", async () => {
        const { bucket } = memoryBucket();

        // "€" is 1 char but 3 UTF-8 bytes.
        const result = (await runFsOp(bucket, root, fs("write", { content: "€", path: "f.txt" }))) as { bytes: number };

        expect(result.bytes).toBe(3);
    });

    it("rejects an oversized write and an oversized read", async () => {
        const { bucket, store } = memoryBucket();

        await expect(runFsOp(bucket, root, fs("write", { content: "x".repeat(1_000_001), path: "big.txt" }))).rejects.toThrow(EXCEEDS_MAX_PATTERN);

        // Seed a large object directly and assert read rejects it before pulling it in.
        store.set("agents/coder/huge.txt", "y".repeat(1_000_001));

        await expect(runFsOp(bucket, root, fs("read", { path: "huge.txt" }))).rejects.toThrow(MAX_PATTERN);
    });

    it("paginates ls across R2 list cursors", async () => {
        const pages = [
            { cursor: "c1", objects: [{ key: "agents/coder/a.txt", size: 1 }], truncated: true },
            { objects: [{ key: "agents/coder/b.txt", size: 1 }], truncated: false },
        ];
        let call = 0;
        const paginating: R2BucketLike = {
            ...memoryBucket().bucket,
            list: async () => {
                const page = pages[call] ?? { objects: [] };
                call += 1;

                return page;
            },
        };

        const result = (await runFsOp(paginating, root, fs("ls", { path: "" }))) as { entries: string[] };

        expect(result.entries).toStrictEqual(["a.txt", "b.txt"]);
    });
});

describe(fsTool, () => {
    it("dispatches sandbox:invoke with the pinned bucket/root/kind and the model input", async () => {
        const seen: { args: Record<string, unknown> | undefined; ref: string }[] = [];
        const context = {
            run: async (reference: { __lunoraRef: string }, args?: Record<string, unknown>) => {
                seen.push({ args, ref: reference["__lunoraRef"] });

                return { ok: true };
            },
        } as unknown as AgentToolContext;

        const tool = fsTool("SANDBOX_BUCKET", { root: "agents/coder" });

        await tool.execute({ content: "hi", op: "write", path: "a.txt" }, context);

        expect(seen).toStrictEqual([
            { args: { bucket: "SANDBOX_BUCKET", content: "hi", kind: "fs", op: "write", path: "a.txt", root: "agents/coder" }, ref: "sandbox:invoke" },
        ]);
    });

    it("gates the writing ops by default and leaves reads unattended", () => {
        const tool = fsTool("SANDBOX_BUCKET");
        const gate = tool.needsApproval as (input: { op: string }) => boolean;

        expect(gate({ op: "write" })).toBe(true);
        expect(gate({ op: "rm" })).toBe(true);
        expect(gate({ op: "read" })).toBe(false);
        expect(gate({ op: "ls" })).toBe(false);
        expect(gate({ op: "stat" })).toBe(false);
    });

    it("resolves a root function against the tool context (per-run isolation)", async () => {
        const seen: Record<string, unknown>[] = [];
        const context = {
            run: async (_reference: { __lunoraRef: string }, args?: Record<string, unknown>) => {
                seen.push(args ?? {});

                return { ok: true };
            },
            threadKey: "user-9",
        } as unknown as AgentToolContext;

        const tool = fsTool("SANDBOX_BUCKET", { root: (ctx) => `agents/${ctx.threadKey}` });

        await tool.execute({ op: "ls" }, context);

        expect(seen[0]?.["root"]).toBe("agents/user-9");
    });

    it("throws without a bucket binding name", () => {
        expect(() => fsTool("")).toThrow(REQUIRES_BUCKET_PATTERN);
    });
});
