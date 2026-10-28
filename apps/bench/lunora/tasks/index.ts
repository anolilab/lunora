/**
 * Per-tenant tasks: the bench's core CRUD surface. Every function resolves the
 * tenant from the verified identity, runs on the tenant's shard and goes through
 * the shared builders in `../lib/crpc`, the same path every generated domain takes.
 */
import { LunoraError } from "@lunora/errors";

import type { Doc, Id } from "../_generated/server.js";
import { internalMutation, v } from "../_generated/server.js";
import { orgBulkMutation, orgMutation, orgQuery, pageArgs, requireOrg, requireWriter, tagsSchema, tenantRead, tenantWrite } from "../lib/crpc.js";

const status = v.union(v.literal("todo"), v.literal("doing"), v.literal("review"), v.literal("done"), v.literal("archived"));
const priority = v.union(v.literal("low"), v.literal("normal"), v.literal("high"), v.literal("urgent"));

export const list = orgQuery
    .use(tenantRead("tasks"))
    .input({ ...pageArgs, status: v.optional(status) })
    .query(async ({ args, ctx }): Promise<Doc<"tasks">[]> => {
        const { organizationId } = await requireOrg(ctx);
        const rows = ctx.db
            .query("tasks")
            .withIndex("byOrgStatus", (q) =>
                args.status === undefined ? q.eq("organizationId", organizationId) : q.eq("organizationId", organizationId).eq("status", args.status),
            );

        return rows.order("desc").take(args.limit ?? 50);
    });

export const mine = orgQuery
    .use(tenantRead("tasks"))
    .input({ limit: v.optional(v.number().int().min(1).max(100)) })
    .query(async ({ args, ctx }): Promise<Doc<"tasks">[]> => {
        const { organizationId, userId } = await requireOrg(ctx);

        return ctx.db
            .query("tasks")
            .withIndex("byOrgAssignee", (q) => q.eq("organizationId", organizationId).eq("assigneeId", userId))
            .take(args.limit ?? 25);
    });

export const search = orgQuery
    .use(tenantRead("tasks"))
    .input({ status: v.optional(status), term: v.string().min(1).max(200) })
    .query(async ({ args, ctx }): Promise<Doc<"tasks">[]> => {
        const { organizationId } = await requireOrg(ctx);

        return ctx.db
            .query("tasks")
            .withSearchIndex("search_title", (q) => {
                const scoped = q.search("title", args.term).eq("organizationId", organizationId);

                return args.status === undefined ? scoped : scoped.eq("status", args.status);
            })
            .take(20);
    });

export const get = orgQuery
    .use(tenantRead("tasks", "taskComments"))
    .input({ id: v.id("tasks") })
    .query(async ({ args, ctx }) => {
        const { organizationId } = await requireOrg(ctx);
        const task = await ctx.db.get("tasks", args.id);

        if (!task) {
            throw new LunoraError("NOT_FOUND", "task not found");
        }

        const comments = await ctx.db
            .query("taskComments")
            .withIndex("byTask", (q) => q.eq("organizationId", organizationId).eq("taskId", args.id))
            .take(100);

        return { comments, task };
    });

export const create = orgMutation
    .use(tenantWrite("tasks", "saas_activity"))
    .input({
        assigneeId: v.optional(v.string().max(64)),
        description: v.optional(v.string().max(10_000)),
        dueAt: v.optional(v.number()),
        labels: v.from(tagsSchema),
        priority: v.optional(priority),
        projectId: v.optional(v.id("saas_projects")),
        title: v.string().min(1).max(200),
    })
    .mutation(async ({ args, ctx }): Promise<Id<"tasks">> => {
        const { organizationId, userId } = await requireWriter(ctx);
        const now = Date.now();
        const id = await ctx.db.insert("tasks", {
            assigneeId: args.assigneeId,
            createdAt: now,
            createdBy: userId,
            description: args.description,
            dueAt: args.dueAt,
            labels: args.labels,
            organizationId,
            priority: args.priority ?? "normal",
            projectId: args.projectId,
            status: "todo",
            title: args.title,
            updatedAt: now,
        });

        await ctx.db.insert("saas_activity", { action: "task.created", actorId: userId, createdAt: now, organizationId, subjectId: id, subjectType: "task" });

        return id;
    });

export const update = orgMutation
    .use(tenantWrite("tasks", "saas_activity"))
    .input({
        assigneeId: v.optional(v.string().max(64)),
        id: v.id("tasks"),
        priority: v.optional(priority),
        status: v.optional(status),
        title: v.optional(v.string().min(1).max(200)),
    })
    .mutation(async ({ args, ctx }) => {
        const { organizationId, userId } = await requireWriter(ctx);
        const { id, ...patch } = args;
        const now = Date.now();

        await ctx.db.patch("tasks", id, { ...patch, updatedAt: now });
        await ctx.db.insert("saas_activity", {
            action: "task.updated",
            actorId: userId,
            createdAt: now,
            meta: patch,
            organizationId,
            subjectId: id,
            subjectType: "task",
        });

        return { ok: true as const };
    });

export const comment = orgMutation
    .use(tenantWrite("tasks", "taskComments"))
    .input({ body: v.string().min(1).max(5000), taskId: v.id("tasks") })
    .mutation(async ({ args, ctx }): Promise<Id<"taskComments">> => {
        const { organizationId, userId } = await requireOrg(ctx);

        return ctx.db.insert("taskComments", { authorId: userId, body: args.body, createdAt: Date.now(), organizationId, taskId: args.taskId });
    });

export const bulkArchive = orgBulkMutation
    .use(tenantWrite("tasks"))
    .input({ ids: v.array(v.id("tasks")).max(200) })
    .mutation(async ({ args, ctx }) => {
        await requireWriter(ctx);

        const now = Date.now();

        await Promise.all(args.ids.map(async (id) => ctx.db.patch("tasks", id, { status: "archived", updatedAt: now })));

        return { archived: args.ids.length };
    });

/** Nightly sweep (see `lunora/crons.ts`): archive tasks done for 30 days. */
export const sweepDone = internalMutation.input({ organizationId: v.string(), before: v.number() }).mutation(async ({ args, ctx }) => {
    const done = await ctx.db
        .query("tasks")
        .withIndex("byOrgStatus", (q) => q.eq("organizationId", args.organizationId).eq("status", "done").lt("updatedAt", args.before))
        .take(500);

    await Promise.all(done.map(async (row) => ctx.db.patch("tasks", row._id, { status: "archived" })));

    return { archived: done.length };
});
