import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverProcedureMiddleware from "../src/discover-procedure-middleware";

// A self-contained branded builder + middleware DSL. Discovery resolves the
// `__lunoraProcedure` brand off the receiver's *type*, so the builder is declared
// inline (the isolated test project has no workspace module resolution). `.use`
// returns the same builder so the `.use(rateLimit()).mutation(...)` chain
// type-checks and the chain walk finds the middleware calls.
// eslint-disable-next-line no-secrets/no-secrets -- inline TS fixture; a generic-interface identifier trips the entropy heuristic, not a real secret
const PREAMBLE = `
    declare const rateLimit: (options?: unknown) => (options: { ctx: unknown }) => unknown;
    declare const dbRateLimit: (config?: unknown, name?: unknown, options?: unknown) => (options: { ctx: unknown }) => unknown;
    declare const verifyTurnstile: (options?: unknown) => (options: { ctx: unknown }) => unknown;
    declare const protectPublic: (options: { rateLimit?: unknown; captcha?: unknown }) => (options: { ctx: unknown }) => unknown;
    declare const mutation: <R>(config: { args: Record<string, unknown>; handler: (ctx: unknown) => R }) => { kind: "mutation" };

    declare const v: { id: (table: string) => unknown; string: () => unknown };

    interface MutationBuilder<Args> {
        readonly __lunoraProcedure: "mutation";
        use: <C>(middleware: (options: { ctx: unknown }) => C) => MutationBuilder<Args>;
        input: <A>(args: A) => MutationBuilder<A>;
        mutation: <R>(handler: (options: { args: Args; ctx: { db: { insert: (table: string, value: unknown) => Promise<void> }; mail: { send: (m: unknown) => Promise<void> } } }) => R) => { kind: "mutation" };
    }

    declare const c: { mutation: MutationBuilder<Record<never, never>> };
`;

/** A builder-form user-table write whose input carries an email — the gate is actionable. */
const EMAIL_ARG_SIGNUP = `${PREAMBLE}
    export const signUp = c.mutation
        .input({ email: v.string() })
        .mutation(async ({ ctx }) => {
            await ctx.db.insert("users", {});
        });
`;

/** The B2B shape: a membership write whose input has no email anywhere. */
const NO_EMAIL_ARG_MEMBER_ADD = `${PREAMBLE}
    export const add = c.mutation
        .input({ organizationId: v.id("organizations"), userId: v.string() })
        .mutation(async ({ ctx }) => {
            await ctx.db.insert("members", {});
        });
`;

/** Shorthand `{ email }` — the property is a ShorthandPropertyAssignment, not an assignment. */
const SHORTHAND_EMAIL_SIGNUP = `${PREAMBLE}
    declare const email: unknown;

    export const signUp = c.mutation
        .input({ email })
        .mutation(async ({ ctx }) => {
            await ctx.db.insert("users", {});
        });
`;

/** \`.input(sharedSchema)\` — the arg list is a reference, so its keys are unreadable. */
const OPAQUE_INPUT_SIGNUP = `${PREAMBLE}
    declare const sharedSchema: Record<string, unknown>;

    export const signUp = c.mutation
        .input(sharedSchema)
        .mutation(async ({ ctx }) => {
            await ctx.db.insert("users", {});
        });
`;

/** A spread inside the input literal — the remaining keys are unenumerable. */
const SPREAD_INPUT_SIGNUP = `${PREAMBLE}
    declare const shared: Record<string, unknown>;

    export const signUp = c.mutation
        .input({ ...shared, name: v.string() })
        .mutation(async ({ ctx }) => {
            await ctx.db.insert("users", {});
        });
`;

/** Names that merely start with "email" but hold a flag/id, not an address. */
const EMAIL_LOOKALIKE_ARGS = `${PREAMBLE}
    export const update = c.mutation
        .input({ emailOptIn: v.string(), emailTemplateId: v.string(), emailVerified: v.string() })
        .mutation(async ({ ctx }) => {
            await ctx.db.insert("users", {});
        });
`;

/** A bare-factory registration whose \`args\` declares an email. */
const FACTORY_EMAIL_SIGNUP = `
    import { mutation } from "@lunora/server";

    export const signUp = mutation({
        args: { email: 1 },
        handler: async (ctx) => {
            await ctx.db.insert("users", {});
        },
    });
`;

/** A bare-factory mutation that writes the user table — public, no protections. */
const BARE_SIGNUP = `
    import { mutation } from "@lunora/server";

    export const signUp = mutation({
        args: {},
        handler: async (ctx) => {
            await ctx.db.insert("users", { name: "x" });
        },
    });
`;

/** A bare-factory public mutation that bulk-inserts into a user table via `insertMany` — a write shape `isUserTableInsert` used to miss. */
const INSERT_MANY_USER_TABLE = `
    import { mutation } from "@lunora/server";

    export const importUsers = mutation({
        args: {},
        handler: async (ctx) => {
            await ctx.db.insertMany("users", []);
        },
    });
`;

/** A bare-factory public mutation writing a `replace` into a user table — also covered by the broadened method list. */
const REPLACE_USER_TABLE = `
    import { mutation } from "@lunora/server";

    export const restoreUser = mutation({
        args: {},
        handler: async (ctx) => {
            await ctx.db.replace("users", { id: "u1" });
        },
    });
`;

/** A bare-factory public mutation writing into "userPreferences" — "user" is a modifier, not the table's terminal word, so this must NOT be treated as a user-table write. */
const USER_PREFERENCES_TABLE = `
    import { mutation } from "@lunora/server";

    export const savePreferences = mutation({
        args: {},
        handler: async (ctx) => {
            await ctx.db.insert("userPreferences", {});
        },
    });
`;

/** A bare-factory public mutation writing into "sessionReplay" — same modifier shape as "userPreferences", the other false-positive the old substring match hit. */
const SESSION_REPLAY_TABLE = `
    import { mutation } from "@lunora/server";

    export const logReplay = mutation({
        args: {},
        handler: async (ctx) => {
            await ctx.db.insert("sessionReplay", {});
        },
    });
`;

/** A bare-factory public mutation that fans out to the scheduler — no rate limit. */
const FANOUT = `
    import { mutation } from "@lunora/server";

    export const enqueue = mutation({
        args: {},
        handler: async (ctx) => {
            await ctx.scheduler.runAfter(1000, "internal.sendReminder", {});
        },
    });
`;

/** A bare-factory public mutation that bulk-inserts via the validator-bypassing `insertManyUnsafe`. */
const UNSAFE_INSERT = `
    import { mutation } from "@lunora/server";

    export const importRows = mutation({
        args: {},
        handler: async (ctx) => {
            await ctx.db.insertManyUnsafe("rows", []);
        },
    });
`;

/** A bare-factory public action that generates text with no `maxOutputTokens` bound. */
const UNBOUNDED_AI = `
    import { action } from "@lunora/server";
    import { generateText } from "@lunora/ai";

    export const summarize = action({
        args: {},
        handler: async (ctx) => {
            return await generateText({ model: ctx.ai.model("@cf/meta/llama-3"), prompt: "hi" });
        },
    });
`;

/** A bare-factory public action that generates text WITH a `maxOutputTokens` bound — not flagged. */
const BOUNDED_AI = `
    import { action } from "@lunora/server";
    import { generateText } from "@lunora/ai";

    export const summarize = action({
        args: {},
        handler: async (ctx) => {
            return await generateText({ maxOutputTokens: 256, model: ctx.ai.model("@cf/meta/llama-3"), prompt: "hi" });
        },
    });
`;

/** A spread-config AI generation — `maxOutputTokens` may come from the spread source, so it fails open (not flagged). */
const SPREAD_AI = `
    import { action } from "@lunora/server";
    import { generateText } from "@lunora/ai";

    export const summarize = action({
        args: {},
        handler: async (ctx) => {
            return await generateText({ ...ctx.ai.defaults, prompt: "hi" });
        },
    });
`;

/** A builder-form mutation guarded by `.use(rateLimit())`. */
const RATE_LIMITED = `${PREAMBLE}
    export const send = c.mutation
        .use(rateLimit({ limit: 5 }))
        .mutation(async ({ ctx }) => {
            await ctx.db.insert("messages", {});
        });
`;

/** A builder-form mutation guarded by `.use(dbRateLimit())` (the DB-backed sugar). */
const DB_RATE_LIMITED = `${PREAMBLE}
    export const send = c.mutation
        .use(dbRateLimit({}, "send"))
        .mutation(async ({ ctx }) => {
            await ctx.db.insert("messages", {});
        });
`;

/** A builder-form mutation bundled with `protectPublic({ rateLimit, captcha })`. */
const PROTECTED = `${PREAMBLE}
    export const register = c.mutation
        .use(protectPublic({ rateLimit: { limit: 5 }, captcha: true }))
        .mutation(async ({ ctx }) => {
            await ctx.db.insert("accounts", {});
            await ctx.mail.send({});
        });
`;

/** A builder-form mutation calling `protectPublic(cfg)` with a non-literal config — fail closed. */
const OPAQUE_CONFIG = `${PREAMBLE}
    declare const cfg: { rateLimit?: unknown; captcha?: unknown };

    export const opaque = c.mutation
        .use(protectPublic(cfg))
        .mutation(async ({ ctx }) => {
            await ctx.db.insert("users", {});
        });
`;

/**
 * A builder-form mutation guarded by a `const`-aliased rate-limit middleware
 * (`const rateLimitByOwner = rateLimit(...)` then `.use(rateLimitByOwner)`) — the
 * shape the storage/presence templates use. The alias must resolve to its factory.
 */
const ALIASED_RATE_LIMITED = `${PREAMBLE}
    const rateLimitByOwner = rateLimit({ limit: 5 });

    export const send = c.mutation
        .use(rateLimitByOwner)
        .mutation(async ({ ctx }) => {
            await ctx.db.insert("messages", {});
        });
`;

let workdir: string;
let project: Project;

describe("discoverProcedureMiddleware", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-mw-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records a bare-factory public mutation with no protections and a user-table write", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "signup.ts"), BARE_SIGNUP, "utf8");

        const found = discoverProcedureMiddleware(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({
            callsMail: false,
            exportName: "signUp",
            kind: "mutation",
            usesCaptcha: false,
            usesRateLimit: false,
            visibility: "public",
            writesUserTable: true,
        });
    });

    it("flags an email-shaped input argument", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "signup.ts"), EMAIL_ARG_SIGNUP, "utf8");

        const found = discoverProcedureMiddleware(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ exportName: "signUp", hasEmailArg: true, writesUserTable: true });
    });

    it("flags a shorthand `{ email }` input argument", () => {
        expect.assertions(1);

        // A ShorthandPropertyAssignment, not a PropertyAssignment — reading only
        // the latter would report "no email" and silently clear the signup lint.
        writeFileSync(join(workdir, "lunora", "signup.ts"), SHORTHAND_EMAIL_SIGNUP, "utf8");

        const found = discoverProcedureMiddleware(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ exportName: "signUp", hasEmailArg: true });
    });

    it("flags an email argument declared on a bare-factory `args`", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "signup.ts"), FACTORY_EMAIL_SIGNUP, "utf8");

        const found = discoverProcedureMiddleware(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ exportName: "signUp", hasEmailArg: true });
    });

    it("leaves the email verdict unknown for a non-literal `.input(schema)`", () => {
        expect.assertions(1);

        // Unreadable keys must stay unknown: reporting `false` would clear the
        // signup lint on a registration that may well expose an email.
        writeFileSync(join(workdir, "lunora", "signup.ts"), OPAQUE_INPUT_SIGNUP, "utf8");

        const found = discoverProcedureMiddleware(project, join(workdir, "lunora"));

        expect(found[0]?.hasEmailArg).toBeUndefined();
    });

    it("leaves the email verdict unknown when the input literal carries a spread", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "signup.ts"), SPREAD_INPUT_SIGNUP, "utf8");

        const found = discoverProcedureMiddleware(project, join(workdir, "lunora"));

        expect(found[0]?.hasEmailArg).toBeUndefined();
    });

    it("does not treat `emailVerified` / `emailOptIn` / `emailTemplateId` as an address", () => {
        expect.assertions(1);

        // These hold a flag or an id — there is no address for the gate to select,
        // so matching them would resurrect the false positive on the other side.
        writeFileSync(join(workdir, "lunora", "update.ts"), EMAIL_LOOKALIKE_ARGS, "utf8");

        const found = discoverProcedureMiddleware(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ exportName: "update", hasEmailArg: false });
    });

    it("reports no email argument for a membership write that never receives one", () => {
        expect.assertions(1);

        // The B2B false positive `signup_mutation_without_disposable_gating` used
        // to hit: "members" matches the user-table pattern, but there is no
        // address for `emailGateMiddleware` to select.
        writeFileSync(join(workdir, "lunora", "members.ts"), NO_EMAIL_ARG_MEMBER_ADD, "utf8");

        const found = discoverProcedureMiddleware(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ exportName: "add", hasEmailArg: false, writesUserTable: true });
    });

    it("recognizes an `insertMany` bulk write into a user table", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "import.ts"), INSERT_MANY_USER_TABLE, "utf8");

        const found = discoverProcedureMiddleware(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ exportName: "importUsers", writesUserTable: true });
    });

    it("recognizes a `replace` write into a user table", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "restore.ts"), REPLACE_USER_TABLE, "utf8");

        const found = discoverProcedureMiddleware(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ exportName: "restoreUser", writesUserTable: true });
    });

    it('does not treat "userPreferences" as a user table — "user" is a modifier, not the terminal word', () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "preferences.ts"), USER_PREFERENCES_TABLE, "utf8");

        const found = discoverProcedureMiddleware(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ exportName: "savePreferences", writesUserTable: false });
    });

    it('does not treat "sessionReplay" as a user table', () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "replay.ts"), SESSION_REPLAY_TABLE, "utf8");

        const found = discoverProcedureMiddleware(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ exportName: "logReplay", writesUserTable: false });
    });

    it("records a scheduler fan-out from a public mutation", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "enqueue.ts"), FANOUT, "utf8");

        const found = discoverProcedureMiddleware(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ exportName: "enqueue", fanOut: true, usesRateLimit: false, visibility: "public" });
        expect(found[0]).not.toMatchObject({ fanOut: false });
    });

    it("records a public `insertManyUnsafe` bulk write", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "import.ts"), UNSAFE_INSERT, "utf8");

        const found = discoverProcedureMiddleware(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ exportName: "importRows", usesInsertManyUnsafe: true, visibility: "public" });
    });

    it("records an unbounded AI generation (no maxOutputTokens) and clears a bounded one", () => {
        expect.assertions(2);

        writeFileSync(join(workdir, "lunora", "summarize.ts"), UNBOUNDED_AI, "utf8");
        let found = discoverProcedureMiddleware(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ exportName: "summarize", unboundedAiGeneration: true });

        writeFileSync(join(workdir, "lunora", "summarize.ts"), BOUNDED_AI, "utf8");
        project.getSourceFile(join(workdir, "lunora", "summarize.ts"))?.refreshFromFileSystemSync();
        found = discoverProcedureMiddleware(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ exportName: "summarize", unboundedAiGeneration: false });
    });

    it("does not flag an AI generation whose config carries a spread (fails open)", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "summarize.ts"), SPREAD_AI, "utf8");

        const found = discoverProcedureMiddleware(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ exportName: "summarize", unboundedAiGeneration: false });
    });

    it("records a `.use(rateLimit())` builder chain as rate-limited", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "send.ts"), RATE_LIMITED, "utf8");

        const found = discoverProcedureMiddleware(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ exportName: "send", usesCaptcha: false, usesRateLimit: true });
    });

    it("records a `.use(dbRateLimit())` builder chain as rate-limited", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "send.ts"), DB_RATE_LIMITED, "utf8");

        const found = discoverProcedureMiddleware(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ exportName: "send", usesCaptcha: false, usesRateLimit: true });
    });

    it("resolves a `const`-aliased `.use(rateLimitByOwner)` middleware to its factory", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "send.ts"), ALIASED_RATE_LIMITED, "utf8");

        const found = discoverProcedureMiddleware(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ exportName: "send", usesCaptcha: false, usesRateLimit: true });
    });

    it("does NOT assume protection from a non-literal `protectPublic(cfg)` config", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "opaque.ts"), OPAQUE_CONFIG, "utf8");

        const found = discoverProcedureMiddleware(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ exportName: "opaque", usesCaptcha: false, usesRateLimit: false });
    });

    it("unwraps a `protectPublic({ rateLimit, captcha })` bundle into both flags and detects the mail send", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "register.ts"), PROTECTED, "utf8");

        const found = discoverProcedureMiddleware(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({
            callsMail: true,
            exportName: "register",
            usesCaptcha: true,
            usesRateLimit: true,
            writesUserTable: true,
        });
    });
});
