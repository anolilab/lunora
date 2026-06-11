import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";

import { createAuth } from "../src/create-auth";
import { CirrusAuthHeadersError, withAuthPlugins } from "../src/middleware";
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
        // The default surface is the runtime header guard (a transparent proxy
        // over `auth.api`), so it is structurally the api but not identity-equal.
        // The unguarded `auth.api` is reachable via the `withoutHeaders()` hatch.
        expect((context.authApi as { withoutHeaders(): unknown }).withoutHeaders()).toBe(auth.api);

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
        // would reach it after composing the middleware. This is a server-side
        // seed with no inbound request, so we use the explicit `withoutHeaders()`
        // opt-out (the runtime guard would otherwise reject the header-less call).
        await (context.authApi as unknown as { withoutHeaders(): typeof auth.api }).withoutHeaders().createOrganization({
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

/**
 * Runtime header guard (audit finding #7). `withAuthPlugins` wraps `ctx.authApi`
 * in a proxy that throws when a privileged endpoint is called without `headers`,
 * mirroring the static `auth_api_call_without_headers` advisor lint. The guard
 * is on by default (safe); opting out must be explicit (`withoutHeaders()` per
 * call, or `{ enforceHeaders: false }` for the whole middleware).
 *
 * The guard wraps EVERY callable on `auth.api` — it doesn't need a real
 * better-auth instance to exercise the throw/pass behaviour, so we drive it with
 * a minimal stub api whose endpoint records the arguments it received. That
 * isolates "did the guard throw / forward correctly" from better-auth's own
 * authorization, which the sql-store + behaviour suites already cover.
 */
describe("withAuthPlugins — runtime header guard", () => {
    interface StubApi extends Record<string, unknown> {
        banUser: (options: { body: { userId: string }; headers?: Headers }) => Promise<{ called: true; sawHeaders: boolean }>;
    }

    const stubAuth = (calls: { options: unknown }[]): { api: StubApi } => ({
        api: {
            banUser: (options) => {
                calls.push({ options });

                return Promise.resolve({ called: true, sawHeaders: options.headers !== undefined });
            },
        },
    });

    const installAuthApi = async (auth: unknown, enforceHeaders?: boolean): Promise<{ banUser: StubApi["banUser"]; withoutHeaders(): StubApi }> => {
        const middleware = withAuthPlugins(auth as never, enforceHeaders === undefined ? undefined : { enforceHeaders });
        const context = await runMiddleware<{ authApi: { banUser: StubApi["banUser"]; withoutHeaders(): StubApi } }>(middleware as never, {});

        return context.authApi;
    };

    it("throws CirrusAuthHeadersError on a header-less privileged call (safe default)", async () => {
        expect.assertions(3);

        const calls: { options: unknown }[] = [];
        const authApi = await installAuthApi(stubAuth(calls));

        // No headers → guard throws and the underlying endpoint is never reached.
        await expect(authApi.banUser({ body: { userId: "u_1" } })).rejects.toBeInstanceOf(CirrusAuthHeadersError);
        await expect(authApi.banUser({ body: { userId: "u_1" } })).rejects.toThrow(/banUser/u);
        expect(calls).toHaveLength(0);
    });

    it("also throws when `headers` is present but nullish (undefined / null)", async () => {
        expect.assertions(3);

        const calls: { options: unknown }[] = [];
        const authApi = await installAuthApi(stubAuth(calls));

        // `headers: undefined` is the same bypass as omitting it.
        await expect(authApi.banUser({ body: { userId: "u_1" }, headers: undefined })).rejects.toBeInstanceOf(CirrusAuthHeadersError);
        // A `null` headers value is the bypass too — cast through `unknown` since
        // the stub's signature only admits `Headers | undefined`.
        const callWithNullHeaders = authApi.banUser as unknown as (o: { body: { userId: string }; headers: null }) => Promise<unknown>;

        await expect(callWithNullHeaders({ body: { userId: "u_1" }, headers: null })).rejects.toBeInstanceOf(CirrusAuthHeadersError);
        expect(calls).toHaveLength(0);
    });

    it("passes a normal header-bearing call straight through to the endpoint", async () => {
        expect.assertions(3);

        const calls: { options: unknown }[] = [];
        const authApi = await installAuthApi(stubAuth(calls));

        const result = await authApi.banUser({ body: { userId: "u_1" }, headers: new Headers({ cookie: "session=abc" }) });

        expect(result).toEqual({ called: true, sawHeaders: true });
        expect(calls).toHaveLength(1);
        // The guard forwards the original arguments verbatim.
        expect((calls[0]!.options as { body: { userId: string } }).body).toEqual({ userId: "u_1" });
    });

    it("ctx.authApi.withoutHeaders() opts a single call out of the guard", async () => {
        expect.assertions(2);

        const calls: { options: unknown }[] = [];
        const authApi = await installAuthApi(stubAuth(calls));

        // The explicit per-call escape hatch returns the raw, unguarded surface.
        const result = await authApi.withoutHeaders().banUser({ body: { userId: "u_1" } });

        expect(result).toEqual({ called: true, sawHeaders: false });
        expect(calls).toHaveLength(1);
    });

    it("{ enforceHeaders: false } disables the guard for the whole middleware", async () => {
        expect.assertions(2);

        const calls: { options: unknown }[] = [];
        const authApi = await installAuthApi(stubAuth(calls), false);

        // Guard disabled → a header-less call runs the endpoint directly.
        const result = await authApi.banUser({ body: { userId: "u_1" } });

        expect(result).toEqual({ called: true, sawHeaders: false });
        expect(calls).toHaveLength(1);
    });

    it("guards a real better-auth admin endpoint end to end", async () => {
        expect.assertions(2);

        // Drive the guard over an actual `auth.api` surface so the throw fires
        // before better-auth's own session-less privilege escalation runs.
        const memoryDatabase: Record<string, unknown[]> = {
            account: [],
            invitation: [],
            member: [],
            organization: [],
            session: [],
            team: [],
            user: [],
            verification: [],
        };
        const auth = createAuth({
            baseURL: "http://localhost",
            database: memoryAdapter(memoryDatabase),
            emailAndPassword: { enabled: true },
            plugins: [organization(), admin()],
            secret: "x".repeat(32),
        });

        const middleware = withAuthPlugins(auth);
        const context = await runMiddleware<{
            authApi: { createOrganization: (options: { body: { name: string; slug: string }; headers?: Headers }) => Promise<unknown> };
        }>(middleware as never, {});

        // Header-less privileged call → guard throws (would have escalated).
        await expect(context.authApi.createOrganization({ body: { name: "Acme", slug: "acme" } })).rejects.toBeInstanceOf(CirrusAuthHeadersError);

        // With headers, the call reaches better-auth (which then enforces its
        // own session check — an unauthenticated empty Headers is rejected by
        // better-auth, NOT by our guard). Either way the guard let it through.
        await expect(context.authApi.createOrganization({ body: { name: "Acme", slug: "acme" }, headers: new Headers() })).rejects.not.toBeInstanceOf(
            CirrusAuthHeadersError,
        );
    });
});
