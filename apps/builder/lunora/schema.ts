import { agentExtension } from "@lunora/agent";
import { defineSchema, defineTable, v } from "lunorash/server";

import { ratelimit } from "./ratelimit/schema.js";

/**
 * Lander's own schema — the builder's state, not the state of the apps it
 * builds. A generated app carries its own schema inside its own project
 * directory and never appears here.
 *
 * **Storage tiers, and why each table sits where it does.**
 *
 * The split is the one plan 335 §D10 describes: per-project conversation state
 * shards by `projectId`, and anything looked up *without* already knowing the
 * project is `.global()` (D1).
 *
 * - `projects`, `users` and `shares` are `.global()`. Each is read on a path
 *   that has no project in hand yet — "list my projects", "who is this session",
 *   "resolve this share token" — which is precisely the cross-tenant query
 *   `.global()` exists for. **Note the deviation from the plan's one-line
 *   sketch**, which listed `projects` and `shares` among the sharded tables: a
 *   table cannot shard by the id it is itself keyed on, and routing the project
 *   list through every shard to answer a dashboard is the fan-out `.global()`
 *   is there to avoid.
 * - `chats`, `messages`, `snapshots` and `usage` `.shardBy("projectId")`. All
 *   four are only ever read with a project already resolved, they are the
 *   high-write tables (a build turn appends messages continuously), and a busy
 *   project must not contend with an unrelated one.
 *
 * The sharded tables carry an explicit `projectId: v.string()` rather than
 * `v.id("projects")`: the shard key is resolved before any lookup, so it has to
 * be a plain routable value, and `projects` lives in a different storage tier
 * from its children.
 */
export default defineSchema({
    /**
     * One conversation thread against a project. A project usually has exactly
     * one, but forking a build mid-thread creates a second, which is why this is
     * a table rather than fields on `projects`.
     */
    chats: defineTable({
        createdAt: v.number(),
        projectId: v.string(),
        /** Author-visible thread name; defaults to the opening prompt, truncated. */
        title: v.string(),
    })
        .shardBy("projectId")
        .index("by_project_created", ["projectId", "createdAt"]),

    /**
     * A single turn in a chat. `role` covers the three the UI renders
     * differently; tool calls are `role: "tool"` with the call recorded in
     * `content` — the agent's own durable thread is the source of truth, and
     * this table is the projection the workbench subscribes to.
     */
    messages: defineTable({
        chatId: v.id("chats"),
        content: v.string(),
        createdAt: v.number(),
        projectId: v.string(),
        role: v.union(v.literal("assistant"), v.literal("tool"), v.literal("user")),
        /** Set on assistant turns once the turn settles; absent while streaming. */
        tokens: v.optional(v.number()),
    })
        .shardBy("projectId")
        .index("by_chat_created", ["chatId", "createdAt"]),

    /**
     * Every file in a project's working tree, and the source of truth for them.
     *
     * The tree lives here rather than only inside a sandbox container for three
     * reasons: the workbench subscribes to it, so an agent write appears in the
     * editor with no polling and no bespoke stream; a container is disposable
     * and a project is not, so a session that outlives its sandbox loses
     * nothing; and the eject path (§3.2) can zip a project without booting
     * anything. The sandbox is a *projection* of this table — files are synced
     * in before a command runs and read back after.
     *
     * `path` is project-relative and slash-separated, never absolute and never
     * containing `..` — `assertSafePath` enforces that on every write, because
     * this is the value an untrusted model chooses.
     */
    files: defineTable({
        content: v.string(),
        path: v.string(),
        projectId: v.string(),
        updatedAt: v.number(),
    })
        .shardBy("projectId")
        .index("by_project_path", ["projectId", "path"], { unique: true }),

    /**
     * A restorable point in a project's life. `commit` is the git SHA inside the
     * sandbox (plan 335 §D16 makes real git the history store); `bundleKey` is
     * where the pushed bundle landed in R2, so a session that outlived its
     * container can be brought back.
     */
    snapshots: defineTable({
        bundleKey: v.optional(v.string()),
        commit: v.string(),
        createdAt: v.number(),
        label: v.string(),
        projectId: v.string(),
    })
        .shardBy("projectId")
        .index("by_project_created", ["projectId", "createdAt"]),

    /**
     * Per-turn token accounting, the input to `tokenBudget` in
     * `@lunora/ratelimit` (plan 335 §D17). Written after every turn *including
     * a failed one* — a generation that consumed input tokens and then threw
     * still has to be paid for.
     */
    usage: defineTable({
        createdAt: v.number(),
        inputTokens: v.number(),
        model: v.string(),
        outputTokens: v.number(),
        projectId: v.string(),
    })
        .shardBy("projectId")
        .index("by_project_created", ["projectId", "createdAt"]),

    /**
     * A project the builder is building. `template` is the `templates/<name>`
     * the sandbox scaffolded from — two are supported at first (plan 335 §D12),
     * and recording it per project is what lets that widen without a migration.
     */
    projects: defineTable({
        createdAt: v.number(),
        name: v.string(),
        ownerId: v.optional(v.id("users")),
        /** Absent until the project has been deployed at least once. */
        deployedUrl: v.optional(v.string()),
        template: v.string(),
        updatedAt: v.number(),
    })
        .global()
        .index("by_owner_updated", ["ownerId", "updatedAt"])
        .index("by_updated", ["updatedAt"]),

    /**
     * A public, read-only link to a project. Looked up by `token` alone — the
     * visitor has no project id, which is exactly why this cannot be sharded.
     */
    shares: defineTable({
        createdAt: v.number(),
        /** Absent means the link does not expire. */
        expiresAt: v.optional(v.number()),
        projectId: v.string(),
        token: v.string(),
    })
        .global()
        .index("by_token", ["token"], { unique: true }),

    /**
     * A signed-in builder user. Anonymous sessions deliberately have no row —
     * they get a project and a token budget without an account, and only claim
     * one when they connect a Cloudflare account (plan 335 §D6).
     */
    users: defineTable({
        createdAt: v.number(),
        email: v.string(),
        name: v.optional(v.string()),
    })
        .global()
        .index("by_email", ["email"], { unique: true }),
})
    .extend(ratelimit.extension)
    // Thread + message tables the durable agent loop persists through. They
    // auto-prefix to `agent_threads` / `agent_messages`, so they cannot collide
    // with the app tables above.
    .extend(agentExtension);
