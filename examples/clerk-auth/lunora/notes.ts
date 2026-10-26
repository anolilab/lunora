import { LunoraError } from "lunorash/errors";
import type { Middleware } from "lunorash/server";
import { definePermission, definePolicies, definePolicy, defineRole, rls } from "lunorash/server";

import type { Doc as Document_ } from "./_generated/dataModel.js";
import type { Id, MutationCtx, QueryCtx } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";

/**
 * Who sees what. The identity comes from `@lunora/jwt-auth`'s resolver in
 * `src/server/index.ts`: `auth.userId` is the IdP user id, and the active
 * organization arrives as the `orgId` claim with the org role in `roles`.
 */
const ownNotes = definePolicies([
    // read: your own notes only — an anonymous caller matches nothing.
    definePolicy({ on: "read", table: "notes", when: ({ auth }) => (auth.userId ? { ownerId: auth.userId } : false) }),
    // insert: you can only write notes you own.
    definePolicy({ on: "insert", table: "notes", when: ({ auth, row }) => auth.userId !== null && row?.ownerId === auth.userId }),
]);

/** Org admins may read every note written in their active organization. */
const readOrgNotes = definePermission("notes:read-org");
const orgAdmin = defineRole("admin", { permissions: [readOrgNotes] });

const orgNotesPolicy = definePolicies([
    definePolicy({
        on: "read",
        table: "notes",
        when: ({ auth }) => {
            const orgId = auth.identity?.["orgId"];

            return auth.can(readOrgNotes) && typeof orgId === "string" ? { orgId } : false;
        },
    }),
]);

// `rls()` types its context against the runtime writer shape, which the
// generated reader/writer facades narrow; the object underneath is the same
// adapter, so re-typing the middleware onto the generated ctx is sound (the
// boundary cast apps/playground/lunora/notes.ts uses too).
const ownRead = rls(ownNotes) as unknown as Middleware<QueryCtx, QueryCtx>;
const ownWrite = rls(ownNotes) as unknown as Middleware<MutationCtx, MutationCtx>;
const orgRead = rls(orgNotesPolicy, { roles: [orgAdmin] }) as unknown as Middleware<QueryCtx, QueryCtx>;

const newestFirst = (rows: Document_<"notes">[]): Document_<"notes">[] => rows.toSorted((a, b) => b.createdAt - a.createdAt);

/**
 * The signed-in user's notes, newest first. Reads the whole table on purpose:
 * the RLS policy is what narrows it to the caller's rows. A live query —
 * `useQuery` re-renders on every write.
 */
export const mine = query.use(ownRead).query(async ({ ctx }): Promise<Document_<"notes">[]> => newestFirst(await ctx.db.query("notes").take(200)));

/** Every note in the caller's active organization — only for the org's `admin` role; everyone else gets none. */
export const orgNotes = query.use(orgRead).query(async ({ ctx }): Promise<Document_<"notes">[]> => newestFirst(await ctx.db.query("notes").take(200)));

export const add = mutation
    .input({ text: v.string().max(2000) })
    .use(ownWrite)
    .mutation(async ({ args: { text }, ctx }): Promise<Id<"notes">> => {
        const { userId } = ctx.auth;

        if (!userId) {
            throw new LunoraError("UNAUTHENTICATED", "sign in to write notes");
        }

        const identity = await ctx.auth.getIdentity();
        const orgId = identity?.["orgId"];

        return ctx.db.insert("notes", { createdAt: ctx.now, ownerId: userId, text, ...(typeof orgId === "string" ? { orgId } : {}) });
    });
