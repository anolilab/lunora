import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { transformSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

import { emitApp } from "../src/emit-app";

/**
 * The identity `.auth({ d1 })` resolves for the generated worker.
 *
 * Every other emit test asserts substrings. That is exactly how the emitted
 * resolver shipped without a credential expiry: `x-lunora-identity-exp` is what
 * lets the Durable Object drop a socket whose session has lapsed, and nothing
 * ever ran the emitted resolver to see whether it produced one. So this suite
 * lifts the resolver out of the emitted `app.ts`, compiles it, and CALLS it —
 * the assertions are over a real return value, not over the source text.
 */

/** Minimal `EmitAppOptions` with every capability off; these tests only turn auth on. */
const baseOptions = {
    hasAccess: false,
    hasAi: false,
    hasAnalytics: false,
    hasAuth: false,
    hasBrowser: false,
    hasFramework: false,
    hasGlobal: false,
    hasHyperdrive: false,
    hasHyperdriveGlobal: false,
    hasImages: false,
    hasKv: false,
    hasKvIntrospector: false,
    hasNotify: false,
    hasPayments: false,
    hasQueue: false,
    hasR2sql: false,
    hasScheduler: false,
    hasStorage: false,
    hasVectors: false,
    hasWorkflow: false,
    hasX402: false,
    tableNames: [],
    useUmbrella: false,
    wantsOpenApi: false,
    wantsOpenRpc: false,
};

/** What better-auth's `getSession` answers with, as the emitted resolver consumes it. */
interface SessionDouble {
    session: { expiresAt: Date };
    user: { email?: string; id: string; name?: string; role?: string };
}

type EmittedResolver = (request: Request) => Promise<Record<string, unknown> | null>;

const scratch = mkdtempSync(join(tmpdir(), "lunora-emit-app-auth-"));

/**
 * Compile the emitted D1-mode `resolveIdentity` and load it as a real module.
 *
 * `getAuth` is a closure variable in the generated worker, so the wrapper takes
 * it as a parameter — that is the resolver's only free binding.
 */
const emittedD1Resolver = async (session: SessionDouble | null): Promise<EmittedResolver> => {
    const source = emitApp({ ...baseOptions, hasAuth: true });
    const match = /options\.resolveIdentity = (async \(request\) => \{[\s\S]*?\n {12}\});/u.exec(source);

    if (match?.[1] === undefined) {
        throw new Error("could not locate the emitted D1 `resolveIdentity` in app.ts");
    }

    // The "improperly sanitized value" CodeQL flags here is this repo's own
    // codegen output: `emitApp` is called two lines up with a frozen literal
    // options object, so nothing outside this file reaches the string. Compiling
    // and CALLING that output is the whole point of the suite — the assertions
    // have to be over a real return value rather than a substring of emitted
    // text, which is how the resolver shipped without a credential expiry — so
    // there is no restructuring that removes the sink and keeps the test. The
    // suppression is scoped to this one query on this one line.
    // codeql[js/bad-code-sanitization]
    const compiled = transformSync(`export const build = (getAuth) => (${match[1]});`, { loader: "ts" }).code;

    const file = join(scratch, `resolver-${randomUUID()}.mjs`);

    writeFileSync(file, compiled);

    const loaded = (await import(pathToFileURL(file).href)) as { build: (getAuth: () => unknown) => EmittedResolver };

    return loaded.build(() => {
        return { api: { getSession: () => Promise.resolve(session) } };
    });
};

const request = (): Request => new Request("https://app.example/_lunora/rpc", { headers: { cookie: "session=abc" } });

describe("emitApp — the emitted `.auth({ d1 })` identity resolver", () => {
    afterAll(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    it("forwards the session expiry, so a lapsed credential closes an open socket", async () => {
        expect.assertions(2);

        const expiresAt = new Date(Date.now() + 3_600_000);
        const resolve = await emittedD1Resolver({ session: { expiresAt }, user: { id: "u1" } });

        const identity = await resolve(request());

        // `expiresAtMs` (epoch MILLISECONDS) is what the runtime forwards as
        // `x-lunora-identity-exp`. Without it the DO's `isSocketExpired` check is
        // permanently false and a signed-out / banned user keeps streaming rows.
        expect(identity).toMatchObject({ userId: "u1" });
        expect(identity?.["expiresAtMs"]).toBe(expiresAt.getTime());
    });

    it("forwards the session's email and name, the claims `getIdentity()` is documented to carry", async () => {
        expect.assertions(1);

        const resolve = await emittedD1Resolver({
            session: { expiresAt: new Date(Date.now() + 1000) },
            user: { email: "ada@acme.test", id: "u1", name: "Ada" },
        });

        // The documented `me` query is `identity?.email`. Forwarding only
        // `{ expiresAtMs, role, userId }` shipped a null email on every app that
        // used the built-in `.auth({ d1 })` wiring.
        await expect(resolve(request())).resolves.toMatchObject({ email: "ada@acme.test", name: "Ada" });
    });

    it("omits email and name a session does not carry, rather than forwarding empty claims", async () => {
        expect.assertions(2);

        const resolve = await emittedD1Resolver({ session: { expiresAt: new Date(Date.now() + 1000) }, user: { email: "", id: "u1" } });
        const identity = await resolve(request());

        expect(identity).not.toHaveProperty("email");
        expect(identity).not.toHaveProperty("name");
    });

    it("forwards the admin-plugin role, so RLS role grants apply", async () => {
        expect.assertions(1);

        const resolve = await emittedD1Resolver({ session: { expiresAt: new Date(Date.now() + 1000) }, user: { id: "u1", role: "admin,editor" } });

        await expect(resolve(request())).resolves.toMatchObject({ role: "admin,editor" });
    });

    it("resolves an anonymous request to null", async () => {
        expect.assertions(1);

        const resolve = await emittedD1Resolver(null);

        await expect(resolve(request())).resolves.toBeNull();
    });
});
