import { LunoraError } from "lunorash/errors";
import { rateLimit } from "lunorash/ratelimit";

import type { MutationCtx } from "#lunora/_generated/server.js";
import { internalMutation, internalQuery, mutation, query, v } from "#lunora/_generated/server.js";

import { authorizeProject } from "./authz";
import { assertRevision, assertWithinLimit, utf8ByteLength } from "./file-limits";
import { limiter, limitKey } from "./limits";
import { assertSafePath } from "./sandbox";

/** Bounded arg validators. Unbounded `v.string()` on a public procedure is a payload-size hole the advisor rightly flags. */
const PROJECT_ID_ARG = v.string().meta({ schema: { maxLength: 64 } });
const PATH_ARG = v.string().meta({ schema: { maxLength: 400 } });
const CONTENT_ARG = v.string().meta({ schema: { maxLength: 256_000 } });

/** Cap on a tree listing, so a runaway project cannot return unboundedly. */
const MAX_FILES = 500;

/**
 * Create or replace one file.
 *
 * Upsert rather than insert-or-fail: the agent rewrites the same file across
 * turns, so a check-then-insert would be a race against itself. Shared by the
 * editor's save and the agent's `write` tool so both enforce the same limits —
 * a rule that lives in one path is a rule the other path does not have.
 *
 * `expectedRevision` turns the editor's save into a compare-and-swap. Pass it and
 * a file that moved since it was read rejects with `CONFLICT`; omit it (the
 * agent's own tools, which read immediately before writing inside one durable
 * step) and the write is unconditional. `0` means "expected absent", so a save of
 * a brand-new file still says what it assumed.
 */
const upsertFile = async (
    ctx: MutationCtx,
    arguments_: { content: string; expectedRevision?: number; path: string; projectId: string },
): Promise<{ created: boolean; path: string; revision: number }> => {
    const path = assertSafePath(arguments_.path);

    assertWithinLimit(path, arguments_.content);

    const existing = await ctx.db
        .query("files")
        .withIndex("by_project_path", (q) => q.eq("projectId", arguments_.projectId).eq("path", path))
        .unique();

    const currentRevision = existing === null ? 0 : existing.revision;

    assertRevision(path, currentRevision, arguments_.expectedRevision);

    const revision = currentRevision + 1;

    if (existing === null) {
        await ctx.db.insert("files", { content: arguments_.content, path, projectId: arguments_.projectId, revision, updatedAt: Date.now() });

        return { created: true, path, revision };
    }

    await ctx.db.patch(existing._id, { content: arguments_.content, revision, updatedAt: Date.now() });

    return { created: false, path, revision };
};

/**
 * The file tree for the workbench: paths and sizes, never contents.
 *
 * Contents are deliberately excluded — a tree render needs neither, and shipping
 * every file's body on every tree subscription would push a whole project over
 * the wire on each keystroke-scale change.
 *
 * `projectId` arrives from the URL, so it is authorized before it routes: without
 * that, any signed-in caller holding another project's id reads its file paths,
 * sizes and timestamps.
 */
export const tree = query.input({ projectId: PROJECT_ID_ARG }).query(async ({ args, ctx }) => {
    const { projectId } = await authorizeProject(ctx, args.projectId);

    const files = await ctx.db
        .query("files")
        .withIndex("by_project_path", (q) => q.eq("projectId", projectId))
        .take(MAX_FILES);

    return {
        files: files.map((file) => {
            return { path: file.path, size: utf8ByteLength(file.content), updatedAt: file.updatedAt };
        }),
    };
});

/**
 * One file's contents, for the editor pane. `revision` is the token a save hands
 * back so a write that raced an agent turn is rejected rather than applied.
 */
export const read = query.input({ path: PATH_ARG, projectId: PROJECT_ID_ARG }).query(async ({ args, ctx }) => {
    const { projectId } = await authorizeProject(ctx, args.projectId);

    const file = await ctx.db
        .query("files")
        .withIndex("by_project_path", (q) => q.eq("projectId", projectId).eq("path", args.path))
        .unique();

    return { content: file?.content, path: args.path, revision: file?.revision ?? 0 };
});

/** The editor's save — compare-and-swap against the `revision` the editor read. */
export const write = mutation
    .input({ content: CONTENT_ARG, expectedRevision: v.number(), path: PATH_ARG, projectId: PROJECT_ID_ARG })
    .use(rateLimit(limiter, "write", { key: limitKey }))
    .mutation(async ({ args, ctx }) => {
        const { projectId } = await authorizeProject(ctx, args.projectId);

        const result = await upsertFile(ctx, { content: args.content, expectedRevision: args.expectedRevision, path: args.path, projectId });

        ctx.log.info("file.write", { created: result.created, path: result.path, projectId });

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
 *
 * The RESULTING content is size-checked, not the patch: a one-character anchor
 * replaced by a megabyte is a tiny edit that produces an oversized file, and
 * without this check `MAX_FILE_BYTES` would hold on `write` and not here.
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

        const content = file.content.replace(args.find, args.replace);

        assertWithinLimit(path, content);

        await ctx.db.patch(file._id, { content, revision: file.revision + 1, updatedAt: Date.now() });

        return { path, replaced: 1 };
    });
