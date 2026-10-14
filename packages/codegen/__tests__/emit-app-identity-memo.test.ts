import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { transformSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

import { memoizeIdentity } from "../../runtime/src/memoize-identity";
import { emitApp } from "../src/emit-app";
import baseOptions from "./emit-app-options";

/**
 * The identity memo the generated worker wraps around `resolveIdentity`.
 *
 * Lifts the emitted wrap statement out of `app.ts`, compiles it against the real
 * `memoizeIdentity`, and CALLS it, so the assertions cover behaviour and not text.
 */

type Resolver = (request: Request, env?: unknown, context?: unknown) => Promise<unknown>;

const scratch = mkdtempSync(join(tmpdir(), "lunora-emit-app-identity-memo-"));

const wrap = async (inner: Resolver, env: Record<string, string> = {}): Promise<Resolver> => {
    const source = emitApp({ ...baseOptions, hasAuth: true });
    const match = /(if \(options\.resolveIdentity\) \{\n {12}const identityCacheMs[\s\S]*?\n {8}\})/u.exec(source);

    if (match?.[1] === undefined) {
        throw new Error("could not locate the emitted identity memo in app.ts");
    }

    // codeql[js/bad-code-sanitization]
    const compiled = transformSync(`export const build = (memoizeIdentity, options, env) => { ${match[1]} return options.resolveIdentity; };`, {
        loader: "ts",
    }).code;
    const file = join(scratch, `memo-${randomUUID()}.mjs`);

    writeFileSync(file, compiled);

    const loaded = (await import(pathToFileURL(file).href)) as {
        build: (memo: typeof memoizeIdentity, options: { resolveIdentity: Resolver }, env: Record<string, string>) => Resolver;
    };

    return loaded.build(memoizeIdentity, { resolveIdentity: inner }, env);
};

const withCookie = (cookie: string): Request => new Request("https://app.example/_lunora/rpc", { headers: { cookie } });

describe("emitApp — identity memoisation", () => {
    afterAll(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    it("imports memoizeIdentity only when auth is wired", () => {
        expect.assertions(2);

        expect(emitApp({ ...baseOptions, hasAuth: true })).toContain("memoizeIdentity");
        expect(emitApp(baseOptions)).not.toContain("memoizeIdentity");
    });

    it("resolves once for the same cookie, again for a different one", async () => {
        expect.assertions(3);

        let calls = 0;
        const resolve = await wrap(() => {
            calls += 1;

            return Promise.resolve({ userId: "u1" });
        });

        await resolve(withCookie("s=a"));
        await resolve(withCookie("s=a"));

        expect(calls).toBe(1);

        await resolve(withCookie("s=b"));

        expect(calls).toBe(2);
        await expect(resolve(withCookie("s=b"))).resolves.toStrictEqual({ userId: "u1" });
    });

    it("bypasses the cross-request cache when Cloudflare Access supplied the identity", async () => {
        expect.assertions(1);

        let calls = 0;
        const resolve = await wrap(() => {
            calls += 1;

            return Promise.resolve(null);
        });

        await resolve(withCookie("s=a"), {}, { access: { email: "a@b.c" } });
        await resolve(withCookie("s=a"), {}, { access: { email: "a@b.c" } });

        expect(calls).toBe(2);
    });

    it("never caches an anonymous request", async () => {
        expect.assertions(1);

        let calls = 0;
        const resolve = await wrap(() => {
            calls += 1;

            return Promise.resolve(null);
        });

        await resolve(new Request("https://app.example/x"));
        await resolve(new Request("https://app.example/x"));

        expect(calls).toBe(2);
    });

    it("a zero cache window from the env override disables the cross-request cache", async () => {
        expect.assertions(1);

        let calls = 0;
        const resolve = await wrap(
            () => {
                calls += 1;

                return Promise.resolve(null);
            },
            { LUNORA_IDENTITY_CACHE_MS: "0" },
        );

        await resolve(withCookie("s=a"));
        await resolve(withCookie("s=a"));

        expect(calls).toBe(2);
    });
});
