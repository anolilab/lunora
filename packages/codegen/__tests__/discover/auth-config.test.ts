import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { authTrustedOriginsWildcard } from "@lunora/advisor";
import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import discoverAuthConfig from "../../src/discover/auth-config";

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

describe("discoverAuthConfig", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-auth-config-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        project = new Project({ skipAddingFilesFromTsConfig: true, useInMemoryFileSystem: false });
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("flags a wildcard trustedOrigins entry", () => {
        expect.assertions(2);

        write("auth.ts", `export const auth = createAuth({ secret: "x", trustedOrigins: ["https://example.com", "*"] });`);

        const found = discoverAuthConfig(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ analyzable: true, exportName: "auth", file: "auth", line: 1, trustedOriginsWildcard: true });
    });

    it("ignores trustedOrigins without a wildcard entry", () => {
        expect.assertions(1);

        write("auth.ts", `export const auth = createAuth({ secret: "x", trustedOrigins: ["https://example.com"] });`);

        expect(discoverAuthConfig(project, join(workdir, "lunora"))[0]).toMatchObject({ trustedOriginsWildcard: false });
    });

    it("flags advanced.disableCSRFCheck === true", () => {
        expect.assertions(1);

        write("auth.ts", `export const auth = createAuth({ secret: "x", advanced: { disableCSRFCheck: true } });`);

        expect(discoverAuthConfig(project, join(workdir, "lunora"))[0]).toMatchObject({ disableCsrfCheck: true });
    });

    it("flags advanced.useSecureCookies === false", () => {
        expect.assertions(1);

        write("auth.ts", `export const auth = createAuth({ secret: "x", advanced: { useSecureCookies: false } });`);

        expect(discoverAuthConfig(project, join(workdir, "lunora"))[0]).toMatchObject({ secureCookiesDisabled: true });
    });

    it("flags emailAndPassword.enabled without requireEmailVerification", () => {
        expect.assertions(1);

        write("auth.ts", `export const auth = createAuth({ secret: "x", emailAndPassword: { enabled: true } });`);

        expect(discoverAuthConfig(project, join(workdir, "lunora"))[0]).toMatchObject({ emailPasswordEnabled: true, requireEmailVerification: false });
    });

    it("does not flag emailAndPassword when requireEmailVerification is also true", () => {
        expect.assertions(1);

        write("auth.ts", `export const auth = createAuth({ secret: "x", emailAndPassword: { enabled: true, requireEmailVerification: true } });`);

        expect(discoverAuthConfig(project, join(workdir, "lunora"))[0]).toMatchObject({ emailPasswordEnabled: true, requireEmailVerification: true });
    });

    it("flags session.freshAge === 0", () => {
        expect.assertions(1);

        write("auth.ts", `export const auth = createAuth({ secret: "x", session: { freshAge: 0 } });`);

        expect(discoverAuthConfig(project, join(workdir, "lunora"))[0]).toMatchObject({ sessionFreshAgeZero: true });
    });

    it("does not flag a non-zero session.freshAge", () => {
        expect.assertions(1);

        write("auth.ts", `export const auth = createAuth({ secret: "x", session: { freshAge: 3600 } });`);

        expect(discoverAuthConfig(project, join(workdir, "lunora"))[0]).toMatchObject({ sessionFreshAgeZero: false });
    });

    it("yields all-false facts for a clean, hardened config", () => {
        expect.assertions(1);

        write(
            "auth.ts",
            `export const auth = createAuth({
                secret: "x",
                trustedOrigins: ["https://example.com"],
                advanced: { disableCSRFCheck: false, useSecureCookies: true },
                emailAndPassword: { enabled: true, requireEmailVerification: true },
                session: { freshAge: 3600 },
            });`,
        );

        expect(discoverAuthConfig(project, join(workdir, "lunora"))[0]).toMatchObject({
            analyzable: true,
            disableCsrfCheck: false,
            emailPasswordEnabled: true,
            requireEmailVerification: true,
            secureCookiesDisabled: false,
            sessionFreshAgeZero: false,
            trustedOriginsWildcard: false,
        });
    });

    it("marks a spread-assembled config analyzable:false with every fact at its safe default", () => {
        expect.assertions(2);

        write("auth.ts", `const base = { secret: "x" }; export const auth = createAuth({ ...base, trustedOrigins: ["*"] });`);

        const found = discoverAuthConfig(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({
            analyzable: false,
            disableCsrfCheck: false,
            emailPasswordEnabled: false,
            requireEmailVerification: false,
            secureCookiesDisabled: false,
            sessionFreshAgeZero: false,
            trustedOriginsWildcard: false,
        });
    });

    it("marks a non-object-literal config argument analyzable:false", () => {
        expect.assertions(1);

        write("auth.ts", `const options = buildOptions(); export const auth = createAuth(options);`);

        expect(discoverAuthConfig(project, join(workdir, "lunora"))[0]).toMatchObject({ analyzable: false });
    });

    it("ignores a call to a differently-named function", () => {
        expect.assertions(1);

        write("other.ts", `export const auth = createSomethingElse({ trustedOrigins: ["*"] });`);

        expect(discoverAuthConfig(project, join(workdir, "lunora"))).toHaveLength(0);
    });

    it("flags scim() paired with an adapter that has no native transactions", () => {
        expect.assertions(2);

        write("auth.ts", `export const auth = createAuth({ secret: "x", database: lunoraD1Adapter(env.DB), plugins: [scim({ connections: [] }), admin()] });`);

        const found = discoverAuthConfig(project, join(workdir, "lunora"));

        // The pairing throws on the first SCIM request, and it is visible statically —
        // this is the fact `auth_scim_without_transactions` fires on.
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ analyzable: true, scimOnNonTransactionalAdapter: true });
    });

    it("does not flag scim() on an adapter that does have transactions", () => {
        expect.assertions(1);

        write("auth.ts", `export const auth = createAuth({ secret: "x", database: lunoraDoAdapter(state.storage), plugins: [scim({ connections: [] })] });`);

        const found = discoverAuthConfig(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ scimOnNonTransactionalAdapter: false });
    });

    it("does not flag a D1 adapter without scim()", () => {
        expect.assertions(1);

        write("auth.ts", `export const auth = createAuth({ secret: "x", database: lunoraD1Adapter(env.DB), plugins: [admin()] });`);

        const found = discoverAuthConfig(project, join(workdir, "lunora"));

        expect(found[0]).toMatchObject({ scimOnNonTransactionalAdapter: false });
    });

    // `createAuth` is built in the worker entry by convention (the shape
    // `examples/blog/src/server/index.ts` uses), never under `lunora/`. A
    // `lunora/`-only walk saw no call site there, so every `auth_*` lint
    // reported clean on a real app.
    it("discovers a createAuth built in the worker entry, not just under lunora/", () => {
        expect.assertions(2);

        writeAt("src/server/index.ts", `export const auth = createAuth({ secret: "x", trustedOrigins: ["*"] });`);

        const found = discoverAuthConfig(project, join(workdir, "lunora"));

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ analyzable: true, exportName: "auth", file: "src/server/index", trustedOriginsWildcard: true });
    });

    it("feeds auth_trusted_origins_wildcard from a worker-entry createAuth", () => {
        expect.assertions(2);

        writeAt("src/server/index.ts", `export const auth = createAuth({ secret: "x", trustedOrigins: ["*"] });`);

        const findings = authTrustedOriginsWildcard.run({ authConfigs: discoverAuthConfig(project, join(workdir, "lunora")), schema: { tables: [] } });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ name: "auth_trusted_origins_wildcard" });
    });
});
