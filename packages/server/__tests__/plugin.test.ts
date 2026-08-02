import { v } from "@lunora/values";
import { describe, expect, expectTypeOf, it } from "vitest";

import { initLunora } from "../src/builder/index";
import { composePluginMiddleware, defineComponent, definePlugin, defineSchemaExtension, installPlugins, mergeSchemaExtension } from "../src/plugin";
import { defineSchema, defineTable, defineVectorIndex } from "../src/schema";

const { mutation, query } = initLunora.dataModel().create();

describe("defineSchemaExtension", () => {
    it("returns the key and tables", () => {
        expect.assertions(2);

        const extension = defineSchemaExtension("ratelimit", {
            tables: {
                // Authors write the bare name; prefixing happens at merge.
                buckets: defineTable({ count: v.number(), key: v.string() }),
            },
        });

        expect(extension.key).toBe("ratelimit");
        expect(extension.tables).toHaveProperty("buckets");
    });

    it("rejects empty keys", () => {
        expect.assertions(1);

        expect(() => defineSchemaExtension("", { tables: {} })).toThrow(/`key` is required/);
    });
});

describe("definePlugin", () => {
    it("packages an extension and a middleware", () => {
        expect.assertions(3);

        const extension = defineSchemaExtension("ratelimit", {
            tables: { ratelimit_buckets: defineTable({ count: v.number() }) },
        });

        const plugin = definePlugin("ratelimit", {
            extension,
            middleware: async ({ next }) => next({ ctx: { ratelimit: { hit: () => true } } }),
        });

        expect(plugin.key).toBe("ratelimit");
        expect(plugin.extension).toBe(extension);
        expect(plugin.middleware).toBeTypeOf("function");
    });

    it("can omit either extension or middleware", () => {
        expect.assertions(2);

        const onlyExtension = definePlugin("a", {
            extension: defineSchemaExtension("a", { tables: { a_thing: defineTable({ x: v.string() }) } }),
        });

        expect(onlyExtension.middleware).toBeUndefined();

        const onlyMiddleware = definePlugin("b", {
            middleware: ({ next }) => next({ ctx: { x: 1 } }),
        });

        expect(onlyMiddleware.extension).toBeUndefined();
    });

    it("rejects empty keys", () => {
        expect.assertions(1);

        expect(() => definePlugin("", {})).toThrow(/`key` is required/);
    });

    it("rejects a key/extension-key mismatch", () => {
        expect.assertions(1);

        const extension = defineSchemaExtension("foo", { tables: {} });

        expect(() => definePlugin("bar", { extension })).toThrow(/extension key "foo" does not match plugin key/);
    });
});

describe("mergeSchemaExtension", () => {
    it("auto-namespaces extension tables by the extension key", () => {
        expect.assertions(3);

        const base = defineSchema({ todos: defineTable({ title: v.string() }) });
        const extension = defineSchemaExtension("auth", {
            // Bare `users` — auto-prefixed to `auth_users`.
            tables: { users: defineTable({ email: v.string() }) },
        });

        const merged = mergeSchemaExtension(base, extension);

        expect(Object.keys(merged.tables).toSorted((a, b) => a.localeCompare(b))).toEqual(["auth_users", "todos"]);
        expect(merged.tables).not.toHaveProperty("users");
        // Non-mutating — the base must still only have its original tables.
        expect(Object.keys(base.tables)).toEqual(["todos"]);
    });

    it("lets app and component share a bare table name without colliding", () => {
        expect.assertions(2);

        // The app already has its own `users` table; the component ships one too.
        const base = defineSchema({ users: defineTable({ name: v.string() }) });
        const extension = defineSchemaExtension("auth", {
            tables: { users: defineTable({ email: v.string() }) },
        });

        const merged = mergeSchemaExtension(base, extension);

        // No throw — different namespaces. App keeps `users`; component is `auth_users`.
        expect(Object.keys(merged.tables).toSorted((a, b) => a.localeCompare(b))).toEqual(["auth_users", "users"]);
        expect(merged.tables).toHaveProperty("auth_users");
    });

    it("rewrites intra-extension relation targets to the prefixed name", () => {
        expect.assertions(2);

        const base = defineSchema({ todos: defineTable({ title: v.string() }) });
        const extension = defineSchemaExtension("blog", {
            tables: {
                authors: defineTable({ name: v.string() }),
                posts: defineTable({ authorId: v.string(), title: v.string() }).relations((r) => {
                    return {
                        // Bare reference to a sibling extension table…
                        author: r.one("authors", { field: "authorId" }),
                    };
                }),
            },
        });

        const merged = mergeSchemaExtension(base, extension);

        // …is rewritten to the prefixed sibling name.
        expect(merged.tables["blog_posts"]?.relationMap["author"]?.table).toBe("blog_authors");
        expect(merged.tables).toHaveProperty("blog_authors");
    });

    it("does NOT rewrite a relation that targets a base/app table", () => {
        expect.assertions(1);

        const base = defineSchema({ users: defineTable({ name: v.string() }) });
        const extension = defineSchemaExtension("blog", {
            tables: {
                posts: defineTable({ authorId: v.string() }).relations((r) => {
                    return {
                        // `users` is an APP table, not an extension table — left bare.
                        author: r.one("users", { field: "authorId" }),
                    };
                }),
            },
        });

        const merged = mergeSchemaExtension(base, extension);

        expect(merged.tables["blog_posts"]?.relationMap["author"]?.table).toBe("users");
    });

    it("rewrites aggregate- and rank-index `on` fields to the prefixed name", () => {
        expect.assertions(2);

        const base = defineSchema({ todos: defineTable({ title: v.string() }) });
        const extension = defineSchemaExtension("blog", {
            tables: {
                posts: defineTable({ score: v.number(), userId: v.string() })
                    .aggregateIndex("byUser", { by: ["userId"] })
                    .rankIndex("topScore", { sortBy: [{ direction: "desc", field: "score" }] }),
            },
        });

        const merged = mergeSchemaExtension(base, extension);

        expect(merged.tables["blog_posts"]?.aggregateIndexes[0]?.on).toBe("blog_posts");
        expect(merged.tables["blog_posts"]?.rankIndexes[0]?.on).toBe("blog_posts");
    });

    it("throws when two same-key extensions produce the same prefixed table", () => {
        expect.assertions(1);

        const base = defineSchema({ todos: defineTable({ title: v.string() }) });
        const first = defineSchemaExtension("rl", { tables: { buckets: defineTable({ x: v.string() }) } });
        const second = defineSchemaExtension("rl", { tables: { buckets: defineTable({ y: v.string() }) } });

        const intermediate = mergeSchemaExtension(base, first);

        expect(() => mergeSchemaExtension(intermediate, second)).toThrow(/table "rl_buckets" already exists/);
    });

    it("preserves vectorIndexes from the base", () => {
        expect.assertions(1);

        const base = defineSchema({ todos: defineTable({ title: v.string() }) });
        const extension = defineSchemaExtension("x", { tables: { thing: defineTable({ k: v.string() }) } });

        const merged = mergeSchemaExtension(base, extension);

        // The merge returns a fresh object (never mutates the input), so the
        // base vector indexes are preserved by value, not reference.
        expect(merged.vectorIndexes).toStrictEqual(base.vectorIndexes);
    });

    it("merges + prefixes vectorIndexes contributed by the extension, rewriting the table reference", () => {
        expect.assertions(4);

        const base = defineSchema(
            { docs: defineTable({ body: v.string() }) },
            {
                base_idx: defineVectorIndex({
                    dimensions: 3,
                    embed: async () => [0, 0, 0],
                    metric: "cosine",
                    source: { select: (row) => String(row["body"]), table: "docs" },
                }),
            },
        );
        const extension = defineSchemaExtension("x", {
            tables: { thing: defineTable({ body: v.string() }) },
            vectorIndexes: {
                idx: defineVectorIndex({
                    dimensions: 3,
                    embed: async () => [0, 0, 0],
                    metric: "cosine",
                    // Bare reference to the extension's own table.
                    source: { select: (row) => String(row["body"]), table: "thing" },
                }),
            },
        });

        const merged = mergeSchemaExtension(base, extension);

        expect(merged.vectorIndexes).toHaveProperty("base_idx");
        expect(merged.vectorIndexes).toHaveProperty("x_idx");
        expect(merged.vectorIndexes).not.toHaveProperty("idx");
        // The vector index's `table` is rewritten to the prefixed extension table.
        expect(merged.vectorIndexes["x_idx"]?.table).toBe("x_thing");
    });

    it("throws on a same-key vector-index name collision", () => {
        expect.assertions(1);

        const base = defineSchema(
            { docs: defineTable({ body: v.string() }) },
            {
                x_shared: defineVectorIndex({
                    dimensions: 3,
                    embed: async () => [0, 0, 0],
                    metric: "cosine",
                    source: { select: (row) => String(row["body"]), table: "docs" },
                }),
            },
        );
        const colliding = defineSchemaExtension("x", {
            tables: { thing: defineTable({ body: v.string() }) },
            vectorIndexes: {
                shared: defineVectorIndex({
                    dimensions: 3,
                    embed: async () => [0, 0, 0],
                    metric: "cosine",
                    source: { select: (row) => String(row["body"]), table: "thing" },
                }),
            },
        });

        expect(() => mergeSchemaExtension(base, colliding)).toThrow(/vector index "x_shared" already exists/);
    });
});

describe("defineSchema(...).extend(...)", () => {
    it("returns an extended schema with auto-namespaced tables", () => {
        expect.assertions(1);

        const ratelimit = definePlugin("ratelimit", {
            extension: defineSchemaExtension("ratelimit", {
                // Bare name — merges in as `ratelimit_buckets`.
                tables: { buckets: defineTable({ count: v.number() }) },
            }),
        });

        const schema = defineSchema({ todos: defineTable({ title: v.string() }) }).extend(ratelimit.extension);

        expect(Object.keys(schema.tables).toSorted((a, b) => a.localeCompare(b))).toEqual(["ratelimit_buckets", "todos"]);
    });

    it("chains multiple extensions, namespacing each by its own key", () => {
        expect.assertions(1);

        const a = defineSchemaExtension("a", { tables: { one: defineTable({ x: v.string() }) } });
        const b = defineSchemaExtension("b", { tables: { two: defineTable({ y: v.string() }) } });

        const schema = defineSchema({ base: defineTable({ z: v.string() }) })
            .extend(a)
            .extend(b);

        expect(Object.keys(schema.tables).toSorted((left, right) => left.localeCompare(right))).toEqual(["a_one", "b_two", "base"]);
    });

    it("two extensions with the same key + table collide under the shared prefix", () => {
        expect.assertions(1);

        const conflicting = defineSchemaExtension("dupes", {
            tables: { same: defineTable({ x: v.string() }) },
        });
        const second = defineSchemaExtension("dupes", {
            tables: { same: defineTable({ x: v.string() }) },
        });

        const intermediate = defineSchema({ ok: defineTable({ x: v.string() }) }).extend(conflicting);

        expect(() => intermediate.extend(second)).toThrow(/extend\("dupes"\): table "dupes_same" already exists/);
    });

    // Plan 258 §5 S3: `defineSchema` only validates the tables it was called
    // with — an extension's tables never passed through it, so without
    // re-running `validateIndexFields` on the merged set, a bad
    // extension-contributed index was never checked at all (it only failed
    // later, at migration time, as an opaque SQLite error).
    it("re-validates the merged schema, throwing for an extension-contributed index naming a column absent from its table's shape", () => {
        expect.assertions(1);

        const broken = defineSchemaExtension("broken", {
            tables: { widgets: defineTable({ title: v.string() }).index("by_owner", ["ownerId" as never]) },
        });

        expect(() => defineSchema({ todos: defineTable({ title: v.string() }) }).extend(broken)).toThrow(
            /table "broken_widgets" index "by_owner" names column "ownerId" which is not in the table's shape/,
        );
    });

    it("still accepts a well-formed extension index (no false positive from the re-validation)", () => {
        expect.assertions(1);

        const ok = defineSchemaExtension("ok", {
            tables: { widgets: defineTable({ ownerId: v.string(), title: v.string() }).index("by_owner", ["ownerId"]) },
        });

        expect(() => defineSchema({ todos: defineTable({ title: v.string() }) }).extend(ok)).not.toThrow();
    });
});

describe("defineComponent", () => {
    it("bundles extension, middleware, and functions", () => {
        expect.assertions(5);

        const extension = defineSchemaExtension("ratelimit", {
            tables: { ratelimit_buckets: defineTable({ count: v.number(), key: v.string() }) },
        });

        const check = query.input({ key: v.string() }).query(() => {
            return { allowed: true };
        });

        const reset = mutation.input({ key: v.string() }).mutation(() => undefined);

        const component = defineComponent("ratelimit", {
            extension,
            functions: { check, reset },
            middleware: async ({ ctx, next }) => next({ ctx: { ...(ctx as object) } }),
        });

        expect(component.key).toBe("ratelimit");
        expect(component.extension).toBe(extension);
        expect(component.middleware).toBeTypeOf("function");
        expect(component.functions.check).toBe(check);
        expect(component.functions.reset).toBe(reset);
    });

    it("returns an empty functions record when none supplied", () => {
        expect.assertions(1);

        const component = defineComponent("empty", {});

        expect(component.functions).toEqual({});
    });

    it("supports re-export wiring — destructuring component.functions yields real registered functions", () => {
        expect.assertions(1);

        const component = defineComponent("api", {
            functions: {
                ping: query.query(() => "pong"),
            },
        });

        // The re-export pattern users will follow:
        const { ping } = component.functions;

        expect(ping.kind).toBe("query");

        expectTypeOf(ping.handler).toBeFunction();
    });

    it("rejects extension key mismatch (same rule as definePlugin)", () => {
        expect.assertions(1);

        const extension = defineSchemaExtension("foo", { tables: {} });

        expect(() => defineComponent("bar", { extension })).toThrow(/extension key "foo" does not match plugin key/);
    });
});

describe("triggers survive the extension merge", () => {
    it("carries an extension table's triggerMap onto the prefixed table", () => {
        expect.assertions(3);

        const handler = (): void => undefined;
        const base = defineSchema({ todos: defineTable({ title: v.string() }) });
        const extension = defineSchemaExtension("audit", {
            tables: {
                events: defineTable({ kind: v.string() }).triggers((t) => {
                    return { onWrite: t.afterInsert(handler) };
                }),
            },
        });

        const merged = mergeSchemaExtension(base, extension);

        // The trigger fires on the prefixed table name (`audit_events`), and the
        // descriptor + handler reference survive the merge byte-for-byte.
        expect(merged.tables).toHaveProperty("audit_events");
        expect(merged.tables["audit_events"]?.triggerMap["onWrite"]).toMatchObject({ op: "insert", timing: "after" });
        expect(merged.tables["audit_events"]?.triggerMap["onWrite"]?.handler).toBe(handler);
    });
});

describe("installPlugins", () => {
    it("installs every plugin's extension in one call, skipping middleware-only plugins", () => {
        expect.assertions(2);

        const ratelimit = definePlugin("ratelimit", {
            extension: defineSchemaExtension("ratelimit", { tables: { buckets: defineTable({ count: v.number() }) } }),
        });
        const audit = definePlugin("audit", {
            extension: defineSchemaExtension("audit", { tables: { events: defineTable({ kind: v.string() }) } }),
        });
        // Middleware-only plugin — contributes no tables, must be skipped cleanly.
        const tracing = definePlugin("tracing", { middleware: ({ next }) => next({ ctx: { traced: true } }) });

        const schema = installPlugins(defineSchema({ todos: defineTable({ title: v.string() }) }), [ratelimit, audit, tracing]);

        expect(Object.keys(schema.tables).toSorted((a, b) => a.localeCompare(b))).toEqual(["audit_events", "ratelimit_buckets", "todos"]);
        // Same collision policy as `.extend(...)`: a duplicate prefixed table throws.
        expect(() => installPlugins(schema, [ratelimit])).toThrow(/table "ratelimit_buckets" already exists/);
    });

    // Plan 258 §5 S3: `installPlugins` shares `mergeSchemaExtension` with
    // `.extend(...)`, so it gets the same re-validation for free — a plugin's
    // bad index is caught here too, not just on the `.extend(...)` chain.
    it("re-validates a plugin's contributed index too, throwing for a column absent from the plugin table's shape", () => {
        expect.assertions(1);

        const broken = definePlugin("broken", {
            extension: defineSchemaExtension("broken", {
                tables: { widgets: defineTable({ title: v.string() }).index("by_owner", ["ownerId" as never]) },
            }),
        });

        expect(() => installPlugins(defineSchema({ todos: defineTable({ title: v.string() }) }), [broken])).toThrow(
            /table "broken_widgets" index "by_owner" names column "ownerId" which is not in the table's shape/,
        );
    });
});

describe("composePluginMiddleware", () => {
    it("runs every plugin middleware in order under a single .use()", async () => {
        expect.assertions(2);

        const order: string[] = [];
        const first = definePlugin<Record<string, never>, { order: string[] }, { first: true; order: string[] }>("first", {
            middleware: ({ ctx, next }) => {
                ctx.order.push("first");

                return next({ ctx: { first: true } });
            },
        });
        const second = definePlugin<Record<string, never>, { first: true; order: string[] }, { first: true; order: string[]; second: true }>("second", {
            middleware: ({ ctx, next }) => {
                ctx.order.push("second");

                return next({ ctx: { second: true } });
            },
        });

        const c = initLunora.dataModel<Record<string, never>>().create();
        const procedure = c.query
            .use(async ({ next }) => next({ ctx: { order } }))
            .use(composePluginMiddleware([first, second]))
            .query(({ ctx }) => {
                return { first: ctx.first, second: ctx.second };
            });

        const result = await procedure.handler({}, {});

        // Both plugin contexts are visible to the handler, and they ran in array order.
        expect(result).toEqual({ first: true, second: true });
        expect(order).toEqual(["first", "second"]);
    });

    it("forwards context unchanged when a plugin calls next() with no ctx", async () => {
        expect.assertions(1);

        // `passthrough` calls next() with no argument — the composed chain must
        // forward the upstream context untouched, then `tagging` widens it.
        const passthrough = definePlugin("pass", { middleware: ({ next }) => next() });
        const tagging = definePlugin<Record<string, never>, unknown, { tagged: true }>("tag", {
            middleware: ({ next }) => next({ ctx: { tagged: true } }),
        });

        const c = initLunora.dataModel<Record<string, never>>().create();
        const procedure = c.query
            .use(async ({ next }) => next({ ctx: { base: 1 } }))
            .use(composePluginMiddleware([passthrough, tagging]))
            .query(({ ctx }) => {
                return { base: ctx.base, tagged: ctx.tagged };
            });

        await expect(procedure.handler({}, {})).resolves.toEqual({ base: 1, tagged: true });
    });

    it("inherits the builder's double-next() guard (compose ≡ chained .use())", async () => {
        expect.assertions(1);

        // A misbehaving plugin that calls next() twice must throw, exactly as it
        // would in a hand-chained `.use()` — the shared executor's tripwire.
        const doubleNext = definePlugin("double", {
            middleware: async ({ next }) => {
                await next();

                return next();
            },
        });

        const c = initLunora.dataModel<Record<string, never>>().create();
        const procedure = c.query.use(composePluginMiddleware([doubleNext])).query(() => "ok");

        await expect(procedure.handler({}, {})).rejects.toThrow(/next\(\) called multiple times/u);
    });

    it("short-circuits later plugins when one returns without calling next()", async () => {
        expect.assertions(1);

        // `stop` returns its context without calling next() — the composed chain
        // must not advance to `after`, matching how a `.use()` link that never
        // calls next() halts the chain.
        const ran: string[] = [];
        const stop = definePlugin("stop", {
            middleware: ({ ctx }) => {
                ran.push("stop");

                return ctx;
            },
        });
        const after = definePlugin("after", {
            middleware: ({ next }) => {
                ran.push("after");

                return next();
            },
        });

        const c = initLunora.dataModel<Record<string, never>>().create();
        const procedure = c.query.use(composePluginMiddleware([stop, after])).query(() => "ok");

        await procedure.handler({}, {});

        expect(ran).toEqual(["stop"]);
    });
});

describe("plugin.middleware integration with the builder", () => {
    it("a plugin middleware composes with the builder chain", async () => {
        expect.assertions(1);

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

        const c = initLunora.dataModel<Record<string, never>>().create();

        // The builder middleware sees a ctx with `hits`; plugin middleware adds `ratelimit`.
        const procedure = c.query
            .use(async ({ next }) => next({ ctx: { hits: [] as string[] } }))
            .use(ratelimit.middleware!)
            .query(({ ctx }) => {
                ctx.ratelimit.hit("u-1");

                return { hitsLength: ctx.hits.length };
            });

        // The terminal returns the canonical `{kind, args, handler}` envelope.
        const result = await procedure.handler({}, {});

        expect(result).toEqual({ hitsLength: 1 });
    });
});
