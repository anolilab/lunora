// One function per result shape a generated SDK has to decode. Every non-object
// result is a case where a model backend declares something other than a class
// (an alias, an extension, a bare helper, or nothing at all).
import { mutation, query, v } from "./_generated/server.js";

// The one shape every backend types: a plain object result.
export const summary = query
    .input({})
    .output(v.object({ size: v.number(), title: v.string() }))
    .query(async () => {
        return { size: 2, title: "t" };
    });

export const count = query
    .input({})
    .output(v.number())
    .query(async () => 2);

// An unset optional argument must be omitted from the frame, not sent as null.
export const create = mutation
    .input({ note: v.optional(v.string()), title: v.string() })
    .output(v.id("items"))
    .mutation(async ({ args, ctx }) => ctx.db.insert("items", args));

export const clear = mutation
    .input({})
    .output(v.null())
    .mutation(async () => null);

// Two functions per non-object shape: a backend that declares one helper per
// result renders the same helper twice.
export const tags = query
    .input({})
    .output(v.array(v.string()))
    .query(async () => ["a"]);

export const labels = query
    .input({})
    .output(v.array(v.string()))
    .query(async () => ["b"]);

export const stats = query
    .input({})
    .output(v.record(v.string(), v.number()))
    .query(async () => {
        return { a: 1 };
    });

export const totals = query
    .input({})
    .output(v.record(v.string(), v.number()))
    .query(async () => {
        return { b: 2 };
    });

export const find = query
    .input({ id: v.id("items") })
    .output(v.union(v.object({ note: v.optional(v.string()), title: v.string() }), v.null()))
    .query(async () => null);

export const page = query
    .input({})
    .output(v.array(v.object({ kind: v.union(v.literal("a"), v.literal("b")), title: v.string() })))
    .query(async () => []);

export const pick = mutation
    .input({ choice: v.union(v.object({ a: v.number(), kind: v.literal("x") }), v.object({ b: v.string(), kind: v.literal("y") })) })
    .output(v.union(v.string(), v.number()))
    .mutation(async () => "x");

// Names that are keywords in at least one target language.
export const match = query
    .input({ pattern: v.string() })
    .output(v.number())
    .query(async () => 1);

export const type = query
    .input({})
    .output(v.number())
    .query(async () => 1);

export const self = query
    .input({})
    .output(v.number())
    .query(async () => 1);
