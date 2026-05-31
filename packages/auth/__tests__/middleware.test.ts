import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, beforeEach, describe, expect, expectTypeOf, test } from "vitest";

import { createAuth } from "../src/create-auth.js";
import { withAuthPlugins } from "../src/middleware.js";
import { admin, organization } from "../src/plugins.js";

/**
 * Behavioural coverage for `withAuthPlugins`. The middleware is tiny — it just
 * stitches `auth.api` onto the procedure context — but the test still goes
 * through a real `betterAuth` instance + a real in-memory adapter, so we
 * confirm:
 *
 * 1. `ctx.authApi` exposes the endpoints the configured plugins contribute
 *    (no mocks), and
 * 2. invoking an endpoint mutates the auth instance's storage the way the
 *    underlying plugin would when called via `auth.api` directly.
 */

interface MockHandlerCtx {
    authApi?: Record<string, unknown> & {
        createOrganization?: (...args: unknown[]) => Promise<unknown>;
    };
}

const SECRET = "x".repeat(32);

/**
 * Drive a middleware the same way `@cirrus/server`'s builder runs them:
 * `next({ ctx })` returns the merged context, and the middleware's return
 * value becomes what the handler eventually sees.
 *
 * Typed as `unknown` for both `middleware` and `initialCtx` because the
 * middleware's signature is internal-shape-specific; the test only cares
 * about the runtime contract.
 */
const runMiddleware = async <CtxOut>(
    middleware: (options: { ctx: unknown; next: (opts?: { ctx: Record<string, unknown> }) => Promise<unknown> }) => unknown,
    initialCtx: unknown,
): Promise<CtxOut> => {
    let captured: unknown = initialCtx;
    const next = async (opts?: { ctx: Record<string, unknown> }): Promise<unknown> => {
        const merged = { ...(initialCtx as Record<string, unknown>), ...(opts?.ctx as Record<string, unknown>) };

        captured = merged;

        return merged;
    };

    await middleware({ ctx: initialCtx, next });

    return captured as CtxOut;
};

describe("withAuthPlugins", () => {
    let memoryDb: Record<string, unknown[]>;
    // `any` rather than `ReturnType<typeof createAuth>` so the plugin-contributed
    // endpoints (`createOrganization`, `banUser`, …) are reachable through
    // `auth.api` without re-deriving the full generic chain here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let auth: any;

    beforeEach(() => {
        // Pre-seed every table the configured plugins touch — the memory
        // adapter doesn't materialise tables on first write, it expects the
        // key to already exist on the backing record.
        memoryDb = {
            account: [],
            invitation: [],
            member: [],
            organization: [],
            session: [],
            team: [],
            user: [],
            verification: [],
        };
        auth = createAuth({
            baseURL: "http://localhost",
            database: memoryAdapter(memoryDb),
            emailAndPassword: { enabled: true },
            plugins: [organization(), admin()],
            secret: SECRET,
        });

        // The in-memory adapter materialises rows in-place, so no migration
        // pass is needed here. A real D1 wiring would call `ensureMigrated`
        // at boot time, but better-auth's migration runner only supports the
        // kysely adapter — so we don't exercise it under memory.
    });

    afterEach(() => {
        // Memory adapter rows live on `memoryDb`, scoped per test — nothing to
        // tear down explicitly, but resetting the reference helps reveal
        // leaks if a test accidentally captures the previous instance.
        memoryDb = {};
    });

    test("installs `authApi` onto ctx as the auth instance's api surface", async () => {
        expect.assertions(3);

        const middleware = withAuthPlugins(auth);
        const ctx = await runMiddleware<MockHandlerCtx>(middleware as unknown as Parameters<typeof runMiddleware>[0], {});

        expect(ctx.authApi).toBeDefined();
        expect(ctx.authApi).toBe(auth.api);

        expectTypeOf(ctx.authApi?.createOrganization).toBeFunction();
    });

    test("ctx.authApi.createOrganization writes to the underlying store", async () => {
        expect.assertions(2);

        // Seed a user the organization can belong to. `signUpEmail` is the
        // public endpoint better-auth exposes for email/password sign-up.
        const signUp = await auth.api.signUpEmail({
            body: { email: "owner@example.com", name: "Org Owner", password: "correct horse battery staple" },
        });

        const ownerId = signUp.user.id;

        const middleware = withAuthPlugins(auth);
        const ctx = await runMiddleware<MockHandlerCtx>(middleware as unknown as Parameters<typeof runMiddleware>[0], {});

        // Call the plugin endpoint through the ctx — exactly how a handler
        // would reach it after composing the middleware.
        await ctx.authApi?.createOrganization?.({
            body: { name: "Acme", slug: "acme", userId: ownerId },
        });

        // Memory adapter stores rows under the table name; the plugin's
        // schema names the table `organization`.
        const organizations = (memoryDb["organization"] ?? []) as Array<{ name?: string; slug?: string }>;

        expect(organizations).toHaveLength(1);
        expect(organizations[0]).toMatchObject({ name: "Acme", slug: "acme" });
    });

    test("composing after another middleware preserves the upstream ctx fields", async () => {
        expect.assertions(3);

        // Pretend an upstream middleware has already installed `userId` on
        // the ctx. The middleware under test must layer authApi on top
        // *without* dropping userId — that's the regression the type fix
        // guards (the prior shape returned just `CirrusAuthApiContext<Auth>`,
        // erasing whatever the upstream had installed).
        const ctxIn = { userId: "u_42" };

        // The builder's runtime `next({ ctx: ext })` shallow-merges the
        // extension over the incoming ctx. We model that exactly here.
        const ctxOut = await withAuthPlugins(auth)({
            ctx: ctxIn,
            next: (async (options?: { ctx: Record<string, unknown> }) => {
                return options?.ctx ? { ...ctxIn, ...options.ctx } : ctxIn;
            }) as Parameters<ReturnType<typeof withAuthPlugins<typeof auth>>>[0]["next"],
        });

        // Both fields must survive into the downstream ctx — the regression
        // dropped `userId`. The type-level narrowing (`CtxIn & CirrusAuthApiContext<Auth>`)
        // is also asserted at compile time below via the typed access.
        expect(ctxOut).toMatchObject({ userId: "u_42" });
        expect(ctxOut.authApi).toBeDefined();

        expectTypeOf((ctxOut.authApi as { createOrganization?: unknown }).createOrganization).toBeFunction();
    });
});
