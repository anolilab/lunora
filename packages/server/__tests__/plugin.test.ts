import { v } from "@cirrus/values";
import { describe, expect, test } from "vitest";

import { initCirrus } from "../src/builder/index.js";
import { definePlugin, defineSchemaExtension, mergeSchemaExtension } from "../src/plugin.js";
import { defineSchema, defineTable } from "../src/schema.js";

describe("defineSchemaExtension", () => {
    test("returns the key and tables", () => {
        const extension = defineSchemaExtension("ratelimit", {
            tables: {
                ratelimit_buckets: defineTable({ count: v.number(), key: v.string() }),
            },
        });

        expect(extension.key).toBe("ratelimit");
        expect(extension.tables).toHaveProperty("ratelimit_buckets");
    });

    test("rejects empty keys", () => {
        expect(() => defineSchemaExtension("", { tables: {} })).toThrow(/`key` is required/);
    });
});

describe("definePlugin", () => {
    test("packages an extension and a middleware", () => {
        const extension = defineSchemaExtension("ratelimit", {
            tables: { ratelimit_buckets: defineTable({ count: v.number() }) },
        });

        const plugin = definePlugin("ratelimit", {
            extension,
            middleware: async ({ ctx, next }) => next({ ctx: { ratelimit: { hit: () => true } } }),
        });

        expect(plugin.key).toBe("ratelimit");
        expect(plugin.extension).toBe(extension);
        expect(plugin.middleware).toBeTypeOf("function");
    });

    test("can omit either extension or middleware", () => {
        const onlyExtension = definePlugin("a", {
            extension: defineSchemaExtension("a", { tables: { a_thing: defineTable({ x: v.string() }) } }),
        });

        expect(onlyExtension.middleware).toBeUndefined();

        const onlyMiddleware = definePlugin("b", {
            middleware: ({ ctx, next }) => next({ ctx: { x: 1 } }),
        });

        expect(onlyMiddleware.extension).toBeUndefined();
    });

    test("rejects empty keys", () => {
        expect(() => definePlugin("", {})).toThrow(/`key` is required/);
    });

    test("rejects a key/extension-key mismatch", () => {
        const extension = defineSchemaExtension("foo", { tables: {} });

        expect(() => definePlugin("bar", { extension })).toThrow(/extension key "foo" does not match plugin key/);
    });
});

describe("mergeSchemaExtension", () => {
    test("adds extension tables to the base schema", () => {
        const base = defineSchema({ todos: defineTable({ title: v.string() }) });
        const extension = defineSchemaExtension("auth", {
            tables: { auth_users: defineTable({ email: v.string() }) },
        });

        const merged = mergeSchemaExtension(base, extension);

        expect(Object.keys(merged.tables).toSorted()).toEqual(["auth_users", "todos"]);
        // Non-mutating — the base must still only have its original tables.
        expect(Object.keys(base.tables)).toEqual(["todos"]);
    });

    test("throws on name collision (no silent shadow)", () => {
        const base = defineSchema({ todos: defineTable({ title: v.string() }) });
        const colliding = defineSchemaExtension("rogue", {
            tables: { todos: defineTable({ x: v.string() }) },
        });

        expect(() => mergeSchemaExtension(base, colliding)).toThrow(/table "todos" already exists/);
    });

    test("preserves vectorIndexes from the base", () => {
        const base = defineSchema({ todos: defineTable({ title: v.string() }) });
        const extension = defineSchemaExtension("x", { tables: { x_thing: defineTable({ k: v.string() }) } });

        const merged = mergeSchemaExtension(base, extension);

        expect(merged.vectorIndexes).toBe(base.vectorIndexes);
    });
});

describe("defineSchema(...).extend(...)", () => {
    test("returns an extended schema with merged tables", () => {
        const ratelimit = definePlugin("ratelimit", {
            extension: defineSchemaExtension("ratelimit", {
                tables: { ratelimit_buckets: defineTable({ count: v.number() }) },
            }),
        });

        const schema = defineSchema({ todos: defineTable({ title: v.string() }) }).extend(ratelimit.extension!);

        expect(Object.keys(schema.tables).toSorted()).toEqual(["ratelimit_buckets", "todos"]);
    });

    test("chains multiple extensions", () => {
        const a = defineSchemaExtension("a", { tables: { a_one: defineTable({ x: v.string() }) } });
        const b = defineSchemaExtension("b", { tables: { b_two: defineTable({ y: v.string() }) } });

        const schema = defineSchema({ base: defineTable({ z: v.string() }) })
            .extend(a)
            .extend(b);

        expect(Object.keys(schema.tables).toSorted()).toEqual(["a_one", "b_two", "base"]);
    });

    test("a chained call's collision is reported under the offending extension's key", () => {
        const conflicting = defineSchemaExtension("dupes", {
            tables: { same: defineTable({ x: v.string() }) },
        });
        const second = defineSchemaExtension("alsoDupes", {
            tables: { same: defineTable({ x: v.string() }) },
        });

        const intermediate = defineSchema({ ok: defineTable({ x: v.string() }) }).extend(conflicting);

        expect(() => intermediate.extend(second)).toThrow(/extend\("alsoDupes"\): table "same" already exists/);
    });
});

describe("plugin.middleware integration with the builder", () => {
    test("a plugin middleware composes with the builder chain", async () => {
        type RatelimitApi = { hit: (key: string) => boolean };

        const ratelimit = definePlugin<Record<string, never>, { hits: string[] }, { hits: string[]; ratelimit: RatelimitApi }>("ratelimit", {
            middleware: async ({ ctx, next }) =>
                next({
                    ctx: {
                        ratelimit: {
                            hit: (key: string) => {
                                ctx.hits.push(key);

                                return true;
                            },
                        },
                    },
                }),
        });

        const c = initCirrus.dataModel<Record<string, never>>().create();

        // The builder middleware sees a ctx with `hits`; plugin middleware adds `ratelimit`.
        const procedure = c.query
            .use(async ({ ctx, next }) => next({ ctx: { hits: [] as string[] } }))
            .use(ratelimit.middleware!)
            .query(({ ctx }) => {
                ctx.ratelimit.hit("u-1");

                return { hitsLength: ctx.hits.length };
            });

        // The terminal returns the canonical `{kind, args, handler}` envelope.
        const result = (await procedure.handler({}, {})) as { hitsLength: number };

        expect(result).toEqual({ hitsLength: 1 });
    });
});
