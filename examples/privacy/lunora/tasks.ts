import { rateLimit } from "lunorash/ratelimit";

import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";
import { byCaller, limiter } from "./limits";
import { subjectOf } from "./subject";

/** The signed-in user's tasks, newest first. Each row is personal data, so the dataset in `privacy.ts` covers it. */
export const myTasks = query.query(async ({ ctx }) => {
    const rows = await ctx.db
        .query("tasks")
        .withIndex("byUser", (q) => q.eq("userId", subjectOf(ctx)))
        .collect();

    return rows.toSorted((a, b) => b.createdAt - a.createdAt);
});

export const addTask = mutation
    .use(rateLimit(limiter, "write", byCaller))
    .input({ title: v.string().max(200) })
    .mutation(async ({ args: { title }, ctx }): Promise<Id<"tasks">> => {
        const id = await ctx.db.insert("tasks", { createdAt: ctx.now, done: false, title, userId: subjectOf(ctx) });

        ctx.log.info("task added", { id });

        return id;
    });
