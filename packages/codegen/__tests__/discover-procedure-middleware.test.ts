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
    declare const verifyTurnstile: (options?: unknown) => (options: { ctx: unknown }) => unknown;
    declare const protectPublic: (options: { rateLimit?: unknown; captcha?: unknown }) => (options: { ctx: unknown }) => unknown;
    declare const mutation: <R>(config: { args: Record<string, unknown>; handler: (ctx: unknown) => R }) => { kind: "mutation" };

    interface MutationBuilder<Args> {
        readonly __lunoraProcedure: "mutation";
        use: <C>(middleware: (options: { ctx: unknown }) => C) => MutationBuilder<Args>;
        mutation: <R>(handler: (options: { args: Args; ctx: { db: { insert: (table: string, value: unknown) => Promise<void> }; mail: { send: (m: unknown) => Promise<void> } } }) => R) => { kind: "mutation" };
    }

    declare const c: { mutation: MutationBuilder<Record<never, never>> };
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

/** A builder-form mutation guarded by `.use(rateLimit())`. */
const RATE_LIMITED = `${PREAMBLE}
    export const send = c.mutation
        .use(rateLimit({ limit: 5 }))
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

    it("records a `.use(rateLimit())` builder chain as rate-limited", () => {
        expect.assertions(1);

        writeFileSync(join(workdir, "lunora", "send.ts"), RATE_LIMITED, "utf8");

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
