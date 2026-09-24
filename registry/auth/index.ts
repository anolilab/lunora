/**
 * Auth instance + request handler — added by `lunora registry add auth`.
 *
 * This file is YOURS: it's copied into your project so you own and edit it.
 * `@lunora/auth` is a thin wrapper over better-auth — `createAuth(options)` is
 * `betterAuth(options)` with a clearer error when `secret` is missing, and it
 * passes every better-auth option (`socialProviders`, `plugins`, `session`, …)
 * straight through. See https://www.better-auth.com/docs for the full surface.
 *
 * What this scaffolds:
 *   - `buildAuth(env)` — constructs the better-auth instance, with
 *     email/password sign-up/sign-in enabled, backed by your D1 binding (`DB`).
 *   - `getAuth(env)` — memoizes the instance per isolate so better-auth and its
 *     adapter aren't rebuilt on every request.
 *   - `mountAuth(env, request)` — routes `/api/auth/*` requests to better-auth.
 *     Call it FIRST in your Worker's `fetch` and return its response when set;
 *     it returns `undefined` for non-auth routes without doing any auth work.
 *
 * Wiring (in your Worker entry, e.g. `src/server/index.ts`):
 *
 * ```ts
 * import { mountAuth } from "../../lunora/auth/index.js";
 *
 * export default {
 *     async fetch(request: Request, env: Env, ctx: ExecutionContext) {
 *         const authResponse = await mountAuth(env, request);
 *         if (authResponse) return authResponse;
 *         // …dispatch the rest of your app (createWorker(...).fetch(...))…
 *     },
 * };
 * ```
 *
 * Resolve the caller's identity for Lunora procedures by passing
 * `resolveIdentity` to `createWorker`, calling `getAuth(env).api.getSession({
 * headers: request.headers })` inside it.
 */
import type { LunoraAuth } from "@lunora/auth";
import { createAuth, DEFAULT_AUTH_BASE_PATH, ensureMigrated, handleAuthRequest, lunoraD1Adapter } from "@lunora/auth";
import { uiConfig } from "@lunora/auth/plugins";
import { createMailerFromEnv } from "@lunora/mail";

/**
 * Env-name values that mark a development deployment, and the vars they live in.
 * `lunora dev` sets `WORKER_ENV=development`; a real deploy that sets none of
 * these stays production (fail closed). Used to gate dev-only behaviour below —
 * console-logging auth links and running schema migrations on cold start.
 */
const DEV_ENVIRONMENT_PATTERN = /^(?:dev(?:elopment)?|local(?:host)?|test)$/iu;
const ENVIRONMENT_VARS = ["CF_ENV", "ENVIRONMENT", "NODE_ENV", "WORKER_ENV"] as const;

/**
 * Whether the Worker is running in development. Defaults to FALSE so a real
 * deploy that sets none of {@link ENVIRONMENT_VARS} is treated as production —
 * dev-only conveniences (logging links, auto-migrating) never leak there.
 */
const isDevEnvironment = (env: Record<string, unknown>): boolean =>
    ENVIRONMENT_VARS.some((key) => typeof env[key] === "string" && DEV_ENVIRONMENT_PATTERN.test(env[key] as string));

/**
 * The Worker env bindings this module needs. Lunora generates a richer `Env`
 * for your project; this is the minimal slice `buildAuth` reads. `DB` is your
 * D1 binding (declared in `wrangler.jsonc`); better-auth accepts a D1Database
 * directly as its `database`.
 */
export interface AuthEnv {
    /** better-auth encryption secret (min 32 chars). Set as a secret. */
    BETTER_AUTH_SECRET: string;
    /** Public base URL of your app, e.g. "http://localhost:8787". */
    BETTER_AUTH_URL?: string;
    /** Cloudflare D1 binding better-auth persists users/sessions into. */
    DB: unknown;
}

/**
 * Send a transactional auth email (verification link, password reset) through
 * `@lunora/mail`. In a dev environment this is captured into the studio's Mail
 * inbox; in production it delivers via the `SEND_EMAIL` binding (or
 * `RESEND_API_KEY`). `createMailerFromEnv` owns the capture-vs-deliver decision,
 * so auth mail behaves exactly like `api.mail.sendEmail`.
 *
 * If mail isn't set up yet (`MAIL_FROM` unset — you haven't run `lunora add
 * email`), the link is logged to the console **in development only** so sign-up
 * / reset still work before you wire mail. In production this fails closed: auth
 * links are bearer credentials, so we throw rather than write them to Worker
 * logs where anyone with log access could use them to take over the account.
 * Cast through the full `env` since the mailer reads bindings (`SHARD`,
 * `SEND_EMAIL`) and vars (`MAIL_FROM`) outside {@link AuthEnv}'s slice.
 *
 * `html` is optional so the `auth-emails` registry item's recipe compiles as
 * documented: `renderEmail(<ResetPasswordEmail … />)` returns `{ html, text }`
 * and both are passed straight through to `@lunora/mail`.
 */
const sendAuthEmail = async (env: AuthEnv, message: { html?: string; subject: string; text: string; to: string }): Promise<void> => {
    const fullEnv = env as unknown as Record<string, unknown>;

    if (typeof fullEnv["MAIL_FROM"] !== "string") {
        if (!isDevEnvironment(fullEnv)) {
            // Production with no mailer configured — never log the link (it's a
            // bearer credential). Fail loudly so the deploy gets mail wired up.
            throw new Error(
                "auth: mail is not configured (`MAIL_FROM` unset) — run `lunora add email` before deploying. Refusing to log auth links in production.",
            );
        }

        // Dev only — surface the link so the flow still works. Run `lunora add email`.
        // eslint-disable-next-line no-console -- dev fallback: surface the auth link when no mailer is set up
        console.log(`[auth] email → ${message.to}: ${message.subject}\n${message.text}`);

        return;
    }

    const cloudflareSend = async (from: string, to: string, raw: string): Promise<void> => {
        const { EmailMessage } = await import("cloudflare:email");
        const binding = fullEnv["SEND_EMAIL"] as { send: (m: InstanceType<typeof EmailMessage>) => Promise<void> } | undefined;

        if (binding === undefined) {
            throw new Error("auth: no SEND_EMAIL binding to deliver mail — run `lunora add email` or set RESEND_API_KEY.");
        }

        await binding.send(new EmailMessage(from, to, raw));
    };

    // Only hand over `cloudflareSend` when the binding exists: `createMailerFromEnv`
    // prefers it over `RESEND_API_KEY` whenever it is supplied, so passing it
    // unconditionally would make a Resend-only deployment (no `SEND_EMAIL`
    // binding) throw inside `cloudflareSend` instead of falling back to Resend.
    await createMailerFromEnv(fullEnv, fullEnv["SEND_EMAIL"] === undefined ? {} : { cloudflareSend }).send(message);
};

/**
 * Construct the better-auth instance. Edit freely — add `socialProviders`,
 * `plugins` (from `@lunora/auth/plugins`), or a `session` policy
 * (`sessionPresets` from `@lunora/auth`). The `auth-clerk` / `auth-auth0`
 * registry items scaffold provider snippets you merge into the options here.
 *
 * Email/password sign-up enables verification + a forgot-password reset; both
 * deliver through {@link sendAuthEmail} (captured into the studio Mail tab in
 * dev). Edit the subjects/bodies — or swap to a React template via
 * `@lunora/mail`'s `renderEmail` — to taste.
 */
export const buildAuth = (env: AuthEnv): LunoraAuth =>
    createAuth({
        baseURL: env.BETTER_AUTH_URL,
        // Use `lunoraD1Adapter` rather than passing raw `env.DB`: better-auth
        // accepts a D1Database directly, but then resolves its Kysely adapter via
        // a runtime `await import(...)` that never settles under the Cloudflare
        // Vite worker runner — hanging every auth request in `lunora dev`. The
        // explicit adapter skips that, so dev and prod behave the same. Cast
        // since AuthEnv keeps `DB` opaque (your generated `Env` types it precisely).
        database: lunoraD1Adapter(env.DB as never),
        emailAndPassword: {
            enabled: true,
            requireEmailVerification: true,
            sendResetPassword: async ({ url, user }) => {
                await sendAuthEmail(env, { subject: "Reset your password", text: `Reset your password:\n${url}`, to: user.email });
            },
        },
        emailVerification: {
            sendVerificationEmail: async ({ url, user }) => {
                await sendAuthEmail(env, { subject: "Verify your email address", text: `Verify your email address:\n${url}`, to: user.email });
            },
        },
        // Publishes which plugins and social providers you enabled at
        // `GET /api/auth/ui-config`, so `lunora add auth-ui`'s screens configure
        // themselves — add a social provider here and its button appears, with
        // no second list to keep in sync client-side. Only facts a sign-in page
        // reveals by existing are exposed; drop the plugin to turn it off.
        plugins: [uiConfig()],
        secret: env.BETTER_AUTH_SECRET,
    });

/**
 * A migration-only auth instance backed by *raw* `env.DB`. `ensureMigrated`
 * runs better-auth's own Kysely-based migration runner, which needs the raw D1
 * database (not {@link lunoraD1Adapter}, whose custom store the migrator can't
 * drive). This instance is used solely to apply the schema in dev — request
 * handling always goes through {@link buildAuth}'s adapter-backed instance.
 */
const buildMigrationAuth = (env: AuthEnv): LunoraAuth =>
    createAuth({
        baseURL: env.BETTER_AUTH_URL,
        // Raw D1 on purpose — the migration runner resolves Kysely itself.
        database: env.DB as never,
        emailAndPassword: { enabled: true, requireEmailVerification: true },
        secret: env.BETTER_AUTH_SECRET,
    });

/**
 * Per-isolate memoized auth instance. Cloudflare reuses the same `env` bindings
 * across invocations within an isolate, so building once avoids reconstructing
 * better-auth (and its adapter) on every request.
 */
let cached: LunoraAuth | undefined;

/** Get (or lazily build) the memoized auth instance for this isolate. */
export const getAuth = (env: AuthEnv): LunoraAuth => {
    cached ??= buildAuth(env);

    return cached;
};

/**
 * Per-isolate single-flight guard so the dev migration runs at most once per
 * isolate even though `mountAuth` is called on every auth request.
 */
let migrated: Promise<void> | undefined;

/**
 * Route `/api/auth/*` to better-auth. Returns the auth `Response` when the
 * request is an auth route, or `undefined` so your Worker keeps dispatching.
 *
 * The auth-route check happens BEFORE any migration work, so non-auth traffic
 * (your app's own routes) never pays the schema diff and stays independent of
 * auth/D1 health — an auth migration problem can't take the whole site down.
 *
 * Migrations run only in development (idempotent, single-flight). For
 * production, pre-apply the schema at deploy time instead — see the README
 * (`compileMigrationsSql` + `wrangler d1 execute`) — so request paths never
 * trigger DDL. Migrations use a separate raw-D1 instance ({@link
 * buildMigrationAuth}) because better-auth's migration runner needs the raw
 * Kysely database, while request handling uses the adapter-backed instance.
 */
export const mountAuth = async (env: AuthEnv, request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);

    // Match the auth path first — never touch auth/migrations for other routes.
    if (url.pathname !== DEFAULT_AUTH_BASE_PATH && !url.pathname.startsWith(`${DEFAULT_AUTH_BASE_PATH}/`)) {
        return undefined;
    }

    const auth = getAuth(env);

    // Dev-only auto-migrate. In production, pre-apply the schema at deploy time.
    if (isDevEnvironment(env as unknown as Record<string, unknown>)) {
        migrated ??= ensureMigrated(buildMigrationAuth(env));
        await migrated;
    }

    return handleAuthRequest(auth, request);
};
