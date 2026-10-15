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

interface Built {
    /** One `buildWorkerOptions` pass over the emitted memo block; the builder's memo store persists across passes. */
    build: (inner: Resolver, env?: object, store?: WeakMap<object, unknown>) => Resolver;
}

type Declaration = { options: (env: unknown) => { session?: { cookieCache?: { enabled?: boolean; maxAge?: number } } } };

const defaultEnv = {};

const prepare = async (memo: typeof memoizeIdentity = memoizeIdentity, authDeclaration?: Declaration): Promise<Built> => {
    const source = emitApp({ ...baseOptions, hasAuth: true });
    const match = /(if \(options\.resolveIdentity\) \{\n[\s\S]*?\n {8}\})/u.exec(source);

    if (match?.[1] === undefined) {
        throw new Error("could not locate the emitted identity memo in app.ts");
    }

    // codeql[js/bad-code-sanitization] -- test-local literal rendered by codegen and compiled in-process, not user input
    const program = `export const build = (memoizeIdentity, identityMemos, options, env, authDeclaration) => { ${match[1]} return options.resolveIdentity; };`;
    // codeql[js/bad-code-sanitization] -- test-local literal rendered by codegen and compiled in-process, not user input
    const compiled = transformSync(program, { loader: "ts" }).code;
    const file = join(scratch, `memo-${randomUUID()}.mjs`);

    writeFileSync(file, compiled);

    const loaded = (await import(pathToFileURL(file).href)) as {
        build: (
            memo: typeof memoizeIdentity,
            identityMemos: WeakMap<object, unknown>,
            options: { resolveIdentity: Resolver },
            env: object,
            authDeclaration?: Declaration,
        ) => Resolver;
    };
    // One store per `assemble()` call; a test passes its own to model a second assembled worker.
    const assembled = new WeakMap<object, unknown>();

    return { build: (inner, env = defaultEnv, store = assembled) => loaded.build(memo, store, { resolveIdentity: inner }, env, authDeclaration) };
};

const wrap = async (
    inner: Resolver,
    env: Record<string, unknown> = {},
    memo: typeof memoizeIdentity = memoizeIdentity,
    authDeclaration?: Declaration,
): Promise<Resolver> => {
    const { build } = await prepare(memo, authDeclaration);

    return build(inner, env);
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

    it("does not cache across requests when the credential headers are oversized", async () => {
        expect.assertions(2);

        let calls = 0;
        const resolve = await wrap(() => {
            calls += 1;

            return Promise.resolve({ userId: "u1" });
        });
        // One client adding a junk cookie per request must not grow the map without bound.
        const oversized = `s=a; ${"j".repeat(5000)}=1`;

        await resolve(withCookie(oversized));
        await resolve(withCookie(oversized));

        expect(calls).toBe(2);

        // A normal-sized credential is still cached across requests.
        await resolve(withCookie("s=a"));
        await resolve(withCookie("s=a"));

        expect(calls).toBe(3);
    });

    it.each([
        ["", 60_000],
        ["  ", 60_000],
        ["0", 0],
    ])("env override %j resolves to a %i ms cache window", async (value, ttlMs) => {
        expect.assertions(1);

        const spy: { ttlMs?: number } = {};

        await wrap(() => Promise.resolve(null), { LUNORA_IDENTITY_CACHE_MS: value }, ((inner: Resolver, o: { ttlMs: number }) => {
            spy.ttlMs = o.ttlMs;

            return inner;
        }) as unknown as typeof memoizeIdentity);

        expect(spy.ttlMs).toBe(ttlMs);
    });

    it.each([
        [0, 0],
        [30_000, 30_000],
        [-5, 60_000],
    ])("a numeric wrangler var %j resolves to a %i ms cache window instead of throwing", async (value, ttlMs) => {
        expect.assertions(1);

        const spy: { ttlMs?: number } = {};

        await wrap(() => Promise.resolve(null), { LUNORA_IDENTITY_CACHE_MS: value }, ((inner: Resolver, o: { ttlMs: number }) => {
            spy.ttlMs = o.ttlMs;

            return inner;
        }) as unknown as typeof memoizeIdentity);

        expect(spy.ttlMs).toBe(ttlMs);
    });

    it("keys the cross-request cache on x-api-key as well as the cookie", async () => {
        expect.assertions(2);

        let calls = 0;
        const resolve = await wrap(() => {
            calls += 1;

            return Promise.resolve({ userId: `u${String(calls)}` });
        });
        const withKey = (key: string): Request => new Request("https://app.example/x", { headers: { cookie: "s=a", "x-api-key": key } });

        await resolve(withKey("k1"));
        await resolve(withKey("k2"));

        expect(calls).toBe(2);

        await resolve(withKey("k1"));

        expect(calls).toBe(2);
    });

    describe("strict session preset", () => {
        const strict: Declaration = {
            options: () => {
                return { session: { cookieCache: { enabled: false } } };
            },
        };
        const rolling: Declaration = {
            options: () => {
                return { session: { cookieCache: { enabled: true, maxAge: 60 } } };
            },
        };

        const ttlFor = async (declaration: Declaration | undefined, env: Record<string, unknown>): Promise<number | undefined> => {
            const spy: { ttlMs?: number } = {};

            await wrap(
                () => Promise.resolve(null),
                env,
                ((inner: Resolver, o: { ttlMs: number }) => {
                    spy.ttlMs = o.ttlMs;

                    return inner;
                }) as unknown as typeof memoizeIdentity,
                declaration,
            );

            return spy.ttlMs;
        };

        it("defaults to per-request memoisation when the cookie cache is off", async () => {
            expect.assertions(1);

            await expect(ttlFor(strict, {})).resolves.toBe(0);
        });

        it("keeps the 60s default when the cookie cache is on, or no policy is declared", async () => {
            expect.assertions(2);

            await expect(ttlFor(rolling, {})).resolves.toBe(60_000);
            await expect(ttlFor(undefined, {})).resolves.toBe(60_000);
        });

        it("falls back to per-request memoisation when the options callback throws", async () => {
            expect.assertions(1);

            const throwing: Declaration = {
                options: () => {
                    throw new Error("boom");
                },
            };

            // A 60s fallback would keep a revoked session resolving for a minute under the
            // strict preset; per-request is the safe default, and construction still succeeds.
            await expect(ttlFor(throwing, {})).resolves.toBe(0);
        });

        it.each([
            [{ enabled: true, maxAge: 10 }, 10_000],
            [{ enabled: true }, 60_000],
            [{ enabled: true, maxAge: 600 }, 60_000],
            [{ enabled: false, maxAge: 10 }, 0],
            [{ maxAge: 30 }, 0],
            [undefined, 60_000],
        ])("cookie cache %j defaults the window to %i ms", async (cookieCache, ttlMs) => {
            expect.assertions(1);

            await expect(
                ttlFor(
                    {
                        options: () => {
                            return { session: { cookieCache } };
                        },
                    },
                    {},
                ),
            ).resolves.toBe(ttlMs);
        });

        it("lets an explicit env value override a short cookie-cache max age", async () => {
            expect.assertions(1);

            await expect(
                ttlFor(
                    {
                        options: () => {
                            return { session: { cookieCache: { enabled: true, maxAge: 10 } } };
                        },
                    },
                    { LUNORA_IDENTITY_CACHE_MS: "45000" },
                ),
            ).resolves.toBe(45_000);
        });

        it("still honours an explicit LUNORA_IDENTITY_CACHE_MS under the strict preset", async () => {
            expect.assertions(2);

            await expect(ttlFor(strict, { LUNORA_IDENTITY_CACHE_MS: "5000" })).resolves.toBe(5000);
            await expect(ttlFor(strict, { LUNORA_IDENTITY_CACHE_MS: "  " })).resolves.toBe(0);
        });
    });

    describe("framework-hosted rebuilds", () => {
        it("shares one resolver call across option builds that see the same env", async () => {
            expect.assertions(2);

            let calls = 0;
            const resolver: Resolver = () => {
                calls += 1;

                return Promise.resolve({ userId: "u1" });
            };
            const { build } = await prepare();
            const env = {};

            // A framework-hosted worker rebuilds its options (and so the inner resolver) per request.
            await build(resolver, env)(withCookie("s=a"));
            await build(resolver, env)(withCookie("s=a"));

            expect(calls).toBe(1);

            // A request-selected environment is a different object and stays separate.
            await build(resolver, {})(withCookie("s=a"));

            expect(calls).toBe(2);
        });

        it("reads the session policy once per env, not once per build", async () => {
            expect.assertions(1);

            let reads = 0;
            const declaration: Declaration = {
                options: () => {
                    reads += 1;

                    return { session: { cookieCache: { enabled: false } } };
                },
            };
            const { build } = await prepare(memoizeIdentity, declaration);
            const env = {};

            build(() => Promise.resolve(null), env);
            build(() => Promise.resolve(null), env);
            build(() => Promise.resolve(null), env);

            expect(reads).toBe(1);
        });

        it("gives each assembled worker its own memo, even for the same env", async () => {
            expect.assertions(2);

            const calls: string[] = [];
            const resolverFor =
                (worker: string): Resolver =>
                () => {
                    calls.push(worker);

                    return Promise.resolve({ userId: worker });
                };
            const { build } = await prepare();
            const env = {};
            const first = new WeakMap<object, unknown>();
            const second = new WeakMap<object, unknown>();

            await build(resolverFor("first"), env, first)(withCookie("s=a"));
            await build(resolverFor("second"), env, second)(withCookie("s=a"));

            // Each worker resolved through its own auth closure.
            expect(calls).toStrictEqual(["first", "second"]);

            await build(resolverFor("first"), env, first)(withCookie("s=a"));

            expect(calls).toHaveLength(2);
        });

        it("declares the memo store per assemble() call, not on the builder", () => {
            expect.assertions(4);

            const source = emitApp({ ...baseOptions, hasAuth: true });
            const assemble = source.slice(source.indexOf("private assemble("), source.indexOf("private buildWorkerOptions("));

            expect(assemble).toContain("const identityMemos: IdentityMemoStore = new WeakMap()");
            expect(source).toContain("type IdentityMemoStore = WeakMap<object, ReturnType<typeof memoizeIdentity>>");
            expect(source).not.toContain("no-secrets");
            expect(source).not.toContain("private readonly identityMemos");
        });
    });
});
