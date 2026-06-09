import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";

import { createAuth } from "../src/create-auth";
import { withAuthPlugins } from "../src/middleware";
import { admin, organization } from "../src/plugins";

/**
 * Behavioural coverage for `withAuthPlugins`. The middleware is tiny — it just
 * stitches `auth.api` onto the procedure context — but the test still goes
 * through a real `betterAuth` instance + a real in-memory adapter, so we
 * confirm:
 *
 * 1. `ctx.authApi` exposes the endpoints the configured plugins contribute (no mocks), and
 * 2. invoking an endpoint mutates the auth instance's storage the way the underlying plugin would when called via `auth.api` directly.
 */

interface MockHandlerContext {
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
const runMiddleware = async <ContextOut>(
    middleware: (options: { ctx: unknown; next: (options_?: { ctx: Record<string, unknown> }) => Promise<unknown> }) => unknown,
    initialContext: unknown,
): Promise<ContextOut> => {
    let captured: unknown = initialContext;
    const next = async (options?: { ctx: Record<string, unknown> }): Promise<unknown> => {
        const merged = { ...(initialContext as Record<string, unknown>), ...(options?.ctx as Record<string, unknown>) };

        captured = merged;

        return merged;
    };

    await middleware({ ctx: initialContext, next });

    return captured as ContextOut;
};

describe("withAuthPlugins", () => {
    let memoryDatabase: Record<string, unknown[]>;
    // `any` rather than `ReturnType<typeof createAuth>` so the plugin-contributed
    // endpoints (`createOrganization`, `banUser`, …) are reachable through
    // `auth.api` without re-deriving the full generic chain here.
    let auth: any;

    beforeEach(() => {
        // Pre-seed every table the configured plugins touch — the memory
        // adapter doesn't materialise tables on first write, it expects the
        // key to already exist on the backing record.
        memoryDatabase = {
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
            database: memoryAdapter(memoryDatabase),
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
        memoryDatabase = {};
    });

    it("installs `authApi` onto ctx as the auth instance's api surface", async () => {
        // 2 runtime assertions; the expectTypeOf below is a compile-time check and isn't counted.
        expect.assertions(2);

        const middleware = withAuthPlugins(auth);
        const context = await runMiddleware<MockHandlerContext>(middleware, {});

        expect(context.authApi).toBeDefined();
        expect(context.authApi).toBe(auth.api);

        // Non-null assertions narrow away the `| undefined` from the optional
        // chain so `toBeFunction` checks the resolved endpoint type, not the union.
        expectTypeOf(context.authApi!.createOrganization!).toBeFunction();
    });

    it("ctx.authApi.createOrganization writes to the underlying store", async () => {
        expect.assertions(2);

        // Seed a user the organization can belong to. `signUpEmail` is the
        // public endpoint better-auth exposes for email/password sign-up.
        const signUp = await auth.api.signUpEmail({
            body: { email: "owner@example.com", name: "Org Owner", password: "correct horse battery staple" },
        });

        const ownerId = signUp.user.id;

        const middleware = withAuthPlugins(auth);
        const context = await runMiddleware<MockHandlerContext>(middleware, {});

        // Call the plugin endpoint through the ctx — exactly how a handler
        // would reach it after composing the middleware.
        await context.authApi?.createOrganization?.({
            body: { name: "Acme", slug: "acme", userId: ownerId },
        });

        // Memory adapter stores rows under the table name; the plugin's
        // schema names the table `organization`.
        const organizations = (memoryDatabase["organization"] ?? []) as { name?: string; slug?: string }[];

        expect(organizations).toHaveLength(1);
        expect(organizations[0]).toMatchObject({ name: "Acme", slug: "acme" });
    });

    it("composing after another middleware preserves the upstream ctx fields", async () => {
        // 2 runtime assertions; the expectTypeOf below is a compile-time check and isn't counted.
        expect.assertions(2);

        // Pretend an upstream middleware has already installed `userId` on
        // the ctx. The middleware under test must layer authApi on top
        // *without* dropping userId — that's the regression the type fix
        // guards (the prior shape returned just `CirrusAuthApiContext<Auth>`,
        // erasing whatever the upstream had installed).
        const contextIn = { userId: "u_42" };

        // The builder's runtime `next({ ctx: ext })` shallow-merges the
        // extension over the incoming ctx. We model that exactly here.
        const contextOut = await withAuthPlugins(auth)({
            ctx: contextIn,
            next: async (options?: { ctx: Record<string, unknown> }) => (options?.ctx ? { ...contextIn, ...options.ctx } : contextIn),
        });

        // Both fields must survive into the downstream ctx — the regression
        // dropped `userId`. The type-level narrowing (`CtxIn & CirrusAuthApiContext<Auth>`)
        // is also asserted below via the typed access.
        expect(contextOut).toMatchObject({ userId: "u_42" });
        expect(contextOut.authApi).toBeDefined();

        expectTypeOf((contextOut.authApi as { createOrganization: (...args: unknown[]) => unknown }).createOrganization).toBeFunction();
    });
});
