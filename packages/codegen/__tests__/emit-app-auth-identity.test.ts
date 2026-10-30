import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { transformSync } from "esbuild";
import { afterAll, describe, expect, it, vi } from "vitest";

import { emitApp } from "../src/emit-app";
import baseOptions from "./emit-app-options";

/**
 * The identity `.auth({ d1 })` resolves for the generated worker.
 *
 * Every other emit test asserts substrings, which is how the emitted resolver once
 * shipped without a credential expiry. So this suite lifts the resolver out of the
 * emitted `app.ts`, compiles it, and CALLS it. The claims themselves come from
 * `@lunora/auth`'s `resolveSessionIdentity` (tested there, shared with the DO wiring);
 * what is asserted here is that the emitted code hands it the auth instance and the
 * request headers and returns its answer.
 */

type EmittedResolver = (request: Request) => Promise<Record<string, unknown> | null>;

const scratch = mkdtempSync(join(tmpdir(), "lunora-emit-app-auth-"));

/**
 * Compile the emitted D1-mode `resolveIdentity` and load it as a real module.
 *
 * `getAuth` and `resolveSessionIdentity` are closure variables in the generated worker
 * (the latter destructured from the lazily imported auth module), so the wrapper
 * takes them as parameters — they are the resolver's only free bindings.
 */
const emittedD1Resolver = async (getAuth: () => unknown, resolveSessionIdentity: (auth: unknown, headers: Headers) => unknown): Promise<EmittedResolver> => {
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
    const compiled = transformSync(`export const build = (getAuth, resolveSessionIdentity) => (${match[1]});`, { loader: "ts" }).code;

    const file = join(scratch, `resolver-${randomUUID()}.mjs`);

    writeFileSync(file, compiled);

    const loaded = (await import(pathToFileURL(file).href)) as {
        build: (getAuth: () => unknown, resolveSessionIdentity: (auth: unknown, headers: Headers) => unknown) => EmittedResolver;
    };

    return loaded.build(getAuth, resolveSessionIdentity);
};

const request = (): Request => new Request("https://app.example/_lunora/rpc", { headers: { cookie: "session=abc" } });

describe("emitApp — the emitted `.auth({ d1 })` identity resolver", () => {
    afterAll(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    it("resolves the identity from the request's own headers through resolveSessionIdentity", async () => {
        expect.assertions(3);

        const auth = { api: {} };
        const resolveSessionIdentity = vi.fn<(input: unknown, headers: Headers) => unknown>(() => {
            return { orgId: "org-1", userId: "u1" };
        });
        const resolve = await emittedD1Resolver(() => auth, resolveSessionIdentity);

        await expect(resolve(request())).resolves.toStrictEqual({ orgId: "org-1", userId: "u1" });
        expect(resolveSessionIdentity.mock.calls[0]?.[0]).toBe(auth);
        expect(resolveSessionIdentity.mock.calls[0]?.[1].get("cookie")).toBe("session=abc");
    });

    it("is anonymous while the auth instance is unavailable", async () => {
        expect.assertions(2);

        const resolveSessionIdentity = vi.fn<(input: unknown) => unknown>();
        const resolve = await emittedD1Resolver(() => undefined, resolveSessionIdentity);

        await expect(resolve(request())).resolves.toBeNull();
        expect(resolveSessionIdentity).not.toHaveBeenCalled();
    });
});
