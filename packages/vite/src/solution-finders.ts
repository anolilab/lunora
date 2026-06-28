import type { OverlayPluginOptions } from "./types";

/**
 * A `@visulima/vite-overlay` solution finder. Derived from the overlay's own
 * options type so the shape can't drift from the installed package. The overlay
 * runs every finder it's given (custom finders first, then its built-ins),
 * sorted by `priority` descending, and shows the first non-`undefined` result.
 *
 * Note: this type (and {@link Solution}) is re-exported from `@lunora/vite` and
 * intentionally tracks the installed `@visulima/vite-overlay` — if a future
 * overlay release changes the finder contract, that surfaces here as a compile
 * error rather than a silent drift.
 */
type SolutionFinder = NonNullable<OverlayPluginOptions["solutionFinders"]>[number];

/** What a finder may return: a Markdown-rendered `{ header?, body }`, or `undefined` to defer. */
type Solution = NonNullable<Awaited<ReturnType<SolutionFinder["handle"]>>>;

/**
 * The normalized error a finder receives. The overlay invokes finders
 * **server-side** with a flattened object — not the original `Error` — so the
 * class identity is gone by the time we see it (`error instanceof X` never
 * works here). Codegen/schema failures, which Lunora pushes through
 * `server.hot.send({ type: "error", … })`, arrive with `name === "Error"`, so
 * the class name is useless for matching: **every rule matches on `message`**,
 * the one field that carries the full text on both the codegen-push and the
 * forwarded-runtime paths. `message` is typed `unknown` because the overlay's
 * own contract passes the error as `any`.
 */
interface NormalizedError {
    message?: unknown;
}

/**
 * A single Lunora error→solution rule. `test` runs against the error message;
 * the first matching rule (in array order) wins, since the rules are evaluated
 * by one finder that returns on first hit.
 */
interface LunoraSolutionRule {
    /** Markdown body shown under the header. */
    body: string;
    /** Short Markdown header for the solution panel. */
    header: string;
    /** Stable id (used as the finder name in DEBUG logs and in tests). */
    id: string;
    /** True when this rule recognizes the error. */
    test: (message: string) => boolean;
}

/**
 * Lunora-specific error solutions for the dev error overlay. Ordered most- to
 * least-specific; the dev-time codegen/schema rules come first because they're
 * the errors a developer hits while editing `lunora/`, then the runtime
 * data-layer conflicts that surface from the worker.
 *
 * Bodies are Markdown — the overlay parses `header`/`body` through its Markdown
 * renderer before injecting them.
 */
const LUNORA_SOLUTION_RULES: ReadonlyArray<LunoraSolutionRule> = [
    {
        body: [
            "Lunora codegen couldn't find a schema to generate from.",
            "",
            "Create `lunora/schema.ts` exporting a `defineSchema(...)` call:",
            "",
            "```ts",
            'import { defineSchema, defineTable, v } from "@lunora/server";',
            "",
            "export default defineSchema({",
            "  messages: defineTable({ body: v.string() }),",
            "});",
            "```",
            "",
            "Or scaffold a table with `vis generate lunora-table --name=messages`.",
        ].join("\n"),
        header: "No Lunora schema found",
        id: "lunora-schema-missing",
        test: (message) => message.includes("defineSchema() not found") || message.includes("schema.ts not found at"),
    },
    {
        body: [
            "`defineSchema(...)` must be called with an **inline object literal** mapping table names to `defineTable(...)`:",
            "",
            "```ts",
            "export default defineSchema({",
            "  todos: defineTable({ title: v.string(), done: v.boolean() }),",
            "});",
            "```",
            "",
            "Codegen reads the schema statically, so it can't follow a variable or a spread — pass the object literal directly.",
        ].join("\n"),
        header: "`defineSchema()` needs an inline object literal",
        id: "lunora-schema-not-object-literal",
        test: (message) => message.includes("defineSchema() expects an object literal"),
    },
    {
        body: [
            "This table name collides with a built-in `ctx.db` member, so the generated client can't expose it.",
            "",
            "Rename the table to anything that isn't a reserved name (the error lists them) — e.g. `userAccounts` instead of `insert`.",
        ].join("\n"),
        header: "Table name is reserved",
        id: "lunora-table-reserved",
        test: (message) => message.includes("is reserved") && message.includes("ctx.db"),
    },
    {
        body: [
            "Two tables resolve to the same name — usually a base table and a schema **extension** both defining it.",
            "",
            "Rename one of them, or drop the duplicate from the extension. Each table name must be unique across `defineSchema(...)` and every `.extend(...)`.",
        ].join("\n"),
        header: "Duplicate table name",
        id: "lunora-table-duplicate",
        // Anchor on `.extend(` — the only Lunora throw for this is
        // `defineSchema(...).extend(...): table "x" already exists …`. Matching a
        // bare "already exists"/"extension" pair would false-positive on
        // unrelated forwarded errors (e.g. a "file already exists" + "extension").
        test: (message) => message.includes("already exists") && message.includes(".extend("),
    },
    {
        body: [
            '`.jurisdiction(...)` accepts only a **string literal** of `"eu"`, `"us"`, or `"fedramp"`:',
            "",
            "```ts",
            'defineSchema({ /* … */ }).jurisdiction("eu");',
            "```",
        ].join("\n"),
        header: "Invalid `.jurisdiction(...)` value",
        id: "lunora-jurisdiction",
        test: (message) => message.includes("unknown jurisdiction") || (message.includes("jurisdiction") && message.includes('"eu", "us", or "fedramp"')),
    },
    {
        body: [
            "The `unique` flag on an index must be a **literal** `true` or `false`, not a computed value — codegen needs to read it statically:",
            "",
            "```ts",
            'defineTable({ email: v.string() }).index("by_email", ["email"], { unique: true });',
            "```",
        ].join("\n"),
        header: "`unique` must be a literal",
        id: "lunora-unique-literal",
        test: (message) => message.includes("must be a literal") && message.includes("unique"),
    },
    {
        body: [
            "A declared container/workflow class isn't re-exported by your worker entry, so `wrangler deploy` would reject it.",
            "",
            "Add the generated re-export shown in the error to your worker entry (e.g. `src/index.ts`):",
            "",
            "```ts",
            'export * from "./lunora/_generated/containers";',
            "```",
        ].join("\n"),
        header: "Binding not exported by your worker entry",
        id: "lunora-worker-entry-export-gap",
        test: (message) => message.includes("not exported by your worker entry"),
    },
    {
        body: [
            "A row with the same value already exists in a `unique` index.",
            "",
            "- If you meant to upsert, use `ctx.db.<table>().upsert(...)` (or `.patch(...)` an existing row) instead of `.insert(...)`.",
            '- Otherwise pick a value that isn\'t already taken, and consider surfacing a friendly "already exists" message to the user.',
        ].join("\n"),
        header: "Unique constraint violation",
        id: "lunora-runtime-unique",
        test: (message) => message.includes("unique constraint violation on"),
    },
    {
        body: [
            "Another write changed this row while your mutation was running (optimistic concurrency conflict).",
            "",
            "Re-read the row and retry the mutation with the fresh value. Lunora serializes a DO's mutations, so a persistent conflict usually means the handler conflicts **with itself** (e.g. a trigger or cascade touching the same row) — split that work rather than adding a retry loop.",
        ].join("\n"),
        header: "Optimistic concurrency conflict",
        id: "lunora-runtime-occ",
        test: (message) => message.includes("optimistic concurrency conflict"),
    },
];

/**
 * Lunora's solution finder for the dev error overlay. A single finder that
 * walks {@link LUNORA_SOLUTION_RULES} and returns the first match — so one
 * `priority` slot covers every Lunora rule and the overlay's built-in finders
 * still run for anything we don't recognize (we return `undefined`).
 *
 * Priority is high so a Lunora-specific hint wins over the overlay's generic
 * finder for the same error; a user's own finder can still outrank it with a
 * higher `priority`.
 */
const lunoraSolutionFinder: SolutionFinder = {
    // Synchronous body wrapped in `Promise.resolve` rather than `async`: the
    // overlay's `handle` contract is promise-returning, but `require-await` is on
    // for src and there's nothing to await here.
    handle: (error: NormalizedError): Promise<Solution | undefined> => {
        const message = typeof error.message === "string" ? error.message : "";

        for (const rule of LUNORA_SOLUTION_RULES) {
            if (rule.test(message)) {
                return Promise.resolve({ body: rule.body, header: rule.header });
            }
        }

        return Promise.resolve(undefined);
    },
    name: "lunora",
    priority: 100,
};

/** The finders Lunora injects into the overlay by default. */
const lunoraSolutionFinders: ReadonlyArray<SolutionFinder> = [lunoraSolutionFinder];

export type { LunoraSolutionRule, Solution, SolutionFinder };
export { LUNORA_SOLUTION_RULES, lunoraSolutionFinder, lunoraSolutionFinders };
