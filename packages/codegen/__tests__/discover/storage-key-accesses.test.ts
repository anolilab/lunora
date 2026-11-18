import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverStorageKeyAccesses from "../../src/discover/storage-key-accesses";
import type { FunctionIR } from "../../src/ir";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

describe("discoverStorageKeyAccesses", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-storage-key-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("flags a direct ctx.storage.<bucket>.get(args.key)", () => {
        expect.assertions(2);

        write("read.ts", `export const read = query(async ({ ctx, args }) => { return ctx.storage.avatars.get(args.key); });`);

        const found = discoverStorageKeyAccesses(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ scope: { kind: "export", name: "read" }, file: "read", line: 1, method: "get" });
    });

    it("flags a key destructured from an owned row with a caller-controlled default", () => {
        expect.assertions(1);

        write(
            "row-default.ts",
            `export const read = query(async ({ ctx, args }) => { const { storageKey = args.key } = await ctx.db.files.findFirst({ where: { ownerId: ctx.auth.userId } }); return ctx.storage.files.get(storageKey); });`,
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("flags an owned-row key whose default forwards args through a local", () => {
        expect.assertions(1);

        write(
            "local-default.ts",
            `export const read = query(async ({ ctx, args }) => { const requestedKey = args.key; const { storageKey = requestedKey } = await ctx.db.files.findFirst({ where: { ownerId: ctx.auth.userId } }); return ctx.storage.files.get(\`\${storageKey}/\${args.name}\`); });`,
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("flags a stored key that falls back to the caller's key", () => {
        expect.assertions(1);

        write(
            "stored-fallback.ts",
            `export const read = query(async ({ ctx, args }) => { const row = await ctx.db.files.findFirst({ where: { ownerId: ctx.auth.userId } }); return ctx.storage.files.get(row?.storageKey ?? args.key); });`,
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("flags a bare key destructured from a row the caller picked by id", () => {
        expect.assertions(1);

        write(
            "picked-row.ts",
            `export const read = query(async ({ ctx, args }) => { const { storageKey } = await ctx.db.get("files", args.id); return ctx.storage.files.get(storageKey); });`,
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("flags a put with an args-derived key", () => {
        expect.assertions(2);

        write("upload.ts", `export const upload = mutation(async ({ ctx, args }) => { await ctx.storage.docs.put(args.name, args.body); });`);

        const found = discoverStorageKeyAccesses(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ scope: { kind: "export", name: "upload" }, method: "put" });
    });

    it("flags a delete with an args-derived key", () => {
        expect.assertions(2);

        write("remove.ts", `export const remove = mutation(async ({ ctx, args }) => { await ctx.storage.docs.delete(args.key); });`);

        const found = discoverStorageKeyAccesses(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ scope: { kind: "export", name: "remove" }, method: "delete" });
    });

    it("flags an args key reached through one local const hop", () => {
        expect.assertions(1);

        write("hop.ts", `export const save = mutation(async ({ ctx, args }) => { const k = args.key; await ctx.storage.docs.put(k, args.body); });`);

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("flags a default-bucket call (ctx.storage.download(args.key))", () => {
        expect.assertions(2);

        write("dl.ts", `export const grab = action(async ({ ctx, args }) => { return ctx.storage.download(args.key); });`);

        const found = discoverStorageKeyAccesses(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ scope: { kind: "export", name: "grab" }, method: "download" });
    });

    it("flags a key prefixed only by a server-trusted non-identity ctx value", () => {
        expect.assertions(1);

        write("env-prefix.ts", `export const read = query(async ({ ctx, args }) => { return ctx.storage.avatars.get(\`\${ctx.env.PREFIX}/\${args.key}\`); });`);

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("ignores a key scoped by the caller's own identity", () => {
        expect.assertions(1);

        write(
            "own-prefix.ts",
            `export const read = query(async ({ ctx, args }) => { return ctx.storage.avatars.get(\`\${ctx.auth.userId}/\${args.key}\`); });`,
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("reports a key read off a database row the caller selected by id", () => {
        expect.assertions(1);

        write(
            "owned-row.ts",
            `export const read = query(async ({ ctx, args }) => { const row = await ctx.db.get("files", args.id); return ctx.storage.avatars.get(row.key); });`,
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("ignores a key read off a database row fetched by the caller's identity", () => {
        expect.assertions(1);

        write(
            "identity-row.ts",
            `export const read = query(async ({ ctx, args }) => { const row = await ctx.db.files.findFirst({ where: { ownerId: ctx.auth.userId, id: args.id } }); return ctx.storage.avatars.get(row.key); });`,
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a ctx-scoped key reached through one local const hop", () => {
        expect.assertions(1);

        write(
            "scoped-hop.ts",
            `export const save = mutation(async ({ ctx, args }) => { const k = \`\${ctx.auth.userId}/\${args.name}\`; await ctx.storage.avatars.put(k, args.body); });`,
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a key scoped by a server-trusted ctx value", () => {
        expect.assertions(1);

        write(
            "scoped.ts",
            `export const save = mutation(async ({ ctx, args }) => { await ctx.storage.avatars.put(\`\${ctx.auth.userId}/\${args.name}\`, args.body); });`,
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a key prefixed by a locally-bound ctx identity (two hops)", () => {
        expect.assertions(1);

        // The recommended remediation, written idiomatically: the identity reaches ctx
        // only through the `userId` binding, one hop deeper than the key template — so
        // `avatars/${userId}/${args.key}` is scoped, not attacker-controlled.
        write(
            "identity-prefix.ts",
            `export const uploadAvatar = action(async ({ ctx, args }) => {
                const userId = ctx.auth.userId ?? "anonymous";
                const scopedKey = \`avatars/\${userId}/\${args.key}\`;
                return ctx.storage.avatars.generateUploadUrl(scopedKey, { contentType: args.contentType });
            });`,
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a fixed literal key", () => {
        expect.assertions(1);

        write("fixed.ts", `export const logo = query(async ({ ctx }) => { return ctx.storage.assets.get("logo.png"); });`);

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a non-storage receiver (ctx.kv)", () => {
        expect.assertions(1);

        write("kv.ts", `export const cached = query(async ({ ctx, args }) => { return ctx.kv.get(args.key); });`);

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a list call (a key prefix, not a per-object key)", () => {
        expect.assertions(1);

        write("browse.ts", `export const browse = query(async ({ ctx, args }) => { return ctx.storage.docs.list(args.prefix); });`);

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    // Issue #284: `storage_key_from_user_args` had no reachability model — both
    // real-world false positives were `internalAction`s receiving a
    // content-addressed storage id minted server-side.
    it("ignores a key rebuilt by an intervening call (content-addressed, not caller-controlled)", () => {
        expect.assertions(1);

        write(
            "extraction.ts",
            `export const extractDocumentText = internalAction(async ({ ctx, args }) => { return ctx.storage.docs.getUrl(hashOf(args.storageId)); });`,
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a key reached through one local hop to an intervening call", () => {
        expect.assertions(1);

        write(
            "hop-call.ts",
            `export const extractDocumentText = internalAction(async ({ ctx, args }) => {
                const key = hashOf(args.storageId);
                return ctx.storage.docs.getUrl(key);
            });`,
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("attaches the enclosing procedure's visibility when `functions` is supplied", () => {
        expect.assertions(2);

        write(
            "extraction2.ts",
            `export const extractDocumentText = internalAction(async ({ ctx, args }) => { return ctx.storage.docs.get(args.storageId); });`,
        );

        const functions: FunctionIR[] = [
            { args: {}, exportName: "extractDocumentText", filePath: "extraction2", kind: "action", returnType: "unknown", visibility: "internal" },
        ];
        const found = discoverStorageKeyAccesses(project, join(workdir, "lunora"), functions);

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ visibility: "internal" });
    });

    it("leaves visibility undefined when the access can't be attributed to a supplied function", () => {
        expect.assertions(2);

        write("orphan.ts", `export const orphan = query(async ({ ctx, args }) => { return ctx.storage.docs.get(args.storageId); });`);

        const found = discoverStorageKeyAccesses(project, join(workdir, "lunora"), []);

        expect(found).toHaveLength(1);
        expect(found[0]?.visibility).toBeUndefined();
    });
});

describe("discoverStorageKeyAccesses identity-bound guard", () => {
    const SINK = "return ctx.storage.attachments.getSignedUrl(message.attachmentKey, { expiresIn: 60 });";
    const HELPER = `const requireMember = async (ctx, channelId) => {
    const userId = ctx.auth.userId;
    if (!userId) {
        throw new Error("UNAUTHENTICATED");
    }
    const row = await ctx.db.query("members").withIndex("by_channel_user", (q) => q.eq("channelId", channelId).eq("userId", userId)).first();
    if (!row) {
        throw new Error("FORBIDDEN");
    }
};`;

    /** The team-chat handler: the row comes from a caller-supplied id, then `guard` runs before `sink`. */
    const teamChat = (guard: string, sink: string = SINK, helper: string = HELPER): string => `${helper}
export const getAttachment = query(async ({ ctx, args }) => {
    const message = await ctx.db.get("messages", args.messageId);
    if (!message) {
        throw new Error("not found");
    }
    ${guard}
    ${sink}
});`;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-storage-guard-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("accepts a helper guard that checks the caller against the row before the sink", () => {
        expect.assertions(1);

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);"));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("accepts a helper that destructures the caller's id from ctx.auth", () => {
        expect.assertions(1);

        const helper = `const requireMember = async (ctx, channelId) => {
    const { userId } = ctx.auth;
    if (!userId) {
        throw new Error("UNAUTHENTICATED");
    }
    const row = await ctx.db.query("members").withIndex("by_channel_user", (q) => q.eq("channelId", channelId).eq("userId", userId)).first();
    if (!row) {
        throw new Error("FORBIDDEN");
    }
};`;

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, helper));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("reports a helper that destructures from a value other than ctx.auth", () => {
        expect.assertions(1);

        const helper = `const requireMember = async (ctx, channelId, opts) => {
    const { userId } = opts;
    if (!userId) {
        throw new Error("UNAUTHENTICATED");
    }
    const row = await ctx.db.query("members").withIndex("by_channel_user", (q) => q.eq("channelId", channelId).eq("userId", userId)).first();
    if (!row) {
        throw new Error("FORBIDDEN");
    }
};`;

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, helper));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a helper whose destructured id comes from a nested pattern", () => {
        expect.assertions(1);

        const helper = `const requireMember = async (ctx, channelId) => {
    const { auth: { userId } } = ctx;
    if (!userId) {
        throw new Error("UNAUTHENTICATED");
    }
    const row = await ctx.db.query("members").withIndex("by_channel_user", (q) => q.eq("channelId", channelId).eq("userId", userId)).first();
    if (!row) {
        throw new Error("FORBIDDEN");
    }
};`;

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, helper));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("accepts an inline identity guard that checks the row before the sink", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(`const membership = await ctx.db.members.findFirst({ where: { userId: ctx.auth.userId, channelId: message.channelId } });
    if (!membership) {
        throw new Error("forbidden");
    }`),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("accepts an inline findFirstOrThrow identity guard with no following check", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat("const membership = await ctx.db.members.findFirstOrThrow({ where: { userId: ctx.auth.userId, channelId: message.channelId } });"),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("accepts an inline identity guard written as a fluent withIndex chain", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(`const membership = await ctx.db.query("members").withIndex("by_channel_user", (q) => q.eq("channelId", message.channelId).eq("userId", ctx.auth.userId)).first();
    if (!membership) {
        throw new Error("forbidden");
    }`),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("reports an awaited async generator helper, whose body never runs", () => {
        expect.assertions(1);

        const helper = `async function* requireMember(ctx, channelId) {
    const row = await ctx.db.members.findFirstOrThrow({ where: { userId: ctx.auth.userId, channelId } });
}`;

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, helper));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("accepts a helper guard imported from a second file", () => {
        expect.assertions(1);

        write("guards.ts", HELPER.replace("const requireMember", "export const requireMember"));
        write("chat.ts", `import { requireMember } from "./guards";\n${teamChat("await requireMember(ctx, message.channelId);", SINK, "")}`);

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("reports a key read off a row the handler created from caller input", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            `${HELPER}
export const send = mutation(async ({ ctx, args }) => {
    const message = await ctx.db.insert("messages", { attachmentKey: args.key, channelId: args.channelId });
    await requireMember(ctx, message.channelId);
    ${SINK}
});`,
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a helper guard whose row argument falls back to a caller value", () => {
        expect.assertions(1);

        write("chat.ts", teamChat("await requireMember(ctx, args.channelId || message.channelId);"));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a helper that can return before its identity read is enforced", () => {
        expect.assertions(1);

        const helper = `const requireMember = async (ctx, channelId) => {
    const userId = ctx.auth.userId;
    if (!userId) {
        return;
    }
    const row = await ctx.db.query("members").withIndex("by_channel_user", (q) => q.eq("channelId", channelId).eq("userId", userId)).first();
    if (!row) {
        throw new Error("FORBIDDEN");
    }
};`;

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, helper));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a guarded row whose key the handler overwrites before the sink", () => {
        expect.assertions(1);

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);\n    message.attachmentKey = args.key;"));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a helper function declaration that is reassigned before the call", () => {
        expect.assertions(1);

        const helper = `async function requireMember(ctx, channelId) {
    const userId = ctx.auth.userId;
    const row = await ctx.db.query("members").withIndex("by_channel_user", (q) => q.eq("channelId", channelId).eq("userId", userId)).first();
    if (!row) {
        throw new Error("FORBIDDEN");
    }
}
requireMember = async () => {};`;

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, helper));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("accepts a helper written as a function declaration", () => {
        expect.assertions(1);

        const helper = `async function requireMember(ctx, channelId) {
    const userId = ctx.auth.userId;
    const row = await ctx.db.query("members").withIndex("by_channel_user", (q) => q.eq("channelId", channelId).eq("userId", userId)).first();
    if (!row) {
        throw new Error("FORBIDDEN");
    }
}`;

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, helper));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("reports a helper guard whose argument does not reference the row", () => {
        expect.assertions(1);

        write("chat.ts", teamChat("await requireMember(ctx, args.channelId);"));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports an inline guard whose result is never checked", () => {
        expect.assertions(1);

        write("chat.ts", teamChat("const membership = await ctx.db.members.findFirst({ where: { userId: ctx.auth.userId, channelId: message.channelId } });"));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports an inline guard whose branch neither throws nor returns", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(`const membership = await ctx.db.members.findFirst({ where: { userId: ctx.auth.userId, channelId: message.channelId } });
    if (!membership) {
        console.warn("not a member");
    }`),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a guard that runs only inside one branch", () => {
        expect.assertions(1);

        write("chat.ts", teamChat("if (args.strict) {\n        await requireMember(ctx, message.channelId);\n    }"));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a guard that shares a branch with the sink", () => {
        expect.assertions(1);

        write("chat.ts", teamChat(`if (args.strict) {\n        await requireMember(ctx, message.channelId);\n        ${SINK}\n    }`, ""));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each([
        ["the row", "console.log(JSON.stringify(message));"],
        ["the row with a replacer that writes it", "JSON.stringify(message, (k, v) => {\n        v.attachmentKey = args.key;\n        return v;\n    });"],
        [
            "a row whose toJSON writes it",
            "message.toJSON = function () {\n        this.attachmentKey = args.key;\n        return {};\n    };\n    JSON.stringify(message);",
        ],
    ])("reports a guarded row serialised with JSON.stringify: %s", (_label, use) => {
        expect.assertions(1);

        write("chat.ts", teamChat(`await requireMember(ctx, message.channelId);\n    ${use}`));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a helper guard that serialises a nested holder of the key", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(
                "await requireMember(ctx, message);",
                "return ctx.storage.attachments.getSignedUrl(message.meta.key, { expiresIn: 60 });",
                `const requireMember = async (ctx, message) => {
    const row = await ctx.db.members.findFirst({ where: { userId: ctx.auth.userId, channelId: message.channelId } });
    if (!row) {
        throw new Error("FORBIDDEN");
    }
    console.log(JSON.stringify(message.meta));
};`,
            ),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a function helper guard that writes the row through its arguments object", () => {
        expect.assertions(1);

        const helper = `async function requireMember(ctx, message) {
    const row = await ctx.db.members.findFirst({ where: { userId: ctx.auth.userId, channelId: message.channelId } });
    if (!row) {
        throw new Error("FORBIDDEN");
    }
    arguments[1].attachmentKey = ctx.auth.userId;
}`;

        write("chat.ts", teamChat("await requireMember(ctx, message);", SINK, helper));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("accepts a function helper guard whose nested function reads its own arguments", () => {
        expect.assertions(1);

        const helper = `async function requireMember(ctx, message) {
    const row = await ctx.db.members.findFirst({ where: { userId: ctx.auth.userId, channelId: message.channelId } });
    if (!row) {
        throw new Error("FORBIDDEN");
    }
    globalThis.log = function () {
        return arguments.length;
    };
}`;

        write("chat.ts", teamChat("await requireMember(ctx, message);", SINK, helper));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it.each([
        ["identity first", `(m) => m.userId === ctx.auth.userId && m.channelId === message.channelId`],
        ["identity second", `(m) => m.channelId === message.channelId && m.userId === ctx.auth.userId`],
        ["a row field tested first", `(m) => m.active && m.userId === ctx.auth.userId && m.channelId === message.channelId`],
        ["a row method called first", `(m) => m.roles.includes("member") && m.userId === ctx.auth.userId && m.channelId === message.channelId`],
    ])("accepts an inline guard whose filter requires the identity with &&, %s", (_label, filter) => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(`const membership = await ctx.db.query("members").filter(${filter}).first();
    if (!membership) {
        throw new Error("forbidden");
    }`),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it.each([
        ["identity first", `(m) => m.userId === ctx.auth.userId && m.channelId === channelId`],
        ["identity second", `(m) => m.channelId === channelId && m.userId === ctx.auth.userId`],
        ["a row field tested first", `(m) => m.active && m.userId === ctx.auth.userId && m.channelId === channelId`],
        ["a row method called first", `(m) => m.roles.includes("member") && m.userId === ctx.auth.userId && m.channelId === channelId`],
    ])("accepts a helper guard whose filter requires the identity with &&, %s", (_label, filter) => {
        expect.assertions(1);

        const helper = `const requireMember = async (ctx, channelId) => {
    const row = await ctx.db.query("members").filter(${filter}).first();
    if (!row) {
        throw new Error("FORBIDDEN");
    }
};`;

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, helper));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it.each([
        ["an or of conditions", `(m) => m.userId === ctx.auth.userId || m.channelId === message.channelId`],
        ["an uncompared && value", `(m) => m.userId === (ctx.auth.userId && args.victim) && m.channelId === message.channelId`],
    ])("reports an inline guard whose filter has %s", (_label, filter) => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(`const membership = await ctx.db.query("members").filter(${filter}).first();
    if (!membership) {
        throw new Error("forbidden");
    }`),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each([
        ["an identity && literal as a column value", `userId: ctx.auth.userId && "another-user", channelId: message.channelId`],
        [
            "an identity comparison deciding an unrelated column",
            "ownerId: args.victim, channelId: message.channelId, active: ctx.auth.userId === args.victim && true",
        ],
        ["an identity comparison as a plain column value", "ownerId: args.victim, channelId: message.channelId, active: ctx.auth.userId === args.victim"],
    ])("reports an inline guard whose where holds %s", (_label, where) => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(`const membership = await ctx.db.members.findFirst({ where: { ${where} } });
    if (!membership) {
        throw new Error("forbidden");
    }`),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports an inline guard whose filter compares a column to the identity && a caller negation", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(`const membership = await ctx.db.query("members").filter((m) => m.ownerId === (ctx.auth.userId && !args.skip) && m.channelId === message.channelId).first();
    if (!membership) {
        throw new Error("forbidden");
    }`),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("accepts an inline guard whose filter negates a row field beside the identity", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(`const membership = await ctx.db.query("members").filter((m) => !m.removed && m.userId === ctx.auth.userId && m.channelId === message.channelId).first();
    if (!membership) {
        throw new Error("forbidden");
    }`),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    /** An inline membership guard reading `read`, enforced by the usual `if (!membership)`. */
    const inlineGuard = (read: string): string => `const membership = await ${read};
    if (!membership) {
        throw new Error("forbidden");
    }`;

    it.each([
        ["a !== filter", `ctx.db.query("members").filter((m) => m.userId !== ctx.auth.userId && m.channelId === message.channelId).first()`],
        ["a != filter", `ctx.db.query("members").filter((m) => m.userId != ctx.auth.userId && m.channelId === message.channelId).first()`],
        ["a ne operator", `ctx.db.members.findFirst({ where: { userId: { ne: ctx.auth.userId }, channelId: message.channelId } })`],
        ["a not operator", `ctx.db.members.findFirst({ where: { userId: { not: ctx.auth.userId }, channelId: message.channelId } })`],
        ["a notIn operator", `ctx.db.members.findFirst({ where: { userId: { notIn: [ctx.auth.userId] }, channelId: message.channelId } })`],
        ["a NOT branch", `ctx.db.members.findFirst({ where: { NOT: { userId: ctx.auth.userId }, channelId: message.channelId } })`],
        ["an OR arm", `ctx.db.members.findFirst({ where: { OR: [{ userId: ctx.auth.userId }, { userId: args.victim }], channelId: message.channelId } })`],
        [
            "an in list with another member",
            `ctx.db.members.findFirst({ where: { userId: { in: [ctx.auth.userId, args.victim] }, channelId: message.channelId } })`,
        ],
        [
            "a neq index predicate",
            `ctx.db.query("members").withIndex("by_channel", (q) => q.eq("channelId", message.channelId).neq("userId", ctx.auth.userId)).first()`,
        ],
    ])("reports an inline guard whose identity is excluded or widened by %s", (_label, read) => {
        expect.assertions(1);

        write("chat.ts", teamChat(inlineGuard(read)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each([
        ["an == filter", `ctx.db.query("members").filter((m) => m.userId == ctx.auth.userId && m.channelId === message.channelId).first()`],
        ["an eq operator", `ctx.db.members.findFirst({ where: { userId: { eq: ctx.auth.userId }, channelId: message.channelId } })`],
        ["an in list of only the caller", `ctx.db.members.findFirst({ where: { userId: { in: [ctx.auth.userId] }, channelId: message.channelId } })`],
    ])("accepts an inline guard that matches the caller with %s", (_label, read) => {
        expect.assertions(1);

        write("chat.ts", teamChat(inlineGuard(read)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it.each([
        ["String inside ne", `ctx.db.members.findFirst({ where: { userId: { ne: String(ctx.auth.userId) }, channelId: message.channelId } })`],
        ["String inside a NOT branch", `ctx.db.members.findFirst({ where: { NOT: { userId: String(ctx.auth.userId) }, channelId: message.channelId } })`],
        ["String inside !==", `ctx.db.query("members").filter((m) => m.userId !== String(ctx.auth.userId) && m.channelId === message.channelId).first()`],
        ["Boolean as a bare truthiness check", `ctx.db.query("members").filter((m) => Boolean(ctx.auth.userId) && m.channelId === message.channelId).first()`],
        ["Boolean as an eq value", `ctx.db.members.findFirst({ where: { userId: { eq: Boolean(ctx.auth.userId) }, channelId: message.channelId } })`],
        ["a helper call as a column value", `ctx.db.members.findFirst({ where: { userId: mask(ctx.auth.userId), channelId: message.channelId } })`],
    ])("reports an inline guard whose identity is wrapped in %s", (_label, read) => {
        expect.assertions(1);

        write("chat.ts", teamChat(inlineGuard(read)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each([
        ["an eq value", `ctx.db.members.findFirst({ where: { userId: { eq: String(ctx.auth.userId) }, channelId: message.channelId } })`],
        ["a column value", `ctx.db.members.findFirst({ where: { userId: String(ctx.auth.userId), channelId: message.channelId } })`],
        ["an === filter", `ctx.db.query("members").filter((m) => m.userId === String(ctx.auth.userId) && m.channelId === message.channelId).first()`],
    ])("accepts an inline guard whose identity is wrapped in String as %s", (_label, read) => {
        expect.assertions(1);

        write("chat.ts", teamChat(inlineGuard(read)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it.each([
        ["a Boolean login check", `ctx.db.query("members").filter((m) => Boolean(ctx.auth.userId) && m.channelId === message.channelId).first()`],
        ["a not operator around String", `ctx.db.members.findFirst({ where: { userId: { not: String(ctx.auth.userId) }, channelId: message.channelId } })`],
    ])("reports an inline guard that only checks login through %s", (_label, read) => {
        expect.assertions(1);

        write("chat.ts", teamChat(inlineGuard(read)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each([
        ["an args value", `(m) => ctx.auth.userId === args.victim && m.channelId === message.channelId`],
        ["a literal", `(m) => ctx.auth.userId === "user_1" && m.channelId === message.channelId`],
        ["another identity", `(m) => ctx.auth.userId === ctx.auth.userId && m.channelId === message.channelId`],
    ])("reports an inline guard whose filter compares the identity to %s instead of a row field", (_label, filter) => {
        expect.assertions(1);

        write("chat.ts", teamChat(inlineGuard(`ctx.db.query("members").filter(${filter}).first()`)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each([
        ["row field first", `(m) => m.userId === ctx.auth.userId && m.channelId === message.channelId`],
        ["identity first", `(m) => ctx.auth.userId === m.userId && m.channelId === message.channelId`],
    ])("accepts an inline guard whose filter compares the identity to a row field, %s", (_label, filter) => {
        expect.assertions(1);

        write("chat.ts", teamChat(inlineGuard(`ctx.db.query("members").filter(${filter}).first()`)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it.each([
        ["a NOT branch", "where: { NOT: filter, channelId: message.channelId }"],
        ["an OR arm", "where: { OR: [filter, { channelId: args.channelId }], channelId: message.channelId }"],
        ["a spread", "where: { ...filter, channelId: message.channelId }"],
    ])("reports an inline guard whose named filter is used in %s", (_label, query) => {
        expect.assertions(1);

        write("chat.ts", teamChat(`const filter = { userId: ctx.auth.userId };\n    ${inlineGuard(`ctx.db.members.findFirst({ ${query} })`)}`));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("accepts an inline guard whose named filter is an AND branch", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(
                `const filter = { userId: ctx.auth.userId };\n    ${inlineGuard("ctx.db.members.findFirst({ where: { AND: [filter, { channelId: message.channelId }] } })")}`,
            ),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("accepts an inline guard whose in list of only the caller is held in a local", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(
                `const ownerIds = [ctx.auth.userId];\n    ${inlineGuard("ctx.db.members.findFirst({ where: { userId: { in: ownerIds }, channelId: message.channelId } })")}`,
            ),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it.each([
        ["another member", "const ownerIds = [ctx.auth.userId, args.victim];", "in"],
        ["a notIn use", "const ownerIds = [ctx.auth.userId];", "notIn"],
    ])("reports an inline guard whose in list local holds %s", (_label, local, operator) => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(
                `${local}\n    ${inlineGuard(`ctx.db.members.findFirst({ where: { userId: { ${operator}: ownerIds }, channelId: message.channelId } })`)}`,
            ),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a helper guard whose filter excludes a String-wrapped caller with !==", () => {
        expect.assertions(1);

        const helper = `const requireMember = async (ctx, channelId) => {
    const row = await ctx.db.query("members").filter((m) => m.userId !== String(ctx.auth.userId) && m.channelId === channelId).first();
    if (!row) {
        throw new Error("FORBIDDEN");
    }
};`;

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, helper));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a helper guard whose filter excludes the caller with !==", () => {
        expect.assertions(1);

        const helper = `const requireMember = async (ctx, channelId) => {
    const row = await ctx.db.query("members").filter((m) => m.userId !== ctx.auth.userId && m.channelId === channelId).first();
    if (!row) {
        throw new Error("FORBIDDEN");
    }
};`;

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, helper));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each([
        ["a default naming itself", "const { userId = userId } = ctx.auth;", "userId"],
        ["a cycle of defaults", "const { a = b, b = a } = ctx.auth;", "a"],
    ])("reports, without crashing, an inline guard whose identity comes from %s", (_label, binding, name) => {
        expect.assertions(1);

        write("chat.ts", teamChat(`${binding}\n    ${inlineGuard(`ctx.db.members.findFirst({ where: { userId: ${name}, channelId: message.channelId } })`)}`));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each([
        ["a named filter", "const filter = { userId: ctx.auth.userId };\n    mutate({ where: filter });"],
        ["an in list", "const ownerIds = [ctx.auth.userId];\n    mutate({ in: ownerIds });"],
    ])("reports an inline guard whose %s is also handed to another call", (_label, local) => {
        expect.assertions(1);

        const query = local.includes("ownerIds")
            ? "ctx.db.members.findFirst({ where: { userId: { in: ownerIds }, channelId: message.channelId } })"
            : "ctx.db.members.findFirst({ where: { AND: [filter, { channelId: message.channelId }] } })";

        write("chat.ts", teamChat(`${local}\n    ${inlineGuard(query)}`));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each([
        [
            "named filter",
            "const filter = { userId: ctx.auth.userId };",
            "ctx.db.members.findFirst({ where: { AND: [filter, { channelId: message.channelId }] } })",
        ],
        ["in list", "const ownerIds = [ctx.auth.userId];", "ctx.db.members.findFirst({ where: { userId: { in: ownerIds }, channelId: message.channelId } })"],
    ])("accepts an inline guard whose %s goes only to the read", (_label, local, query) => {
        expect.assertions(1);

        write("chat.ts", teamChat(`${local}\n    ${inlineGuard(query)}`));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it.each([
        ["inline", "({ userId, channelId }) => userId === ctx.auth.userId && channelId === message.channelId"],
        ["renamed", "({ userId: owner, channelId }) => ctx.auth.userId === owner && channelId === message.channelId"],
    ])("accepts an inline guard whose filter destructures the row, %s", (_label, filter) => {
        expect.assertions(1);

        write("chat.ts", teamChat(inlineGuard(`ctx.db.query("members").filter(${filter}).first()`)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it.each([
        ["a default", "({ userId = args.victim, channelId }) => userId === ctx.auth.userId && channelId === message.channelId"],
        ["a reassignment", "({ userId, channelId }) => { userId = args.victim; return userId === ctx.auth.userId && channelId === message.channelId; }"],
        ["an args comparison", "({ channelId }) => ctx.auth.userId === args.victim && channelId === message.channelId"],
        ["an args-computed key", "({ [args.field]: value, channelId }) => value === ctx.auth.userId && channelId === message.channelId"],
    ])("reports an inline guard whose destructured filter has %s", (_label, filter) => {
        expect.assertions(1);

        write("chat.ts", teamChat(inlineGuard(`ctx.db.query("members").filter(${filter}).first()`)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each([
        ["a static rename", "({ userId: owner, channelId }) => owner === ctx.auth.userId && channelId === message.channelId"],
        ["a literal computed key", `({ ["userId"]: owner, channelId }) => owner === ctx.auth.userId && channelId === message.channelId`],
    ])("accepts an inline guard whose destructured filter takes the column by %s", (_label, filter) => {
        expect.assertions(1);

        write("chat.ts", teamChat(inlineGuard(`ctx.db.query("members").filter(${filter}).first()`)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it.each([
        ["writes the compared field", "m.userId = ctx.auth.userId;"],
        ["increments the compared field", "m.userId++;"],
        ["deletes the compared field", "delete m.userId;"],
        ["destructures into the compared field", "({ id: m.userId } = { id: ctx.auth.userId });"],
        ["hands the row to a call", "mutate(m);"],
    ])("reports an inline guard whose filter %s before comparing it", (_label, write_) => {
        expect.assertions(1);

        const filter = `(m) => { ${write_} return m.userId === ctx.auth.userId && m.channelId === message.channelId; }`;

        write("chat.ts", teamChat(inlineGuard(`ctx.db.query("members").filter(${filter}).first()`)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("accepts an inline guard whose filter writes only an unrelated row field", () => {
        expect.assertions(1);

        const filter = "(m) => { m.seen = true; return m.userId === ctx.auth.userId && m.channelId === message.channelId; }";

        write("chat.ts", teamChat(inlineGuard(`ctx.db.query("members").filter(${filter}).first()`)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it.each([
        [
            "a local filter with a trailing spread",
            "const filter = { userId: ctx.auth.userId, ...args.where };",
            "where: { AND: [filter, { channelId: message.channelId }] }",
        ],
        ["an inline where with a trailing spread", "", "where: { userId: ctx.auth.userId, channelId: message.channelId, ...args.where }"],
        ["a query spread after its where", "", "where: { userId: ctx.auth.userId, channelId: message.channelId }, ...args.query"],
        ["a duplicate key after the identity", "", "where: { userId: ctx.auth.userId, channelId: message.channelId, userId: args.victim }"],
    ])("reports an inline guard whose identity %s can override", (_label, local, query) => {
        expect.assertions(1);

        write("chat.ts", teamChat(`${local}\n    ${inlineGuard(`ctx.db.members.findFirst({ ${query} })`)}`));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each([
        [
            "a local filter with a leading spread",
            "const filter = { ...args.where, userId: ctx.auth.userId };",
            "where: { AND: [filter, { channelId: message.channelId }] }",
        ],
        ["an inline where with a leading spread", "", "where: { ...args.where, userId: ctx.auth.userId, channelId: message.channelId }"],
    ])("accepts an inline guard whose identity follows %s", (_label, local, query) => {
        expect.assertions(1);

        write("chat.ts", teamChat(`${local}\n    ${inlineGuard(`ctx.db.members.findFirst({ ${query} })`)}`));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it.each([
        [
            "a with relation's where",
            "ctx.db.channels.findFirst({ where: { id: message.channelId }, with: { members: { where: { userId: ctx.auth.userId } } } })",
        ],
        [
            "an include relation's where",
            "ctx.db.channels.findFirst({ where: { id: message.channelId }, include: { members: { where: { userId: { eq: ctx.auth.userId } } } } })",
        ],
        ["a relation filter inside where", "ctx.db.channels.findFirst({ where: { id: message.channelId, members: { userId: ctx.auth.userId } } })"],
        [
            "an in list inside a relation filter",
            "ctx.db.channels.findFirst({ where: { id: message.channelId, members: { userId: { in: [ctx.auth.userId] } } } })",
        ],
    ])("reports an inline guard whose identity only constrains %s", (_label, read) => {
        expect.assertions(1);

        write("chat.ts", teamChat(inlineGuard(read)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each([
        ["a column", "ctx.db.members.findFirst({ where: { userId: ctx.auth.userId, channelId: message.channelId } })"],
        ["an eq operator", "ctx.db.members.findFirst({ where: { userId: { eq: ctx.auth.userId }, channelId: message.channelId } })"],
        ["an AND element", "ctx.db.members.findFirst({ where: { AND: [{ userId: ctx.auth.userId }, { channelId: message.channelId }] } })"],
    ])("accepts an inline guard whose identity is in the read's own where as %s", (_label, read) => {
        expect.assertions(1);

        write("chat.ts", teamChat(inlineGuard(read)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("accepts an inline guard whose named filter holds the identity as a shorthand", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(
                `const userId = ctx.auth.userId;\n    const filter = { userId };\n    ${inlineGuard("ctx.db.members.findFirst({ where: { AND: [filter, { channelId: message.channelId }] } })")}`,
            ),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("reports an inline guard whose named shorthand filter holds a reassigned let", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(
                `let userId = ctx.auth.userId;\n    userId = args.victim;\n    const filter = { userId };\n    ${inlineGuard("ctx.db.members.findFirst({ where: { AND: [filter, { channelId: message.channelId }] } })")}`,
            ),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a helper that rebinds its tied parameter through a type assertion before the read", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(
                "await requireMember(ctx, message.channelId);",
                SINK,
                HELPER.replace("const userId", `(channelId as string) = "general";\n    const userId`),
            ),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports an inline guard whose filter rebinds a destructured row field through a type assertion", () => {
        expect.assertions(1);

        const filter = "({ userId, channelId }) => { (userId as string) = args.victim; return userId === ctx.auth.userId && channelId === message.channelId; }";

        write("chat.ts", teamChat(inlineGuard(`ctx.db.query("members").filter(${filter}).first()`)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a guarded row loosely compared after its valueOf was replaced", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(
                "await requireMember(ctx, message.channelId);\n    message.valueOf = function () {\n        this.attachmentKey = args.key;\n        return 1;\n    };\n    if (message == 1) {\n        void 0;\n    }",
            ),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each(["message === undefined", "message != null", "message == undefined"])("accepts a guarded row tested with %s", (test) => {
        expect.assertions(1);

        write("chat.ts", teamChat(`await requireMember(ctx, message.channelId);\n    if (${test}) {\n        void 0;\n    }`));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it.each([
        ["a comma after an owned read", "const victimId = (await ctx.db.members.findFirst({ where: { userId: ctx.auth.userId } }), args.victimId);"],
        ["a conditional with a caller branch", "const victimId = args.flag ? ctx.auth.userId : args.victimId;"],
        ["a conditional with a role branch", "const victimId = args.useRole ? ctx.auth.role : ctx.auth.userId;"],
        ["a fallback to an organisation id", "const victimId = ctx.auth.orgId ?? ctx.auth.userId;"],
    ])("reports an inline guard whose identity local resolves through %s", (_label, local) => {
        expect.assertions(1);

        write("chat.ts", teamChat(`${local}\n    ${inlineGuard("ctx.db.members.findFirst({ where: { userId: victimId, channelId: message.channelId } })")}`));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("accepts an inline guard whose identity local is the caller's id on every branch", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(
                `const uid = ctx.auth.userId;\n    const owner = args.x ? ctx.auth.userId : uid;\n    ${inlineGuard("ctx.db.members.findFirst({ where: { userId: owner, channelId: message.channelId } })")}`,
            ),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it.each([
        ["an inline role column", inlineGuard("ctx.db.members.findFirst({ where: { userId: ctx.auth.role, channelId: message.channelId } })")],
        [
            "a role in a named filter",
            `const filter = { userId: ctx.auth.role };\n    ${inlineGuard("ctx.db.members.findFirst({ where: { AND: [filter, { channelId: message.channelId }] } })")}`,
        ],
    ])("reports an inline guard that matches the caller's role through %s", (_label, guard) => {
        expect.assertions(1);

        write("chat.ts", teamChat(guard));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a helper guard that matches the caller's role", () => {
        expect.assertions(1);

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, HELPER.replace(`"userId", userId`, `"userId", ctx.auth.role`)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each([
        [
            "an unrelated array's filter inside a where value",
            "",
            "ctx.db.members.findFirst({ where: { userId: args.victim, channelId: (globalThis.unrelated.filter((m) => m.userId === ctx.auth.userId), message.channelId) } })",
        ],
        [
            "an inline predicate handed to another call",
            "",
            "ctx.db.members.findFirst({ where: { userId: args.victim, channelId: message.channelId, active: ignore((m) => m.userId === ctx.auth.userId) } })",
        ],
        [
            "a factored predicate handed to another call",
            "const predicate = (m) => m.userId === ctx.auth.userId;",
            "ctx.db.members.findFirst({ where: { userId: args.victim, channelId: message.channelId, active: ignore(predicate) } })",
        ],
    ])("reports an inline guard whose identity comparison sits in %s", (_label, local, read) => {
        expect.assertions(1);

        write("chat.ts", teamChat(`${local}\n    ${inlineGuard(read)}`));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("accepts a helper guard named context whose in list holds only the caller", () => {
        expect.assertions(1);

        const helper = `const requireMember = async (context, channelId) => {
    const row = await context.db.members.findFirst({ where: { userId: { in: [context.auth.userId] }, channelId } });
    if (!row) {
        throw new Error("FORBIDDEN");
    }
};`;

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, helper));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("accepts a helper guard whose ctx parameter is named context", () => {
        expect.assertions(1);

        const helper = `const requireMember = async (context, channelId) => {
    const row = await context.db.members.findFirst({ where: { userId: context.auth.userId, channelId } });
    if (!row) {
        throw new Error("FORBIDDEN");
    }
};`;

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, helper));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("reports a helper guard whose identity goes to a read rooted elsewhere", () => {
        expect.assertions(1);

        const helper = `const requireMember = async (context, channelId) => {
    const row = await context.db.members.findFirst({ where: { channelId, userId: globalThis.other.db.get(context.auth.userId) } });
    if (!row) {
        throw new Error("FORBIDDEN");
    }
};`;

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, helper));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports an inline guard whose filter repoints its row parameter", () => {
        expect.assertions(1);

        const filter =
            "(m) => { m = { ...m, userId: ctx.auth.userId, channelId: message.channelId }; return m.userId === ctx.auth.userId && m.channelId === message.channelId; }";

        write("chat.ts", teamChat(inlineGuard(`ctx.db.query("members").filter(${filter}).first()`)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    /** A guard read keyed to the row by its index, filtered by a predicate held in a local. */
    const factoredGuard = (predicate: string): string =>
        `const predicate = ${predicate};\n    ${inlineGuard(`ctx.db.query("members").withIndex("by_channel", (q) => q.eq("channelId", message.channelId)).filter(predicate).first()`)}`;

    it("accepts an inline guard whose filter predicate is factored into a local", () => {
        expect.assertions(1);

        write("chat.ts", teamChat(factoredGuard("(m) => m.active && m.userId === ctx.auth.userId")));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it.each([
        ["repoints its row parameter", "(m) => { m = { ...m, userId: ctx.auth.userId }; return m.userId === ctx.auth.userId; }"],
        ["compares to an args value", "(m) => ctx.auth.userId === args.victim && m.active"],
    ])("reports an inline guard whose factored predicate %s", (_label, predicate) => {
        expect.assertions(1);

        write("chat.ts", teamChat(factoredGuard(predicate)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports an inline guard whose factored predicate is also called directly", () => {
        expect.assertions(1);

        write("chat.ts", teamChat(`${factoredGuard("(m) => m.userId === ctx.auth.userId")}\n    void predicate;`));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("accepts an inline guard whose identity default is the identity itself", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(`const { userId = ctx.auth.userId } = ctx.auth;
    const membership = await ctx.db.members.findFirst({ where: { userId, channelId: message.channelId } });
    if (!membership) {
        throw new Error("forbidden");
    }`),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("reports an inline guard whose identity comparison only gates a caller value with &&", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(`const membership = await ctx.db.members.findFirst({ where: { userId: String(ctx.auth.userId === args.guard && args.victim), channelId: message.channelId } });
    if (!membership) {
        throw new Error("forbidden");
    }`),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a helper guard whose identity comparison only gates a caller value with &&", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(
                "await requireMember(ctx, message.channelId, args.guard, args.victim);",
                SINK,
                `const requireMember = async (ctx, channelId, guard, victim) => {
    const row = await ctx.db.members.findFirst({ where: { userId: String(ctx.auth.userId === guard && victim), channelId } });
    if (!row) {
        throw new Error("FORBIDDEN");
    }
};`,
            ),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a guard that runs only inside a loop", () => {
        expect.assertions(1);

        write("chat.ts", teamChat("for (const attempt of [1]) {\n        await requireMember(ctx, message.channelId);\n    }"));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a guard that runs only inside a try with a catch", () => {
        expect.assertions(1);

        write("chat.ts", teamChat("try {\n        await requireMember(ctx, message.channelId);\n    } catch (error) {\n        return null;\n    }"));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a guard that runs after the sink", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(
                "",
                "const url = await ctx.storage.attachments.getSignedUrl(message.attachmentKey, { expiresIn: 60 });\n    await requireMember(ctx, message.channelId);\n    return url;",
            ),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a helper whose read is not bound to the caller's identity", () => {
        expect.assertions(1);

        const helper = `const requireMember = async (ctx, channelId) => {
    const member = await ctx.db.members.findFirst({ where: { userId: args.userId, channelId } });
    if (!member) {
        throw new Error("forbidden");
    }
};`;

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, helper));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a helper that reads with the caller's identity but never throws", () => {
        expect.assertions(1);

        const helper = `const requireMember = async (ctx, channelId) => {
    const member = await ctx.db.members.findFirst({ where: { userId: ctx.auth.userId, channelId } });
    return member !== null;
};`;

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, helper));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a helper reached only through another helper", () => {
        expect.assertions(1);

        const helper = `const checkMembership = async (ctx, channelId) => {
    const member = await ctx.db.members.findFirst({ where: { userId: ctx.auth.userId, channelId } });
    if (!member) {
        throw new Error("forbidden");
    }
};
const requireMember = async (ctx, channelId) => {
    await checkMembership(ctx, channelId);
};`;

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, helper));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a non-awaited async helper guard", () => {
        expect.assertions(1);

        write("chat.ts", teamChat("requireMember(ctx, message.channelId);"));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a helper whose ctx parameter is destructured", () => {
        expect.assertions(1);

        const helper = `const requireMember = async ({ db, auth }, channelId) => {
    const member = await db.members.findFirst({ where: { userId: auth.userId, channelId } });
    if (!member) {
        throw new Error("forbidden");
    }
};`;

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, helper));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });
    it("accepts a helper that enforces its single-row read with an OrThrow variant", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(
                "await requireMember(ctx, message.channelId);",
                SINK,
                `const requireMember = async (ctx, channelId) => {
    const userId = ctx.auth.userId;
    const row = await ctx.db.members.findFirstOrThrow({ where: { userId, channelId } });
};`,
            ),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("reports a helper whose throw does not follow from the identity read", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(
                "await requireMember(ctx, message.channelId);",
                SINK,
                `const requireMember = async (ctx, channelId) => {
    const userId = ctx.auth.userId;
    const row = await ctx.db.query("members").withIndex("by_channel_user", (q) => q.eq("channelId", channelId).eq("userId", userId)).first();
    if (!channelId) {
        throw new Error("FORBIDDEN");
    }
};`,
            ),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a helper whose identity read ignores the row parameter", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(
                "await requireMember(ctx, message.channelId);",
                SINK,
                `const requireMember = async (ctx, channelId) => {
    const userId = ctx.auth.userId;
    const row = await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", userId)).first();
    if (!row) {
        throw new Error("FORBIDDEN");
    }
};`,
            ),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports an inline guard that reads with findMany", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(`const membership = await ctx.db.members.findMany({ where: { userId: ctx.auth.userId, channelId: message.channelId } });
    if (!membership) {
        throw new Error("forbidden");
    }`),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each([
        ["a tied parameter", `channelId = "general";`],
        ["the ctx parameter", "ctx = globalThis.adminContext;"],
    ])("reports a helper that reassigns %s before its identity read", (_label, reassignment) => {
        expect.assertions(1);

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, HELPER.replace("const userId", `${reassignment}\n    const userId`)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each([
        ["a tied parameter", `channelId = "general";`],
        ["the ctx parameter", "ctx = globalThis.adminContext;"],
    ])("accepts a helper that reassigns %s only after its enforcing read", (_label, reassignment) => {
        expect.assertions(1);

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, HELPER.replace(/\n\};$/u, `\n    ${reassignment}\n};`)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("reports a helper that reassigns ctx inside a loop that also holds its read", () => {
        expect.assertions(1);

        const helper = `const requireMember = async (ctx, channelId) => {
    for (const attempt of [1, 2]) {
        const row = await ctx.db.members.findFirst({ where: { userId: ctx.auth.userId, channelId } });
        if (!row) {
            throw new Error("FORBIDDEN");
        }
        ctx = globalThis.adminContext;
    }
};`;

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, helper));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a helper whose tied parameter has a default", () => {
        expect.assertions(1);

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, HELPER.replace("(ctx, channelId)", `(ctx, channelId = "general")`)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each([
        ["a destructuring assignment", "({ key: message.attachmentKey } = args);"],
        ["a write through an alias", "const alias = message;\n    alias.attachmentKey = args.key;"],
        ["Object.assign", "Object.assign(message, args);"],
        ["a call handed the row", "mutate(message, args);"],
        ["a method on the row", "message.merge(args);"],
        ["a computed write", "message[args.field] = args.key;"],
    ])("reports a guarded row that %s can change before the sink", (_label, mutation) => {
        expect.assertions(1);

        write("chat.ts", teamChat(`await requireMember(ctx, message.channelId);\n    ${mutation}`));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a row whose field the helper guard reads is written from args first", () => {
        expect.assertions(1);

        write("chat.ts", teamChat("message.channelId = args.channelId;\n    await requireMember(ctx, message.channelId);"));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a row whose field the inline guard reads is written from args first", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(`message.channelId = args.channelId;
    const membership = await ctx.db.members.findFirst({ where: { userId: ctx.auth.userId, channelId: message.channelId } });
    if (!membership) {
        throw new Error("forbidden");
    }`),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each([
        ["a destructuring read", "const { title } = message;\n    void title;"],
        ["an early return", "if (args.preview) {\n        return message;\n    }"],
    ])("accepts a guarded row also used by %s", (_label, use) => {
        expect.assertions(1);

        write("chat.ts", teamChat(`await requireMember(ctx, message.channelId);\n    ${use}`));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    /** A helper guard handed the whole row; `extra` runs in its body after the membership check. */
    const rowHelper = (extra: string): string => `const requireMember = async (ctx, message) => {
    const userId = ctx.auth.userId;
    const row = await ctx.db.query("members").withIndex("by_channel_user", (q) => q.eq("channelId", message.channelId).eq("userId", userId)).first();
    if (!row) {
        throw new Error("FORBIDDEN");
    }
    ${extra}
};`;

    it("accepts a helper guard handed the row that writes an unrelated field", () => {
        expect.assertions(1);

        write("chat.ts", teamChat("await requireMember(ctx, message);", SINK, rowHelper("message.views += 1;")));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("reports a helper guard handed the row that writes the field it checks", () => {
        expect.assertions(1);

        write("chat.ts", teamChat("await requireMember(ctx, message);", SINK, rowHelper(`message.channelId = "general";`)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    /** A second guard helper handed the whole row, checking the caller's membership of the row's team. */
    const OWNER_HELPER = `const assertOwner = async (ctx, message) => {
    const owner = await ctx.db.owners.findFirst({ where: { userId: ctx.auth.userId, teamId: message.teamId } });
    if (!owner) {
        throw new Error("FORBIDDEN");
    }
};`;

    it("accepts two stacked guard helpers that are each handed the row", () => {
        expect.assertions(1);

        write("chat.ts", teamChat("await requireMember(ctx, message);\n    await assertOwner(ctx, message);", SINK, `${rowHelper("")}\n${OWNER_HELPER}`));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("reports a guard helper beside a non-guard call that writes the row", () => {
        expect.assertions(1);

        const audit = `const audit = async (ctx, message) => {
    message.attachmentKey = ctx.auth.userId;
};`;

        write("chat.ts", teamChat("await requireMember(ctx, message);\n    await audit(ctx, message);", SINK, `${rowHelper("")}\n${audit}`));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("accepts the whole row handed to a helper guard that only reads it", () => {
        expect.assertions(1);

        write("chat.ts", teamChat("await requireMember(ctx, message);", SINK, rowHelper("")));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it.each([
        ["writes into it", "message.attachmentKey = ctx.auth.userId;"],
        ["hands it on", "audit(message);"],
        ["calls a method on it", "message.touch();"],
    ])("reports the whole row handed to a helper guard that %s", (_label, extra) => {
        expect.assertions(1);

        write("chat.ts", teamChat("await requireMember(ctx, message);", SINK, rowHelper(extra)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    const NESTED_SINK = "return ctx.storage.attachments.getSignedUrl(message.meta.key, { expiresIn: 60 });";

    it.each([
        ["Object.assign on a nested holder", "Object.assign(message.meta, { key: ctx.auth.userId });"],
        ["a call handed a nested holder", "mutate(message.meta);"],
        ["a write through an alias of a nested holder", "const m = message.meta;\n    m.key = ctx.auth.userId;"],
        ["a method on a nested holder", "message.meta.reset();"],
    ])("reports a helper guard handed the row that changes the nested key through %s", (_label, extra) => {
        expect.assertions(1);

        write("chat.ts", teamChat("await requireMember(ctx, message);", NESTED_SINK, rowHelper(extra)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a helper guard handed the nested holder that rewrites the key", () => {
        expect.assertions(1);

        const helper = `const requireMember = async (ctx, channelId, meta) => {
    const userId = ctx.auth.userId;
    const row = await ctx.db.query("members").withIndex("by_channel_user", (q) => q.eq("channelId", channelId).eq("userId", userId)).first();
    if (!row) {
        throw new Error("FORBIDDEN");
    }
    Object.assign(meta, { key: userId });
};`;

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId, message.meta);", NESTED_SINK, helper));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    /** A helper guard handed the whole row and a caller value; `before` runs ahead of its membership read on `field`. */
    const suppliedHelper = (before: string, field: string): string => `const requireMember = async (ctx, message, supplied) => {
    ${before}
    const row = await ctx.db.members.findFirst({ where: { userId: ctx.auth.userId, channelId: ${field} } });
    if (!row) {
        throw new Error("FORBIDDEN");
    }
};`;

    it.each([
        ["Object.assign on the field's holder", "Object.assign(message.channel, { id: supplied });", "message.channel.id"],
        ["a write through a const alias of the field's holder", "const meta = message.meta;\n    meta.channelId = supplied;", "message.meta.channelId"],
    ])("reports a helper guard that replaces the field it checks through %s", (_label, before, field) => {
        expect.assertions(1);

        write("chat.ts", teamChat("await requireMember(ctx, message, args.channelId);", SINK, suppliedHelper(before, field)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each([
        ["a destructured parameter", "(ctx, channelId, { meta })", "meta.key = channelId;"],
        ["a rest parameter", "(ctx, channelId, ...rest)", "rest[0].meta.key = channelId;"],
    ])("reports a helper guard that receives the row in %s", (_label, parameters, rewrite) => {
        expect.assertions(1);

        const helper = `const requireMember = async ${parameters} => {
    const row = await ctx.db.members.findFirst({ where: { userId: ctx.auth.userId, channelId } });
    if (!row) {
        throw new Error("FORBIDDEN");
    }
    ${rewrite}
};`;

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId, message);", NESTED_SINK, helper));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a row whose field an inline guard compares is written from args first", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(`message.channelId = args.channelId;
    const membership = await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", ctx.auth.userId)).filter((m) => m.channelId === message.channelId).first();
    if (!membership) {
        throw new Error("forbidden");
    }`),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a row whose field a helper guard compares is written from args first", () => {
        expect.assertions(1);

        const helper = `const requireMember = async (ctx, message) => {
    const row = await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", ctx.auth.userId)).filter((m) => m.channelId === message.channelId).first();
    if (!row) {
        throw new Error("FORBIDDEN");
    }
};`;

        write("chat.ts", teamChat("message.channelId = args.channelId;\n    await requireMember(ctx, message);", SINK, helper));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("accepts a later guard whose values survive when an earlier one's do not", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(`const team = await ctx.db.members.findFirstOrThrow({ where: { userId: ctx.auth.userId, teamId: message.teamId } });
    message.teamId = args.teamId;
    await requireMember(ctx, message.channelId);`),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("reports a row handed out by a nested function's return", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(
                "await requireMember(ctx, message.channelId);\n    const expose = () => {\n        return message;\n    };\n    expose().attachmentKey = args.key;",
            ),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a row handed out by a helper guard's nested function", () => {
        expect.assertions(1);

        write("chat.ts", teamChat("await requireMember(ctx, message);", SINK, rowHelper("globalThis.later = () => {\n        return message;\n    };")));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("accepts a row edited only after the sink has read its key", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(
                "await requireMember(ctx, message.channelId);",
                "const url = await ctx.storage.attachments.getSignedUrl(message.attachmentKey, { expiresIn: 60 });\n    message.attachmentKey = args.key;\n    return url;",
            ),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("reports a later edit inside a loop that runs the sink again", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(
                "await requireMember(ctx, message.channelId);",
                "for (const key of args.keys) {\n        await ctx.storage.attachments.getSignedUrl(message.attachmentKey, { expiresIn: 60 });\n        message.attachmentKey = key;\n    }",
            ),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each([
        ["a string fallback", `"userId", ctx.auth.userId ?? "anon"`, ""],
        ["an empty-string or", `"userId", userId || ""`, ""],
        ["a module constant", `"userId", ctx.auth.userId ?? ANONYMOUS`, `const ANONYMOUS = "anon";\n`],
    ])("accepts a helper whose identity read has %s", (_label, predicate, prelude) => {
        expect.assertions(1);

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, prelude + HELPER.replace(`"userId", userId`, predicate)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("accepts an inline guard whose identity has a fixed fallback", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(`const membership = await ctx.db.members.findFirst({ where: { userId: ctx.auth.userId ?? "anon", channelId: message.channelId } });
    if (!membership) {
        throw new Error("forbidden");
    }`),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it.each([
        ["destructures a field of a nested holder", "const { label } = message.meta;\n    void label;"],
        ["reads the nested key", "void message.meta.key.length;"],
    ])("accepts a helper guard handed the row that only %s", (_label, extra) => {
        expect.assertions(1);

        write("chat.ts", teamChat("await requireMember(ctx, message);", NESTED_SINK, rowHelper(extra)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it.each([
        ["a spread copy", "const copy = { ...message };\n    copy.meta.storageKey = args.key;"],
        ["a destructured holder", "const { meta } = message;\n    meta.storageKey = args.key;"],
    ])("reports a nested key shared through %s", (_label, copy) => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(
                `await requireMember(ctx, message.channelId);\n    ${copy}`,
                "return ctx.storage.attachments.getSignedUrl(message.meta.storageKey, { expiresIn: 60 });",
            ),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("accepts a nested key whose holder is never copied", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(
                "await requireMember(ctx, message.channelId);",
                "return ctx.storage.attachments.getSignedUrl(message.meta.storageKey, { expiresIn: 60 });",
            ),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("accepts a guarded row whose unrelated fields are read or written", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(
                "await requireMember(ctx, message.channelId);\n    message.views = (message.views ?? 0) + 1;\n    const copy = { ...message };\n    void copy.tags.includes(args.tag);",
            ),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("reports an inline guard whose identity is destructured with a caller default", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(`const { userId = args.victim } = ctx.auth;
    const membership = await ctx.db.members.findFirst({ where: { userId, channelId: message.channelId } });
    if (!membership) {
        throw new Error("forbidden");
    }`),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each(["membership === null", "null === membership", "membership == undefined"])("accepts an inline guard checked with %s", (condition) => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(`const membership = await ctx.db.members.findFirst({ where: { userId: ctx.auth.userId, channelId: message.channelId } });
    if (${condition}) {
        throw new Error("forbidden");
    }`),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it.each([
        ["a fallback", `"userId", globalThis.victim ?? ctx.auth.userId`],
        ["the left of a fallback", `"userId", ctx.auth.userId ?? globalThis.victim`],
        ["the left of an or", `"userId", userId || globalThis.victim`],
        ["a conditional", `"userId", ctx.auth.userId ? globalThis.victim : userId`],
    ])("reports a helper whose identity read sits in %s", (_label, predicate) => {
        expect.assertions(1);

        write("chat.ts", teamChat("await requireMember(ctx, message.channelId);", SINK, HELPER.replace(`"userId", userId`, predicate)));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it.each([
        ["a local", "const uid = args.victim ?? ctx.auth.userId;", "uid"],
        ["a destructured identity", "const { userId } = ctx.auth;", "args.victim ?? userId"],
        ["an identity with a caller fallback", "const uid = ctx.auth.userId;", "uid ?? args.victim"],
    ])("reports an inline guard whose identity alias through %s only falls back to the caller", (_label, alias, value) => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(`${alias}
    const membership = await ctx.db.members.findFirst({ where: { userId: ${value}, channelId: message.channelId } });
    if (!membership) {
        throw new Error("forbidden");
    }`),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports an inline guard checked with === undefined", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(`const membership = await ctx.db.members.findFirst({ where: { userId: ctx.auth.userId, channelId: message.channelId } });
    if (membership === undefined) {
        throw new Error("forbidden");
    }`),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a guard and sink that both sit inside a loop", () => {
        expect.assertions(1);

        write("chat.ts", teamChat(`for (const attempt of [1]) {\n        await requireMember(ctx, message.channelId);\n        ${SINK}\n    }`, ""));

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("reports a guard and sink that both sit in the finally block of a try with a catch", () => {
        expect.assertions(1);

        write(
            "chat.ts",
            teamChat(
                `try {\n        await Promise.resolve();\n    } catch (error) {\n        return null;\n    } finally {\n        await requireMember(ctx, message.channelId);\n        ${SINK}\n    }`,
                "",
            ),
        );

        expect(discoverStorageKeyAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });
});
