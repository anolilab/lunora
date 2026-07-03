import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverMailRecipientAccesses from "../src/discover-mail-recipient-accesses";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

describe("discoverMailRecipientAccesses", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-mail-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it('flags a direct ctx.mail.send({ to: args.email, subject: "x" })', () => {
        expect.assertions(2);

        write("send.ts", `export const notify = mutation(async ({ ctx, args }) => { await ctx.mail.send({ to: args.email, subject: "x" }); });`);

        const found = discoverMailRecipientAccesses(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "notify", file: "send", line: 1, method: "send" });
    });

    it("flags a ctx.email.queue with an args-derived cc alongside a fixed to", () => {
        expect.assertions(2);

        write("queue.ts", `export const relay = mutation(async ({ ctx, args }) => { await ctx.email.queue({ cc: args.cc, to: "ops@x.com" }); });`);

        const found = discoverMailRecipientAccesses(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ exportName: "relay", method: "queue" });
    });

    it("flags an args value reached through one local const hop", () => {
        expect.assertions(1);

        write("hop.ts", `export const notify = mutation(async ({ ctx, args }) => { const t = args.email; await ctx.mail.send({ to: t }); });`);

        expect(discoverMailRecipientAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("flags a shorthand recipient ({ to }) bound to an args value", () => {
        expect.assertions(1);

        write("shorthand.ts", `export const notify = mutation(async ({ ctx, args }) => { const to = args.email; await ctx.mail.send({ to }); });`);

        expect(discoverMailRecipientAccesses(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("ignores a shorthand recipient ({ to }) bound to a server-trusted ctx value", () => {
        expect.assertions(1);

        write("shorthand-safe.ts", `export const notify = mutation(async ({ ctx }) => { const to = ctx.auth.user.email; await ctx.mail.send({ to }); });`);

        expect(discoverMailRecipientAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("attributes a send bound to a local const to the exported handler, not the local", () => {
        expect.assertions(1);

        // The `ctx.mail.send(...)` call is nested in `const messageId = …`; enclosingExportName
        // must walk past that local binding to the exported `notify`, not report "messageId".
        write(
            "local-const.ts",
            `export const notify = mutation(async ({ ctx, args }) => { const messageId = await ctx.mail.send({ to: args.email }); return messageId; });`,
        );

        expect(discoverMailRecipientAccesses(project, join(workdir, "lunora"))[0]).toMatchObject({ exportName: "notify" });
    });

    it("ignores a recipient scoped by a server-trusted ctx value", () => {
        expect.assertions(1);

        write("scoped.ts", `export const notify = mutation(async ({ ctx, args }) => { await ctx.mail.send({ to: ctx.auth.user.email }); });`);

        expect(discoverMailRecipientAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a fixed literal recipient", () => {
        expect.assertions(1);

        write("fixed.ts", `export const notify = mutation(async ({ ctx }) => { await ctx.mail.send({ to: "ops@x.com" }); });`);

        expect(discoverMailRecipientAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a call with no recipient property", () => {
        expect.assertions(1);

        write("no-recipient.ts", `export const notify = mutation(async ({ ctx }) => { await ctx.mail.send({ subject: "x" }); });`);

        expect(discoverMailRecipientAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("ignores a non-mail receiver with the same method name", () => {
        expect.assertions(1);

        write("other.ts", `export const notify = mutation(async ({ args }) => { await foo.send({ to: args.email }); });`);

        expect(discoverMailRecipientAccesses(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
