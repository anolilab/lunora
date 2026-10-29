// The `ctx.artifacts` golden: an action that reads a file from a repo and an
// internal one that mints a short-lived write token for a Git client.
// `ctx.artifacts` is ActionCtx-only, so the query below must not see it.
import { action, internalAction, query, v } from "./_generated/server.js";

export const readme = action.input({ repo: v.string() }).action(async ({ args, ctx }) => {
    const file = await ctx.artifacts.withRepo(args.repo, async (repo) => repo.readFile({ path: "README.md", ref: "main" }));

    return file === null ? null : await file.text();
});

// Internal: the authenticated remote is a write credential, so no client may call this.
export const pushRemote = internalAction.input({ repo: v.string() }).action(async ({ args, ctx }) => {
    const { remote } = await ctx.artifacts.info(args.repo);
    const token = await ctx.artifacts.withRepo(args.repo, async (repo) => repo.createToken("write", 600));

    return { remote: ctx.artifacts.authenticatedRemote(remote, token.plaintext), tokenId: token.id };
});

export const count = query.input({}).query(async ({ ctx }) => (await ctx.db.query("snapshots").collect()).length);
