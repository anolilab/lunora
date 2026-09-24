// Procedures come from the generated `_generated/server` re-export, the way every
// template and example writes them — importing the bare builders from
// `@lunora/server` instead leaves the handler context untyped, which only shows
// up once something compiles the app (and until this fixture, nothing did).
import { mutation, query, v } from "./_generated/server.js";

export const list = query.input({ boardId: v.string() }).query(async ({ args, ctx }) => {
    return ctx.db
        .query("notes")
        .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
        .collect();
});

export const add = mutation.input({ body: v.string(), boardId: v.string() }).mutation(async ({ args, ctx }) => {
    return ctx.db.insert("notes", { body: args.body, boardId: args.boardId, ownerId: ctx.auth.userId ?? "" });
});

/**
 * Issue #810: an output whose type reaches codegen through the CHECKER rather
 * than through the validator IR — `v.from(...)` over a `v.object(...)`.
 *
 * `Infer<v.object(shape)>` resolves through `@lunora/values`'s `ObjectShapeType`,
 * a NON-exported alias the checker never prints: it prints the structure it
 * inlined, an intersection of the optional half and the required half. Reading
 * "not exported from its own module" as "printed bare" sent that structure to an
 * expander that reproduces only plain object types, so it declined and the whole
 * output erased to `unknown` — 138 of 692 procedures at once in a real app, with
 * `lunora codegen` exiting 0 and no advisory raised.
 *
 * The golden is the regression test: `api.ts` has to carry the structure here,
 * and `unknown` means the classification went over-broad again.
 */
export const vNoteSummary = v.object({ title: v.string(), body: v.optional(v.string()) });

export const summary = query
    .input({})
    .output(v.from(v.union(vNoteSummary, v.null())))
    .query(async () => null);
