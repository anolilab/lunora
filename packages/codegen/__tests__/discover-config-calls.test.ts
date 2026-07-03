import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverConfigCalls from "../src/discover-config-calls";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

describe("discoverConfigCalls", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-config-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records a createPayment without authorize as analyzable with the present keys", () => {
        expect.assertions(2);

        write("billing.ts", `export const pay = createPayment({ provider: stripe, reference: "sub_1" });`);

        const found = discoverConfigCalls(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ analyzable: true, callee: "createPayment", file: "billing", presentKeys: ["provider", "reference"], trueKeys: [] });
    });

    it("records shorthand and method properties as present keys", () => {
        expect.assertions(1);

        write("email.ts", `export const inbound = createInboundEmailHandler({ parse, verify() { return true; } });`);

        const found = discoverConfigCalls(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ analyzable: true, callee: "createInboundEmailHandler", presentKeys: ["parse", "verify"] });
    });

    it("records a `new RateLimiter({...})` construction", () => {
        expect.assertions(1);

        write("limits.ts", `export const limiter = new RateLimiter({ limits: {}, store: kvStore });`);

        const found = discoverConfigCalls(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ callee: "RateLimiter", presentKeys: ["limits", "store"] });
    });

    it("captures a boolean-true key in trueKeys", () => {
        expect.assertions(1);

        write("scrape.ts", `export const b = createBrowser({ binding: env.BROWSER, allowPrivateTargets: true });`);

        const found = discoverConfigCalls(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ callee: "createBrowser", presentKeys: ["binding", "allowPrivateTargets"], trueKeys: ["allowPrivateTargets"] });
    });

    it("marks a non-object config argument as not analyzable", () => {
        expect.assertions(1);

        write("opaque.ts", `export const pay = createPayment(config);`);

        const found = discoverConfigCalls(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ analyzable: false, callee: "createPayment", presentKeys: [] });
    });

    it("marks a spread config as not analyzable (keys may come from elsewhere)", () => {
        expect.assertions(1);

        write("spread.ts", `export const pay = createPayment({ ...base, reference: "x" });`);

        const found = discoverConfigCalls(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ analyzable: false, callee: "createPayment" });
    });

    it("ignores calls to unrelated callees", () => {
        expect.assertions(1);

        write("noise.ts", `export const x = createSomethingElse({ a: 1 }); export const y = new Map();`);

        const found = discoverConfigCalls(project, join(workdir, "lunora"));

        expect(found).toHaveLength(0);
    });

    it("reads a .extend() concise-body callback's returned object literal (the defineApp() escape hatch)", () => {
        expect.assertions(1);

        write("server.ts", `defineApp().shard((env) => env.SHARD).extend(() => ({ allowUnauthenticatedShardAccess: true }));`);

        const found = discoverConfigCalls(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({
            analyzable: true,
            callee: "extend",
            presentKeys: ["allowUnauthenticatedShardAccess"],
            trueKeys: ["allowUnauthenticatedShardAccess"],
        });
    });

    it("reads a .extend() block-body callback's `return {...}` statement", () => {
        expect.assertions(1);

        write("server.ts", `defineApp().extend((env, derived) => { return { allowUnauthenticatedShardAccess: true }; });`);

        const found = discoverConfigCalls(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ analyzable: true, callee: "extend", trueKeys: ["allowUnauthenticatedShardAccess"] });
    });

    it("marks a .extend() callback whose body isn't statically an object literal as not analyzable", () => {
        expect.assertions(1);

        write("server.ts", `defineApp().extend((env, derived) => buildOptions(env, derived));`);

        const found = discoverConfigCalls(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ analyzable: false, callee: "extend", presentKeys: [] });
    });

    it("marks a .extend() call with a non-callback argument as not analyzable", () => {
        expect.assertions(1);

        write("server.ts", `defineApp().extend(preset);`);

        const found = discoverConfigCalls(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ analyzable: false, callee: "extend", presentKeys: [] });
    });
});
