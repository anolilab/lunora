import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverRatelimitKeySelectors from "../src/discover-ratelimit-key-selectors";

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

    it("flags a rateLimit(...) key selector derived from args", () => {
        expect.assertions(2);

        write(
            "send.ts",
            `export const send = mutation.use(rateLimit(limiter, "send", { key: (ctx) => args.email })).mutation(async ({ ctx, args }) => {});`,
        );

        const found = discoverRatelimitKeySelectors(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ callee: "rateLimit", exportName: "send", file: "send", limitName: "send", line: 1 });
    });

    it("flags a dbRateLimit(...) key selector derived from args", () => {
        expect.assertions(2);

        write("db.ts", `export const send = mutation.use(dbRateLimit(config, "send", { key: (ctx) => args.email })).mutation(async () => {});`);

        const found = discoverRatelimitKeySelectors(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ callee: "dbRateLimit", limitName: "send" });
    });

    it("flags an args-derived key selector with a block-body arrow", () => {
        expect.assertions(1);

        write(
            "block.ts",
            `export const send = mutation.use(rateLimit(limiter, "send", { key: (ctx) => { return args.email; } })).mutation(async () => {});`,
        );

        expect(discoverRatelimitKeySelectors(project, join(workdir, "lunora"))).toHaveLength(1);
    });

    it("ignores a key selector scoped by ctx.auth.userId", () => {
        expect.assertions(1);

        write(
            "scoped.ts",
            `export const send = mutation.use(rateLimit(limiter, "send", { key: (ctx) => ctx.auth.userId })).mutation(async () => {});`,
        );

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

        write("other.ts", `export const send = mutation.use(otherMiddleware(limiter, "send", { key: (ctx) => args.email })).mutation(async () => {});`);

        expect(discoverRatelimitKeySelectors(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
