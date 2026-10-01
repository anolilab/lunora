import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ArchitectureManifest } from "../../../shared/architecture-manifest";
import { runCodegen } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixtures", "simple");

let workdir: string;

const write = (relative: string, source: string): void => {
    const path = join(workdir, "lunora", relative);

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source, "utf8");
};

const generated = (name: string): string => join(workdir, "lunora", "_generated", name);

const manifest = (): ArchitectureManifest => JSON.parse(readFileSync(generated("architecture.json"), "utf8")) as ArchitectureManifest;

/** Two modules: `chat` (owns `messages`) calls into `accounts` (owns `users`), which writes `messages` across the boundary. */
const writeModules = (): void => {
    write(
        "chat/module.ts",
        `import { defineModule } from "@lunora/server";

export default defineModule({ description: "Channels and messages", tables: ["messages"] });
`,
    );
    write(
        "chat/posts.ts",
        `import { mutation, query, v } from "@lunora/server";
import { api, internal } from "../_generated/api";

export const feed = query({
    args: {},
    handler: async (ctx) => ctx.db.query("messages").collect(),
});

export const post = mutation({
    args: { text: v.string() },
    handler: async (ctx, args) => {
        await ctx.runQuery(api.accounts_users.me, {});
        await ctx.scheduler.runAfter(1000, internal.accounts_users.touch, {});
        await ctx.topics.posted.publish({ text: args.text });
        const target = api.accounts_users.me;
        await ctx.runQuery(target, {});
        return ctx.db.insert("messages", { channelId: "c", text: args.text });
    },
});
`,
    );
    write(
        "accounts/module.ts",
        `import { defineModule } from "@lunora/server";

export default defineModule({ tables: ["users"] });
`,
    );
    write(
        "accounts/users.ts",
        `import { internalMutation, query } from "@lunora/server";

export const me = query({ args: {}, handler: async (ctx) => ctx.db.query("users").first() });

export const touch = internalMutation({
    args: {},
    handler: async (ctx) => {
        await ctx.db.insert("messages", { channelId: "c", text: "seen" });
    },
});
`,
    );
    write(
        "queues.ts",
        `import { defineSubscription, defineTopic } from "@lunora/queue";

export const posted = defineTopic<{ text: string }>();
export const indexPost = defineSubscription(posted, { handler: async () => {} });
`,
    );
};

describe("architecture manifest", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-architecture-"));
        cpSync(join(fixtureRoot, "lunora"), join(workdir, "lunora"), { recursive: true });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("emits nothing for an app that declares no module", () => {
        expect.assertions(3);

        runCodegen({ projectRoot: workdir });

        expect(existsSync(generated("architecture.json"))).toBe(false);
        expect(existsSync(generated("architecture.ts"))).toBe(false);
        expect(readFileSync(generated("app.ts"), "utf8")).not.toContain(`import { architecture } from "./architecture.js";`);
    });

    it("groups nodes by module and draws every edge kind it can read", () => {
        expect.assertions(4);

        writeModules();
        runCodegen({ projectRoot: workdir });

        const { edges, nodes, modules } = manifest();

        expect(modules).toStrictEqual([
            { name: "accounts", tables: ["users"] },
            { description: "Channels and messages", name: "chat", tables: ["messages"] },
        ]);
        expect(nodes.filter((node) => node.module === "chat").map((node) => node.id)).toStrictEqual([
            "function:chat_posts:feed",
            "function:chat_posts:post",
            "table:messages",
        ]);
        expect(edges).toStrictEqual(
            expect.arrayContaining([
                { from: "function:chat_posts:feed", kind: "read", to: "table:messages" },
                { from: "function:chat_posts:post", kind: "call", to: "function:accounts_users:me" },
                { from: "function:chat_posts:post", kind: "schedule", to: "function:accounts_users:touch" },
                { from: "function:chat_posts:post", kind: "publish", to: "topic:posted" },
                { from: "function:chat_posts:post", kind: "write", to: "table:messages" },
                { from: "function:accounts_users:touch", kind: "write", to: "table:messages" },
                { from: "topic:posted", kind: "subscribe", to: "queue:indexPost" },
            ]),
        );
        expect(manifest().unresolved).toContainEqual(
            expect.objectContaining({ file: "chat/posts", kind: "call", reason: expect.stringContaining("not a static") }),
        );
    });

    it("wires the manifest into the worker and tags OpenAPI operations by module", () => {
        expect.assertions(3);

        writeModules();
        runCodegen({ projectRoot: workdir });

        const app = readFileSync(generated("app.ts"), "utf8");
        const openApi = JSON.parse(readFileSync(generated("openapi.json"), "utf8")) as {
            paths: Record<string, { post?: { tags: string[] } }>;
            tags: { description: string; name: string }[];
        };

        expect(app).toContain(`import { architecture } from "./architecture.js";`);
        expect(openApi.paths["/_lunora/rpc#chat_posts:feed"]?.post?.tags).toStrictEqual(["chat"]);
        expect(openApi.tags).toContainEqual({ description: "Channels and messages", name: "chat" });
    });

    it("reports a write into another module's table", () => {
        expect.assertions(1);

        writeModules();

        const result = runCodegen({ projectRoot: workdir });

        expect(result.advisories.filter((finding) => finding.name === "cross_module_table_write").map((finding) => finding.metadata)).toStrictEqual([
            { exportName: "touch", file: "accounts/users", owner: "chat", table: "messages", writer: "accounts" },
        ]);
    });

    it("rejects a nested module", () => {
        expect.assertions(1);

        write("chat/module.ts", `import { defineModule } from "@lunora/server";\nexport default defineModule({});\n`);
        write("chat/threads/module.ts", `import { defineModule } from "@lunora/server";\nexport default defineModule({});\n`);

        expect(() => runCodegen({ projectRoot: workdir })).toThrow(/"chat\/threads" is nested inside module "chat"/u);
    });

    it("rejects a table claimed by two modules", () => {
        expect.assertions(1);

        write("chat/module.ts", `import { defineModule } from "@lunora/server";\nexport default defineModule({ tables: ["users"] });\n`);
        write("accounts/module.ts", `import { defineModule } from "@lunora/server";\nexport default defineModule({ tables: ["users"] });\n`);

        expect(() => runCodegen({ projectRoot: workdir })).toThrow(/"users" is claimed by both/u);
    });

    it("rejects a claim on a table the schema does not define", () => {
        expect.assertions(1);

        write("accounts/module.ts", `import { defineModule } from "@lunora/server";\nexport default defineModule({ tables: ["nope"] });\n`);

        expect(() => runCodegen({ projectRoot: workdir })).toThrow(/declares table "nope"/u);
    });

    it("rejects a shorthand table list instead of dropping the ownership", () => {
        expect.assertions(1);

        write("accounts/module.ts", `import { defineModule } from "@lunora/server";\nconst tables = ["users"];\nexport default defineModule({ tables });\n`);

        expect(() => runCodegen({ projectRoot: workdir })).toThrow(/write `tables` inline/u);
    });

    it("attributes calls inside export default, and reports a call inside a helper", () => {
        expect.assertions(2);

        write("chat/module.ts", `import { defineModule } from "@lunora/server";\nexport default defineModule({});\n`);
        write(
            "chat/feed.ts",
            `import { query } from "@lunora/server";

const loadAll = (ctx: { db: { query: (table: string) => { collect: () => unknown } } }) => ctx.db.query("messages").collect();

export default query({ args: {}, handler: async (ctx) => ctx.db.query("users").collect() });

export const viaHelper = query({ args: {}, handler: async (ctx) => loadAll(ctx) });
`,
        );
        runCodegen({ projectRoot: workdir });

        expect(manifest().edges).toContainEqual({ from: "function:chat_feed:default", kind: "read", to: "table:users" });
        expect(manifest().unresolved).toContainEqual(expect.objectContaining({ file: "chat/feed", kind: "read", reason: "inside a non-exported helper" }));
    });

    it("treats an installed component as a module: its own lane, and a warning for app code writing its table", () => {
        expect.assertions(4);

        write(
            "schema.ts",
            `import { defineSchema, defineSchemaExtension, defineTable, v } from "@lunora/server";

export default defineSchema({ posts: defineTable({ title: v.string() }) }).extend(
    defineSchemaExtension("voting", { tables: { votes: defineTable({ subject: v.string() }) } }),
);
`,
        );
        write("content/module.ts", `import { defineModule } from "@lunora/server";\nexport default defineModule({ tables: ["posts"] });\n`);
        write(
            "content/posts.ts",
            `import { mutation, v } from "@lunora/server";

export const upvote = mutation({ args: { subject: v.string() }, handler: async (ctx, args) => ctx.db.insert("voting_votes", args) });
`,
        );
        // Copy-in component code (a registry item) lives in lunora/<key>/ and may write its own tables.
        write(
            "voting/cast.ts",
            `import { mutation, v } from "@lunora/server";

export const cast = mutation({ args: { subject: v.string() }, handler: async (ctx, args) => ctx.db.insert("voting_votes", args) });
`,
        );

        const result = runCodegen({ projectRoot: workdir });
        const { modules, nodes } = manifest();

        expect(modules).toContainEqual({ installed: true, name: "voting", tables: ["voting_votes"] });
        expect(nodes.find((node) => node.id === "table:voting_votes")?.module).toBe("voting");
        expect(nodes.find((node) => node.id === "function:voting_cast:cast")?.module).toBe("voting");
        expect(result.advisories.filter((finding) => finding.name === "cross_module_table_write").map((finding) => finding.metadata["file"])).toStrictEqual([
            "content/posts",
        ]);
    });
});
