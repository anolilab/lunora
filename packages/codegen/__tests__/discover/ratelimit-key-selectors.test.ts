import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverRatelimitKeySelectors from "../../src/discover/ratelimit-key-selectors";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

describe("discoverRatelimitKeySelectors", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-ratelimit-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("flags a rateLimit(...) key selector derived from `ctx.args`", () => {
        expect.assertions(2);

        // `ctx.args` is the only spelling a user can write: the middleware hands
        // the selector the *context*, and the validated call args hang off it.
        // A bare `args` identifier is not in scope where these selectors are
        // declared, so a fixture using one proves nothing about real code.
        write("send.ts", `export const send = mutation.use(rateLimit(limiter, "send", { key: (ctx) => ctx.args.email })).mutation(async () => {});`);

        const found = discoverRatelimitKeySelectors(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ callee: "rateLimit", exportName: "send", file: "send", limitName: "send", line: 1 });
    });

    it("flags a key selector whose context parameter is named something other than `ctx`", () => {
        expect.assertions(1);

        write("renamed.ts", `export const send = mutation.use(rateLimit(limiter, "send", { key: (c) => c.args.email })).mutation(async () => {});`);

        expect(discoverRatelimitKeySelectors(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("flags a key selector that destructures `args` out of its context parameter", () => {
        expect.assertions(1);

        write(
            "destructured.ts",
            `export const send = mutation.use(rateLimit(limiter, "send", { key: ({ args: { email } }) => email })).mutation(async () => {});`,
        );

        expect(discoverRatelimitKeySelectors(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("flags a key selector hoisted into a module-scope const", () => {
        expect.assertions(1);

        // How every example in this repo writes its guard options; a feeder that
        // reads only a direct object-literal third argument sees none of them.
        write(
            "hoisted.ts",
            `const byEmail = { key: (ctx) => ctx.args.email };\nexport const send = mutation.use(rateLimit(limiter, "send", byEmail)).mutation(async () => {});`,
        );

        expect(discoverRatelimitKeySelectors(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("ignores a hoisted key selector scoped by a server-trusted identity", () => {
        expect.assertions(1);

        write(
            "hoisted-scoped.ts",
            `const byUser = { key: (ctx: { auth: { userId?: null | string }; ip?: string }): string => ctx.auth.userId ?? ctx.ip ?? "anon" };\nexport const send = mutation.use(rateLimit(limiter, "send", byUser)).mutation(async () => {});`,
        );

        expect(discoverRatelimitKeySelectors(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a key selector that reaches `ctx.args` only as a fallback behind a trusted identity", () => {
        expect.assertions(1);

        write(
            "mixed.ts",
            `export const send = mutation.use(rateLimit(limiter, "send", { key: (ctx) => ctx.auth.userId ?? ctx.args.email })).mutation(async () => {});`,
        );

        expect(discoverRatelimitKeySelectors(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("does not let an args field that shares the parameter's name read as trusted scoping", () => {
        expect.assertions(1);

        // The trailing `.ctx` is a property NAME, not a reference to the context
        // parameter. Counting it would suppress the finding — the same
        // name-position confusion that kept `ctx.args.*` invisible to begin with.
        write("collide.ts", `export const send = mutation.use(rateLimit(limiter, "send", { key: (ctx) => ctx.args.ctx })).mutation(async () => {});`);

        expect(discoverRatelimitKeySelectors(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("flags a dbRateLimit(...) key selector derived from args", () => {
        expect.assertions(2);

        write("db.ts", `export const send = mutation.use(dbRateLimit(config, "send", { key: (ctx) => ctx.args.email })).mutation(async () => {});`);

        const found = discoverRatelimitKeySelectors(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ callee: "dbRateLimit", limitName: "send" });
    });

    it("flags an args-derived key selector with a block-body arrow", () => {
        expect.assertions(1);

        write(
            "block.ts",
            `export const send = mutation.use(rateLimit(limiter, "send", { key: (ctx) => { return ctx.args.email; } })).mutation(async () => {});`,
        );

        expect(discoverRatelimitKeySelectors(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("ignores a key selector scoped by ctx.auth.userId", () => {
        expect.assertions(1);

        write("scoped.ts", `export const send = mutation.use(rateLimit(limiter, "send", { key: (ctx) => ctx.auth.userId })).mutation(async () => {});`);

        expect(discoverRatelimitKeySelectors(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a key selector scoped by ctx.ip", () => {
        expect.assertions(1);

        write(
            "ip.ts",
            `export const send = mutation.use(rateLimit(limiter, "send", { key: (ctx) => ctx.auth.userId ?? ctx.ip ?? "anon" })).mutation(async () => {});`,
        );

        expect(discoverRatelimitKeySelectors(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a fixed/global key selector with no args reference", () => {
        expect.assertions(1);

        write("global.ts", `export const send = mutation.use(rateLimit(limiter, "send", { key: () => "global" })).mutation(async () => {});`);

        expect(discoverRatelimitKeySelectors(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a rateLimit call with no key option at all", () => {
        expect.assertions(1);

        write("nokey.ts", `export const send = mutation.use(rateLimit(limiter, "send")).mutation(async () => {});`);

        expect(discoverRatelimitKeySelectors(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores an unrelated call with the same options shape", () => {
        expect.assertions(1);

        write("other.ts", `export const send = mutation.use(otherMiddleware(limiter, "send", { key: (ctx) => ctx.args.email })).mutation(async () => {});`);

        expect(discoverRatelimitKeySelectors(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("still flags an args-derived selector when a nested callback shadows the context parameter's name", () => {
        expect.assertions(1);

        // Two DIFFERENT `ctx` bindings. Matching references by spelling credited
        // the nested parameter's own declaration to the selector, which read as
        // "this selector touches something server-trusted" and dropped a finding
        // whose key is `ctx.args.email` — spoofable, and the whole point of the
        // lint.
        write(
            "shadow.ts",
            `export const send = mutation.use(rateLimit(limiter, "send", { key: (ctx) => ctx.args.email + rows.map((ctx) => ctx.id).join("") })).mutation(async () => {});`,
        );

        expect(discoverRatelimitKeySelectors(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("does not credit a nested callback's own `ctx.args` read to the enclosing selector", () => {
        expect.assertions(1);

        // The mirror of the case above: the selector never touches its own
        // parameter, so it is not args-derived and must not be reported.
        write(
            "shadow-only.ts",
            `export const send = mutation.use(rateLimit(limiter, "send", { key: (ctx) => rows.map((ctx) => ctx.args.email).join(",") })).mutation(async () => {});`,
        );

        expect(discoverRatelimitKeySelectors(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("does not read hoisted options out of a reassignable module-scope `let`", () => {
        expect.assertions(1);

        // The shape that runs is the second one. Reporting the initializer would
        // be a finding about code that never executes.
        write(
            "let.ts",
            `let options = { key: (ctx) => ctx.args.email };\noptions = { key: (ctx) => ctx.auth.userId };\nexport const send = mutation.use(rateLimit(limiter, "send", options)).mutation(async () => {});`,
        );

        expect(discoverRatelimitKeySelectors(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("does not resolve hoisted options to a module-scope const that merely shares the name", () => {
        expect.assertions(1);

        // The call site binds the FUNCTION-LOCAL `byUser`. A name-keyed lookup
        // answered with the module-scope one and cleared a spoofable selector by
        // reading a different object entirely.
        write(
            "shadowed-const.ts",
            `const byUser = { key: (ctx) => ctx.auth.userId };\nexport function build() { const byUser = { key: (ctx) => ctx.args.email }; return mutation.use(rateLimit(limiter, "send", byUser)).mutation(async () => {}); }`,
        );

        expect(discoverRatelimitKeySelectors(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
