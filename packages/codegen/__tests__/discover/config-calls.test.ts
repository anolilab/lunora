import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { allowUnauthenticatedShardAccessEnabled, mailInboundDispatchWithoutVerify } from "@lunora/advisor";
import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverConfigCalls from "../../src/discover/config-calls";

let workdir: string;
let project: Project;

const write = (name: string, source: string): string => {
    const path = join(workdir, "lunora", name);

    writeFileSync(path, source, "utf8");

    return path;
};

/** Write a project-relative source file outside `lunora/` — e.g. the worker entry. */
const writeAt = (relative: string, source: string): string => {
    const path = join(workdir, relative);

    mkdirSync(dirname(path), { recursive: true });
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

    // Regression: every one of these factories is built in the worker entry, never
    // under `lunora/`. A `lunora/`-only walk found zero call sites repo-wide, so
    // five ERROR-level security lints could not fire at all.
    it("discovers a config call in the worker entry, not just under lunora/", () => {
        expect.assertions(2);

        writeAt(
            "src/server/index.ts",
            `import { createInboundEmailHandler, dispatchToLunoraFunction, parseInboundEmail } from "@lunora/mail/inbound";

            export const handler = createInboundEmailHandler({
                dispatch: dispatchToLunoraFunction({ functionPath: "inbound:onEmail" }),
                parse: parseInboundEmail,
            });`,
        );

        const found = discoverConfigCalls(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ analyzable: true, callee: "createInboundEmailHandler", file: "src/server/index", presentKeys: ["dispatch", "parse"] });
    });

    // eslint-disable-next-line no-secrets/no-secrets -- an advisor rule id in a test title, not a credential
    it("feeds mail_inbound_dispatch_without_verify from a worker-entry handler", () => {
        expect.assertions(2);

        writeAt(
            "src/server/index.ts",
            `export const handler = createInboundEmailHandler({ dispatch: dispatchToLunoraFunction({}), parse: parseInboundEmail });`,
        );

        const findings = mailInboundDispatchWithoutVerify.run({ configCalls: discoverConfigCalls(project, join(workdir, "lunora")), schema: { tables: [] } });

        expect(findings).toHaveLength(1);
        // eslint-disable-next-line no-secrets/no-secrets -- an advisor rule id, not a secret
        expect(findings[0]).toMatchObject({ level: "ERROR", name: "mail_inbound_dispatch_without_verify" });
    });

    // The class-A (default Vite) path has NO worker entry to call `.extend()`
    // from, so `vite.config.*` is the only place this setting can be written —
    // and a `lunora/`-plus-entry walk saw none of it.
    it.each(["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"])("reads the lunora() plugin options from %s", (name) => {
        expect.assertions(2);

        writeAt(
            name,
            `import { lunora } from "@lunora/vite";

            export default { plugins: [lunora({ allowUnauthenticatedShardAccess: true })] };`,
        );

        const found = discoverConfigCalls(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({
            analyzable: true,
            callee: "lunora",
            file: name,
            presentKeys: ["allowUnauthenticatedShardAccess"],
            trueKeys: ["allowUnauthenticatedShardAccess"],
        });
    });

    it("fires allow_unauthenticated_shard_access_enabled from vite.config.ts alone, with no .extend() anywhere", () => {
        expect.assertions(2);

        writeAt("vite.config.ts", `export default { plugins: [lunora({ allowUnauthenticatedShardAccess: true })] };`);

        const findings = allowUnauthenticatedShardAccessEnabled.run({
            configCalls: discoverConfigCalls(project, join(workdir, "lunora")),
            schema: { tables: [] },
        });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ metadata: { callee: "lunora", file: "vite.config.ts" }, name: "allow_unauthenticated_shard_access_enabled" });
    });

    it("does not flag a vite config that leaves the opt-out off", () => {
        expect.assertions(1);

        writeAt("vite.config.ts", `export default { plugins: [lunora({ studio: false })] };`);

        const findings = allowUnauthenticatedShardAccessEnabled.run({
            configCalls: discoverConfigCalls(project, join(workdir, "lunora")),
            schema: { tables: [] },
        });

        expect(findings).toHaveLength(0);
    });

    it("does not scan client-side src/ trees outside the worker entry", () => {
        expect.assertions(1);

        writeAt("src/components/Billing.ts", `export const pay = createPayment({ provider: stripe });`);

        expect(discoverConfigCalls(project, join(workdir, "lunora"))).toHaveLength(0);
    });
});
