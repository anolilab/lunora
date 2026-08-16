import { LunoraError } from "lunorash/errors";
import { rateLimit } from "lunorash/ratelimit";

import type { MutationCtx } from "#lunora/_generated/server.js";
import { internalMutation, internalQuery, mutation, query, v } from "#lunora/_generated/server.js";

import { limiter, limitKey } from "./limits";
import { assertSafePath } from "./sandbox";

/** Bounded arg validators. Unbounded `v.string()` on a public procedure is a payload-size hole the advisor rightly flags. */
const PROJECT_ID_ARG = v.string().meta({ schema: { maxLength: 64 } });
const PATH_ARG = v.string().meta({ schema: { maxLength: 400 } });
const CONTENT_ARG = v.string().meta({ schema: { maxLength: 256_000 } });

/** Cap on a tree listing, so a runaway project cannot return unboundedly. */
const MAX_FILES = 500;

/** Cap on one file, matching what an editor can hold and a model can reasonably read. */
const MAX_FILE_BYTES = 256_000;

/**
 * Create or replace one file.
 *
 * Upsert rather than insert-or-fail: the agent rewrites the same file across
 * turns, so a check-then-insert would be a race against itself. Shared by the
 * editor's save and the agent's `write` tool so both enforce the same limits —
 * a rule that lives in one path is a rule the other path does not have.
 */
const upsertFile = async (ctx: MutationCtx, arguments_: { content: string; path: string; projectId: string }): Promise<{ created: boolean; path: string }> => {
    const path = assertSafePath(arguments_.path);

    if (arguments_.content.length > MAX_FILE_BYTES) {
        throw new LunoraError("PAYLOAD_TOO_LARGE", `write: ${path} is ${String(arguments_.content.length)} bytes, over the ${String(MAX_FILE_BYTES)} limit`);
    }

    const existing = await ctx.db
        .query("files")
        .withIndex("by_project_path", (q) => q.eq("projectId", arguments_.projectId).eq("path", path))
        .unique();

    if (existing === null) {
        await ctx.db.insert("files", { content: arguments_.content, path, projectId: arguments_.projectId, updatedAt: Date.now() });

        return { created: true, path };
    }

    await ctx.db.patch(existing._id, { content: arguments_.content, updatedAt: Date.now() });

    return { created: false, path };
};

/**
 * The file tree for the workbench: paths and sizes, never contents.
 *
 * Contents are deliberately excluded — a tree render needs neither, and shipping
 * every file's body on every tree subscription would push a whole project over
 * the wire on each keystroke-scale change.
 */
export const tree = query.input({ projectId: PROJECT_ID_ARG }).query(async ({ args, ctx }) => {
    const files = await ctx.db
        .query("files")
        .withIndex("by_project_path", (q) => q.eq("projectId", args.projectId))
        .take(MAX_FILES);

    return {
        files: files.map((file) => {
            return { path: file.path, size: file.content.length, updatedAt: file.updatedAt };
        }),
    };
});

/** One file's contents, for the editor pane. */
export const read = query.input({ path: PATH_ARG, projectId: PROJECT_ID_ARG }).query(async ({ args, ctx }) => {
    const file = await ctx.db
        .query("files")
        .withIndex("by_project_path", (q) => q.eq("projectId", args.projectId).eq("path", args.path))
        .unique();

    return { content: file?.content, path: args.path };
});

/** The editor's save. */
export const write = mutation
    .input({ content: CONTENT_ARG, path: PATH_ARG, projectId: PROJECT_ID_ARG })
    .use(rateLimit(limiter, "write", { key: limitKey }))
    .mutation(async ({ args, ctx }) => {
        const result = await upsertFile(ctx, args);

        ctx.log.info("file.write", { created: result.created, path: result.path, projectId: args.projectId });

        return result;
    });

/** The agent's `write` tool. Internal, so the model cannot reach it as a public RPC. */
export const writeInternal = internalMutation
    .input({ content: v.string(), path: v.string(), projectId: v.string() })
    .mutation(async ({ args, ctx }) => upsertFile(ctx, args));

/** The agent's `view` tool. */
export const readInternal = internalQuery.input({ path: v.string(), projectId: v.string() }).query(async ({ args, ctx }) => {
    const file = await ctx.db
        .query("files")
        .withIndex("by_project_path", (q) => q.eq("projectId", args.projectId).eq("path", args.path))
        .unique();

    return { content: file?.content, path: args.path };
});

/** The agent's `ls` tool. */
export const listInternal = internalQuery.input({ projectId: v.string() }).query(async ({ args, ctx }) => {
    const files = await ctx.db
        .query("files")
        .withIndex("by_project_path", (q) => q.eq("projectId", args.projectId))
        .take(MAX_FILES);

    return { paths: files.map((file) => file.path) };
});

/**
 * Apply an anchored find/replace to one file — the agent's `edit` tool
 * (plan 335 §D15).
 *
 * `find` must match **exactly once**. A zero-match edit means the model is
 * working from a stale copy; a multi-match edit means the anchor is ambiguous.
 * Both are errors the model can act on, and both are silent corruption if the
 * edit is applied anyway — which is the entire reason anchored replace was
 * chosen over a line-numbered diff.
 */
export const editInternal = internalMutation
    .input({ find: v.string(), path: v.string(), projectId: v.string(), replace: v.string() })
    .mutation(async ({ args, ctx }) => {
        const path = assertSafePath(args.path);

        const file = await ctx.db
            .query("files")
            .withIndex("by_project_path", (q) => q.eq("projectId", args.projectId).eq("path", path))
            .unique();

        if (file === null) {
            throw new LunoraError("NOT_FOUND", `edit: ${path} does not exist — write it first`);
        }

        const occurrences = file.content.split(args.find).length - 1;

        if (occurrences === 0) {
            throw new LunoraError("BAD_REQUEST", `edit: the anchor was not found in ${path}. Read the file again — your copy is stale.`);
        }

        if (occurrences > 1) {
            throw new LunoraError(
                "BAD_REQUEST",
                `edit: the anchor matches ${String(occurrences)} places in ${path}. Include more surrounding context so it matches exactly one.`,
            );
        }

        await ctx.db.patch(file._id, { content: file.content.replace(args.find, args.replace), updatedAt: Date.now() });

        return { path, replaced: 1 };
    });
