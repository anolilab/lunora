import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createOwnerFieldFixture, rowAt } from "./owner-field-writes-fixture";

/** A guard declared the way the repo declares one: `defineIdentityGuard` from `@lunora/server`. */
const DECLARED_GUARD = `import { defineIdentityGuard } from "@lunora/server";
export const assertOwnOrganizationId = defineIdentityGuard((user: unknown, organizationId: unknown): void => undefined);`;

/** The same guard returning a Promise: it may still be running when the next statement starts, so it must be awaited. */
const ASYNC_GUARD = `import { defineIdentityGuard } from "@lunora/server";
export const assertOwnOrganizationId = defineIdentityGuard(async (user: unknown, organizationId: unknown): Promise<void> => undefined);`;

/**
 * A plain public mutation (no `defineMutator`) whose body is `body`, writing an
 * owner column on line 2 (the first body line is line 2 of the file).
 */
const handler = (body: string): string => `export const createPost = mutation.mutation(async ({ args, ctx }) => {
${body}
});`;

describe("owner-field writes: guards and admin builders", () => {
    const { discover, setUp, tearDown } = createOwnerFieldFixture({ serverTypes: true });

    beforeEach(setUp);
    afterEach(tearDown);

    // A write is validated when the handler checked the argument against the
    // identity before the write. Recorded, not dropped, so the lint reads it.
    it("marks a write guarded by an if-throw against the identity", () => {
        expect.assertions(1);

        const found = discover(
            handler(`  if (args.organizationId !== ctx.user.activeOrganization?.id) throw new Error("no");
  await ctx.db.insert("prompts", { organizationId: args.organizationId });`),
        );

        expect(rowAt(found, 3)).toMatchObject({ field: "organizationId", guarded: true });
    });

    it("marks a write guarded by a declared identity guard given the argument and the identity", () => {
        expect.assertions(1);

        const found = discover(
            `${handler(`  await assertOwnOrganizationId(ctx.user, args.organizationId);
  await ctx.db.insert("prompts", { organizationId: args.organizationId });`)}
${DECLARED_GUARD}`,
        );

        expect(rowAt(found, 3)).toMatchObject({ guarded: true });
    });

    it("marks a write guarded by an async declared guard that is awaited", () => {
        expect.assertions(1);

        const found = discover(
            `${handler(`  await assertOwnOrganizationId(ctx.user, args.organizationId);
  await ctx.db.insert("prompts", { organizationId: args.organizationId });`)}
${ASYNC_GUARD}`,
        );

        expect(rowAt(found, 3)).toMatchObject({ guarded: true });
    });

    it("does not mark a write guarded by an async declared guard that is not awaited", () => {
        expect.assertions(1);

        const found = discover(
            `${handler(`  assertOwnOrganizationId(ctx.user, args.organizationId);
  await ctx.db.insert("prompts", { organizationId: args.organizationId });`)}
${ASYNC_GUARD}`,
        );

        expect(rowAt(found, 3)).not.toHaveProperty("guarded");
    });

    // A void guard has nothing left running when it returns, so an unawaited call still counts.
    it("marks a write guarded by a void declared guard called without await", () => {
        expect.assertions(1);

        const found = discover(
            `${handler(`  assertOwnOrganizationId(ctx.user, args.organizationId);
  await ctx.db.insert("prompts", { organizationId: args.organizationId });`)}
${DECLARED_GUARD}`,
        );

        expect(rowAt(found, 3)).toMatchObject({ guarded: true });
    });

    // A `defineIdentityGuard` defined in this file, not imported from the server, is not a declaration.
    it("does not mark a write guarded by a locally defined identity-guard look-alike", () => {
        expect.assertions(1);

        const found = discover(
            `${handler(`  await assertOwnOrganizationId(ctx.user, args.organizationId);
  await ctx.db.insert("prompts", { organizationId: args.organizationId });`)}
const defineIdentityGuard = <Guard extends (...args: never[]) => void>(guard: Guard): Guard => guard;
export const assertOwnOrganizationId = defineIdentityGuard((user: unknown, organizationId: unknown): void => undefined);`,
        );

        expect(rowAt(found, 3)).not.toHaveProperty("guarded");
    });

    // A function that merely has an `assert` name proves nothing: only a declared guard counts.
    it("does not mark a write guarded by an undeclared assert-named helper", () => {
        expect.assertions(1);

        const found = discover(
            handler(`  assertOwnOrganizationId(ctx.user, args.organizationId);
  await ctx.db.insert("prompts", { organizationId: args.organizationId });`),
        );

        expect(rowAt(found, 3)).not.toHaveProperty("guarded");
    });

    it("does not mark a write whose guard runs after it", () => {
        expect.assertions(1);

        const found = discover(
            handler(`  await ctx.db.insert("prompts", { organizationId: args.organizationId });
  if (args.organizationId !== ctx.user.activeOrganization?.id) throw new Error("no");`),
        );

        expect(rowAt(found, 2)).not.toHaveProperty("guarded");
    });

    it("does not mark a write guarded on a different argument", () => {
        expect.assertions(1);

        const found = discover(
            handler(`  if (args.userId !== ctx.user.userId) throw new Error("no");
  await ctx.db.insert("prompts", { organizationId: args.organizationId });`),
        );

        expect(rowAt(found, 3)).not.toHaveProperty("guarded");
    });

    // `if (args.x && args.x !== id) throw` proves `args.x === id` whenever it is
    // truthy; the fallback `args.x || id` is then the identity either way.
    it("marks a write guarded by a truthy-and-mismatch check on the same argument", () => {
        expect.assertions(1);

        const found = discover(
            handler(`  if (args.organizationId && args.organizationId !== ctx.user.activeOrganization?.id) throw new Error("no");
  await ctx.db.insert("prompts", { organizationId: args.organizationId || ctx.user.activeOrganization?.id });`),
        );

        expect(rowAt(found, 3)).toMatchObject({ guarded: true });
    });

    // A conjunct about another flag says nothing about the argument it does not test.
    it("does not mark a write when the conjunct tests an unrelated argument", () => {
        expect.assertions(1);

        const found = discover(
            handler(`  if (args.isAdmin && args.organizationId !== ctx.user.activeOrganization?.id) throw new Error("no");
  await ctx.db.insert("prompts", { organizationId: args.organizationId });`),
        );

        expect(rowAt(found, 3)).not.toHaveProperty("guarded");
    });

    // A value copied into a local keeps the argument it was copied from.
    it("follows a one-hop local to the guarded argument", () => {
        expect.assertions(1);

        const found = discover(
            handler(`  if (args.organizationId !== ctx.user.activeOrganization?.id) throw new Error("no");
  const organizationIdToUse = args.organizationId || ctx.user.activeOrganization?.id;
  await ctx.db.insert("prompts", { organizationId: organizationIdToUse });`),
        );

        expect(rowAt(found, 4)).toMatchObject({ guarded: true });
    });

    // Every branch the write can store must be proven: one unguarded branch leaks.
    it("does not mark a ternary when one branch reads an unproven argument", () => {
        expect.assertions(1);

        const found = discover(
            handler(`  if (args.organizationId !== ctx.user.activeOrganization?.id) throw new Error("no");
  await ctx.db.insert("prompts", { organizationId: args.share ? args.organizationId : args.targetOrg });`),
        );

        expect(rowAt(found, 3)).not.toHaveProperty("guarded");
    });

    it("marks a ternary whose argument branches are all proven", () => {
        expect.assertions(1);

        const found = discover(
            handler(`  if (args.organizationId !== ctx.user.activeOrganization?.id) throw new Error("no");
  await ctx.db.insert("prompts", { organizationId: args.share ? ctx.user.activeOrganization?.id : args.organizationId });`),
        );

        expect(rowAt(found, 3)).toMatchObject({ guarded: true });
    });

    // A guard that may not run cannot prove the write: a branch or a `try` can skip it.
    it("does not mark a write whose guard sits under a branch", () => {
        expect.assertions(1);

        const found = discover(
            handler(`  if (args.share) { if (args.organizationId !== ctx.user.activeOrganization?.id) throw new Error("no"); }
  await ctx.db.insert("prompts", { organizationId: args.organizationId });`),
        );

        expect(rowAt(found, 3)).not.toHaveProperty("guarded");
    });

    it("does not mark a write whose guard is inside a try block", () => {
        expect.assertions(1);

        const found = discover(
            handler(`  try { if (args.organizationId !== ctx.user.activeOrganization?.id) throw new Error("no"); } catch {}
  await ctx.db.insert("prompts", { organizationId: args.organizationId });`),
        );

        expect(rowAt(found, 3)).not.toHaveProperty("guarded");
    });

    // Only the caller's identity proves a value; a database read does not.
    it("does not treat a database read as the caller's identity", () => {
        expect.assertions(1);

        const found = discover(
            handler(`  if (args.organizationId !== (await ctx.db.get("organizations", args.organizationId))?._id) throw new Error("no");
  await ctx.db.insert("prompts", { organizationId: args.organizationId });`),
        );

        expect(rowAt(found, 3)).not.toHaveProperty("guarded");
    });

    it("stamps adminOnly on a write reached only through a platform-admin procedure", () => {
        expect.assertions(1);

        const found = discover(
            `export const createPost = adminMutation.mutation(async ({ args, ctx }) => {
  await ctx.db.insert("posts", { userId: args.userId });
});`,
            "mutators.ts",
            undefined,
            [{ args: {}, exportName: "createPost", filePath: "mutators", kind: "mutation", returnType: "unknown", visibility: "public", adminOnly: true }],
        );

        expect(rowAt(found, 2)).toMatchObject({ field: "userId", adminOnly: true });
    });

    it("does not stamp adminOnly on a write reached through an ordinary procedure", () => {
        expect.assertions(1);

        const found = discover(handler(`  await ctx.db.insert("posts", { userId: args.userId });`), "mutators.ts", undefined, [
            { args: {}, exportName: "createPost", filePath: "mutators", kind: "mutation", returnType: "unknown", visibility: "public" },
        ]);

        expect(rowAt(found, 2)).not.toHaveProperty("adminOnly");
    });

    // A helper that untracked code also reaches (here, a module-scope call) is not fully
    // attributed: its admin callers are not the whole story, so the write is not admin-only.
    it("does not stamp adminOnly on a helper that untracked module-scope code also reaches", () => {
        expect.assertions(2);

        const found = discover(
            `async function persist(ctx, args) { await ctx.db.insert("posts", { userId: args.userId }); }
const keep = persist(null as never, { userId: "boot" });
export const createPost = adminMutation.mutation(async ({ args, ctx }) => { await persist(ctx, { userId: args.userId }); });`,
            "mutators.ts",
            undefined,
            [{ args: {}, exportName: "createPost", filePath: "mutators", kind: "mutation", returnType: "unknown", visibility: "public", adminOnly: true }],
        );

        expect(rowAt(found, 1)).toMatchObject({ scope: { kind: "helper", untracked: true } });
        expect(rowAt(found, 1)).not.toHaveProperty("adminOnly");
    });

    // The gap this pins: a route handler assigned to a top-level const runs at module load, so the helper it calls is reached by untracked code.
    it("does not stamp adminOnly on a helper that an http.route handler assigned to a const also calls", () => {
        expect.assertions(2);

        const found = discover(
            `async function persist(ctx, args) { await ctx.db.insert("posts", { userId: args.userId }); }
const registered = http.route({ path: "/posts", method: "POST", handler: async (ctx, request) => { await persist(ctx, await request.json()); } });
export const createPost = adminMutation.mutation(async ({ args, ctx }) => { await persist(ctx, { userId: args.userId }); });`,
            "mutators.ts",
            undefined,
            [{ args: {}, exportName: "createPost", filePath: "mutators", kind: "mutation", returnType: "unknown", visibility: "public", adminOnly: true }],
        );

        expect(rowAt(found, 1)).toMatchObject({ scope: { kind: "helper", untracked: true } });
        expect(rowAt(found, 1)).not.toHaveProperty("adminOnly");
    });

    // The control: the same helper reached only from the admin procedure is admin-only.
    it("stamps adminOnly on a helper reached only from platform-admin procedures", () => {
        expect.assertions(1);

        const found = discover(
            `async function persist(ctx, args) { await ctx.db.insert("posts", { userId: args.userId }); }
export const createPost = adminMutation.mutation(async ({ args, ctx }) => { await persist(ctx, { userId: args.userId }); });`,
            "mutators.ts",
            undefined,
            [{ args: {}, exportName: "createPost", filePath: "mutators", kind: "mutation", returnType: "unknown", visibility: "public", adminOnly: true }],
        );

        expect(rowAt(found, 1)).toMatchObject({ adminOnly: true });
    });
});
