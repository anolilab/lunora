import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ArchitectureManifest } from "../../../shared/architecture-manifest";
import { runCodegen } from "../src/index";
import { markerLine } from "./call-site-fixture";

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
        await ctx.queues.jobs.send({});
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
        `import { defineQueue, defineSubscription, defineTopic } from "@lunora/queue";

export const posted = defineTopic<{ text: string }>();
export const indexPost = defineSubscription(posted, { handler: async () => {} });
export const jobs = defineQueue({ handler: async () => {} });
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

    it("groups nodes by module and draws call, schedule, read, write, enqueue, publish and subscribe edges", () => {
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
                { from: "function:chat_posts:post", kind: "enqueue", to: "queue:jobs" },
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

    it("attributes calls inside export default and inside a helper, and reports a helper no export calls", () => {
        expect.assertions(3);

        const feed = `import { query } from "@lunora/server";

type Db = { db: { query: (table: string) => { collect: () => unknown } } };

const loadAll = (ctx: Db) => ctx.db.query("messages").collect();
const loadUnused = (ctx: Db) => ctx.db.query("users").collect(); // @unused

export default query({ args: {}, handler: async (ctx) => ctx.db.query("users").collect() });

export const viaHelper = query({ args: {}, handler: async (ctx) => loadAll(ctx) });
`;

        write("chat/module.ts", `import { defineModule } from "@lunora/server";\nexport default defineModule({});\n`);
        write("chat/feed.ts", feed);
        runCodegen({ projectRoot: workdir });

        expect(manifest().edges).toContainEqual({ from: "function:chat_feed:default", kind: "read", to: "table:users" });
        expect(manifest().edges).toContainEqual({ from: "function:chat_feed:viaHelper", kind: "read", to: "table:messages" });
        expect(manifest().unresolved).toContainEqual({
            file: "chat/feed",
            kind: "read",
            line: markerLine(feed, "unused"),
            reason: "inside a non-exported helper",
        });
    });

    /** The issue #951 repro: `accounts` writes `billing`'s `invoices` directly, through helpers, transitively, through a cycle, and from an orphan helper. */
    const SIGNUP = `import { mutation } from "@lunora/server";

type Id<T extends string> = string & { readonly __table: T };
interface MutationCtx {
    db: {
        delete: <T extends string>(id: Id<T>) => Promise<void>;
        insert: (table: "invoices", document: object) => Promise<Id<"invoices">>;
        patch: <T extends string>(id: Id<T>, patch: object) => Promise<void>;
    };
}

export const signupDirect = mutation.input({}).mutation(async ({ ctx }) => {
    await ctx.db.insert("invoices", { amount: 0 });
});

const openInvoice = async (ctx: MutationCtx) => ctx.db.insert("invoices", { amount: 0 });
const touchInvoice = async (ctx: MutationCtx, id: Id<"invoices">) => ctx.db.patch(id, { amount: 1 });

export const signupViaHelper = mutation.input({}).mutation(async ({ ctx }) => {
    const id = await openInvoice(ctx);
    await touchInvoice(ctx, id);
});

const settle = async (ctx: MutationCtx) => touchInvoice(ctx, await openInvoice(ctx));

export const signupTransitive = mutation.input({}).mutation(async ({ ctx }) => settle(ctx));

const ping = async (ctx: MutationCtx, n: number): Promise<void> => (n > 0 ? pong(ctx, n - 1) : undefined);
async function pong(ctx: MutationCtx, n: number): Promise<void> {
    await ctx.db.insert("invoices", { amount: n });
    await ping(ctx, n);
}

export const signupCycle = mutation.input({}).mutation(async ({ ctx }) => ping(ctx, 2));

const voidInvoice = async (ctx: MutationCtx, id: Id<"invoices">) => ctx.db.delete(id); // @orphan
`;

    const writeHelperWrites = (): void => {
        write(
            "schema.ts",
            `import { defineSchema, defineTable, v } from "@lunora/server";

export default defineSchema({ invoices: defineTable({ amount: v.number() }) });
`,
        );
        write("billing/module.ts", `import { defineModule } from "@lunora/server";\nexport default defineModule({ tables: ["invoices"] });\n`);
        write("accounts/module.ts", `import { defineModule } from "@lunora/server";\nexport default defineModule({});\n`);
        write("accounts/signup.ts", SIGNUP);
    };

    it("draws writes made through same-file helpers as the exported caller's, and lists an orphan helper's write", () => {
        expect.assertions(2);

        writeHelperWrites();
        runCodegen({ projectRoot: workdir });

        const writes = manifest().edges.filter((edge) => edge.kind === "write");

        expect(writes).toStrictEqual(
            ["signupCycle", "signupDirect", "signupTransitive", "signupViaHelper"].map((name) => {
                return { from: `function:accounts_signup:${name}`, kind: "write", to: "table:invoices" };
            }),
        );
        expect(manifest().unresolved).toStrictEqual([
            { file: "accounts/signup", kind: "write", line: markerLine(SIGNUP, "orphan"), reason: "inside a non-exported helper" },
        ]);
    });

    it("flags a cross-module write once per export or helper, naming a helper's callers, including a helper no export calls", () => {
        expect.assertions(1);

        writeHelperWrites();

        const result = runCodegen({ projectRoot: workdir });
        const signup = { file: "accounts/signup", owner: "billing", table: "invoices", writer: "accounts" };

        expect(
            result.advisories
                .filter((finding) => finding.name === "cross_module_table_write")
                .map((finding) => finding.metadata)
                .toSorted((a, b) => String(a["helper"] ?? a["exportName"]).localeCompare(String(b["helper"] ?? b["exportName"]))),
        ).toStrictEqual([
            { ...signup, callers: ["signupTransitive", "signupViaHelper"], helper: "openInvoice" },
            { ...signup, callers: ["signupCycle"], helper: "pong" },
            { ...signup, exportName: "signupDirect" },
            { ...signup, callers: ["signupTransitive", "signupViaHelper"], helper: "touchInvoice" },
            { ...signup, callers: [], helper: "voidInvoice" },
        ]);
    });

    it("draws the call sites of a workflow or queue handler imported from another file as that workflow's or queue's", () => {
        expect.assertions(3);

        writeModules();
        write(
            "onboarding/flow.ts",
            `import { api } from "../_generated/api";

export const onboard = async (ctx) => {
    await ctx.step.do("greet", () => undefined);
    await ctx.runQuery(api.accounts_users.me, {});
};
`,
        );
        write(
            "workflows.ts",
            `import { defineWorkflow } from "@lunora/workflow";
import { onboard } from "./onboarding/flow";

export const onboarding = defineWorkflow({ handler: onboard });
`,
        );
        write(
            "jobs/process.ts",
            `import { internal } from "../_generated/api";

export async function processJob(message, ctx) {
    await ctx.runMutation(internal.accounts_users.touch, {});
}
`,
        );
        write(
            "queues.ts",
            `import { defineQueue, defineSubscription, defineTopic } from "@lunora/queue";
import { processJob } from "./jobs/process";

export const posted = defineTopic<{ text: string }>();
export const indexPost = defineSubscription(posted, { handler: async () => {} });
export const jobs = defineQueue({ handler: processJob });
`,
        );
        runCodegen({ projectRoot: workdir });

        const { edges, unresolved } = manifest();

        expect(edges).toContainEqual({ from: "workflow:onboarding", kind: "call", to: "function:accounts_users:me" });
        expect(edges).toContainEqual({ from: "queue:jobs", kind: "call", to: "function:accounts_users:touch" });
        expect(unresolved.filter((entry) => entry.file === "onboarding/flow" || entry.file === "jobs/process")).toStrictEqual([]);
    });

    it("draws a handler shared by two queues from both, under its renamed export", () => {
        expect.assertions(1);

        writeModules();
        write(
            "jobs/process.ts",
            `import { internal } from "../_generated/api";

const run = async (message, ctx) => {
    await ctx.runMutation(internal.accounts_users.touch, {});
};

export { run as processJob };
`,
        );
        write(
            "queues.ts",
            `import { defineQueue, defineSubscription, defineTopic } from "@lunora/queue";
import { processJob } from "./jobs/process";

export const posted = defineTopic<{ text: string }>();
export const indexPost = defineSubscription(posted, { handler: async () => {} });
export const jobs = defineQueue({ handler: processJob });
export const retries = defineQueue({ handler: processJob });
`,
        );
        runCodegen({ projectRoot: workdir });

        expect(manifest().edges.filter((edge) => edge.to === "function:accounts_users:touch" && edge.kind === "call")).toStrictEqual([
            { from: "queue:jobs", kind: "call", to: "function:accounts_users:touch" },
            { from: "queue:retries", kind: "call", to: "function:accounts_users:touch" },
        ]);
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

    /** A schema that installs a `voting` component next to the app's own `posts`. */
    const writeVotingSchema = (): void => {
        write(
            "schema.ts",
            `import { defineSchema, defineSchemaExtension, defineTable, v } from "@lunora/server";

export default defineSchema({ posts: defineTable({ title: v.string() }) }).extend(
    defineSchemaExtension("voting", { tables: { votes: defineTable({ subject: v.string() }) } }),
);
`,
        );
    };

    it("warns about a write into a component's table even when the app declares no module, and emits no manifest", () => {
        expect.assertions(2);

        writeVotingSchema();
        write(
            "posts.ts",
            `import { mutation, v } from "@lunora/server";

export const upvote = mutation({ args: { subject: v.string() }, handler: async (ctx, args) => ctx.db.insert("voting_votes", args) });
`,
        );

        const result = runCodegen({ projectRoot: workdir });

        expect(result.advisories.some((finding) => finding.name === "cross_module_table_write")).toBe(true);
        expect(existsSync(generated("architecture.json"))).toBe(false);
    });

    it("lets a declared module of the component's name absorb it", () => {
        expect.assertions(1);

        writeVotingSchema();
        write("voting/module.ts", `import { defineModule } from "@lunora/server";\nexport default defineModule({ description: "Our votes" });\n`);
        runCodegen({ projectRoot: workdir });

        expect(manifest().modules).toStrictEqual([{ description: "Our votes", name: "voting", tables: ["voting_votes"] }]);
    });

    it("rejects a declared module nested inside an installed component's folder", () => {
        expect.assertions(1);

        writeVotingSchema();
        write("voting/admin/module.ts", `import { defineModule } from "@lunora/server";\nexport default defineModule({});\n`);

        expect(() => runCodegen({ projectRoot: workdir })).toThrow(/"voting\/admin" is nested inside installed component "voting"/u);
    });

    it("rejects a file beside a module that shares its name", () => {
        expect.assertions(1);

        write("billing/module.ts", `import { defineModule } from "@lunora/server";\nexport default defineModule({});\n`);
        write("billing/invoices.ts", `import { query } from "@lunora/server";\nexport const list = query({ args: {}, handler: async () => [] });\n`);
        write("billing.ts", `import { query } from "@lunora/server";\nexport const summary = query({ args: {}, handler: async () => 0 });\n`);

        expect(() => runCodegen({ projectRoot: workdir })).toThrow(/lunora\/billing\.ts sits beside module "billing"/u);
    });
});
