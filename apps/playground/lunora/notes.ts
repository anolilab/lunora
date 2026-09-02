import type { RateLimitConfigMap } from "@lunora/ratelimit";
import { dbRateLimit } from "@lunora/ratelimit";
import type { Middleware, PaginationResult } from "lunorash/server";
import { definePolicies, definePolicy, rls } from "lunorash/server";

// eslint-disable-next-line unicorn/prevent-abbreviations -- "Doc" is the generated dataModel type name; aliasing it breaks codegen
import type { Doc } from "./_generated/dataModel.js";
// eslint-disable-next-line unicorn/prevent-abbreviations -- "MutationCtx"/"QueryCtx" are the generated server type names
import type { Id, MutationCtx, QueryCtx } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";

// 20 note writes per minute per user, durable via the DB-backed store.
const limits = { add: { kind: "token bucket", period: 60_000, rate: 20 } } satisfies RateLimitConfigMap;

/**
 * Row-Level Security for the `notes` table — the playground's private-per-user
 * surface, exercised end-to-end by `tests/e2e/tests/auth-rls.spec.ts`.
 *
 * - read: a signed-in user sees only rows whose `ownerId` matches their id;
 *   anonymous callers see nothing (`false` forces the zero-row sentinel).
 * - insert: the candidate row's `ownerId` must be the caller's own id, so a
 *   client can never plant a note into another user's list.
 */
const policies = definePolicies([
    definePolicy({ on: "read", table: "notes", when: ({ auth }) => (auth.userId ? { ownerId: auth.userId } : false) }),
    definePolicy({ on: "insert", table: "notes", when: ({ auth, row }) => row?.ownerId === auth.userId }),
]);

// `rls()` types its context against the runtime writer shape
// (`RlsContextIn.db: DatabaseWriterLike`), which the generated reader/writer
// facades deliberately narrow — the runtime object underneath is the same
// adapter, so re-typing the middleware onto the generated ctx is sound (the
// same boundary cast the `@lunora/server` RLS tests use).
const notesReadRls = rls(policies) as unknown as Middleware<QueryCtx, QueryCtx>;
const notesWriteRls = rls(policies) as unknown as Middleware<MutationCtx, MutationCtx>;

/**
 * List the caller's notes. Deliberately reads the WHOLE table — the `rls()`
 * read policy above is the only thing narrowing the result to the caller's
 * rows. Do NOT add a hand-written owner filter here: the auth-rls E2E exists
 * to prove the policy (not the handler) is the isolation boundary.
 */
export const list = query.use(notesReadRls).query(async ({ ctx }): Promise<Doc<"notes">[]> => ctx.db.query("notes").take(200));

/**
 * One page of the caller's notes, under the same RLS read policy as
 * {@link list}.
 *
 * Deliberately annotated with an imported PACKAGE alias and deliberately
 * without `.output()`: that is the exact shape whose inferred return type used
 * to reach `_generated/api.ts` as a bare, unimported `PaginationResult` —
 * TS2304 in generated output (issue #509).
 *
 * This is the INTEGRATION half of the gate for that class: `lint:types` compiles
 * `lunora/_generated/**` under `tsconfig.generated.json`, against a real
 * `node_modules`, so it also proves the umbrella rewrite actually resolves —
 * which a sandboxed unit test cannot. The unit half lives where the emitter does
 * (`packages/codegen/__tests__/run-codegen.test.ts`) and cannot be disarmed from
 * here. Keep the annotation, keep the import, and do not add `.output()`.
 */
export const listPage = query
    .input({
        cursor: v.optional(v.string().max(512)),
        numItems: v.number().check((value) => Number.isInteger(value) && value > 0 && value <= 200, {
            message: "must be a whole number between 1 and 200",
            schema: { maximum: 200, minimum: 1, type: "integer" },
        }),
    })
    .use(notesReadRls)
    .query(
        async ({ args, ctx }): Promise<PaginationResult<Doc<"notes">>> =>
            await ctx.db.query("notes").paginate({ cursor: args.cursor, numItems: args.numItems }),
    );

/**
 * Add a note owned by the caller. `createdAt` is stamped by the client so the
 * handler stays deterministic (same convention as `messages.send`). The RLS
 * insert policy re-checks `ownerId === auth.userId` on the candidate row.
 */
export const add = mutation
    .input({
        createdAt: v.number(),
        text: v.string().max(1024),
    })
    .use(dbRateLimit(limits, "add", { key: (ctx) => ctx.auth.userId ?? ctx.ip ?? "anonymous" }))
    .use(notesWriteRls)
    .mutation(async ({ args, ctx }): Promise<Id<"notes">> => {
        const noteId = await ctx.db.insert("notes", {
            createdAt: args.createdAt,
            ownerId: ctx.auth.userId ?? "anonymous",
            text: args.text,
        });

        // After the insert, and without the owner: this table is the RLS surface,
        // so a log line naming who owns which note leaks exactly what the policy
        // exists to keep apart.
        ctx.log.info("note added", { characters: args.text.length });

        return noteId;
    });
