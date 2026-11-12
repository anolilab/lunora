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

    it("accepts a helper guard imported from a second file", () => {
        expect.assertions(1);

        write("guards.ts", HELPER.replace("const requireMember", "export const requireMember"));
        write("chat.ts", `import { requireMember } from "./guards";\n${teamChat("await requireMember(ctx, message.channelId);", SINK, "")}`);

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
