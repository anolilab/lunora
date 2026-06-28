/**
 * Lunora-specific error→solution hints. A small rule table mapping the exact
 * messages Lunora throws — codegen/schema diagnostics, worker-entry export gaps,
 * and the runtime data-layer conflicts — to an actionable fix.
 *
 * This table is the single source of truth shared by every consumer that wants
 * to turn a raw Lunora error into a fix hint: the Vite error overlay
 * (`@lunora/vite`) renders the Markdown in the browser, and the standalone
 * `lunora dev` CLI prints it to the terminal. It lives in `@lunora/codegen`
 * because codegen owns most of the throw sites, so the hints stay next to the
 * code that produces the messages.
 *
 * Matching is on the **message text**. By the time a diagnostic reaches a
 * consumer it has often been flattened to a plain `{ message }` (the overlay
 * pushes codegen errors through `server.hot.send` with `name === "Error"`), so
 * the class identity is gone and the message is the only stable signal.
 *
 * Bodies are Markdown — the overlay renders them; the CLI prints them (lightly
 * de-marked) as-is.
 */

/** A resolved hint for a recognized Lunora error. */
export interface LunoraSolution {
    /** Markdown body shown under the header. */
    body: string;
    /** Short header for the solution. */
    header: string;
    /** Stable id (used in DEBUG logs and tests). */
    id: string;
}

/** A single error→solution rule: a {@link LunoraSolution} plus its matcher. */
export interface LunoraSolutionRule extends LunoraSolution {
    /** True when this rule recognizes the error message. */
    test: (message: string) => boolean;
}

/**
 * The rules, ordered most- to least-specific: the dev-time codegen/schema rules
 * come first because they're the errors a developer hits while editing
 * `lunora/`, then the runtime data-layer conflicts that surface from the worker.
 * The first matching rule (in array order) wins.
 */
export const LUNORA_SOLUTION_RULES: ReadonlyArray<LunoraSolutionRule> = [
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
            "Or run `lunora init` to scaffold Lunora (a sample `lunora/schema.ts` included) into your app.",
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
 * Find the first Lunora solution whose rule matches `message`, or `undefined`
 * if none recognize it. Consumers turn the returned Markdown into their own
 * presentation (overlay panel, terminal hint, …).
 */
export const findLunoraSolution = (message: string): LunoraSolution | undefined => {
    for (const rule of LUNORA_SOLUTION_RULES) {
        if (rule.test(message)) {
            return { body: rule.body, header: rule.header, id: rule.id };
        }
    }

    return undefined;
};
