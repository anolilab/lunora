/**
 * Auth instance + request handler — added by `cirrus registry add auth`.
 *
 * This file is YOURS: it's copied into your project so you own and edit it.
 * `@cirrus/auth` is a thin wrapper over better-auth — `createAuth(options)` is
 * `betterAuth(options)` with a clearer error when `secret` is missing, and it
 * passes every better-auth option (`socialProviders`, `plugins`, `session`, …)
 * straight through. See https://www.better-auth.com/docs for the full surface.
 *
 * What this scaffolds:
 *   - `buildAuth(env)` — constructs the better-auth instance, with
 *     email/password sign-up/sign-in enabled, backed by your D1 binding (`DB`).
 *   - `getAuth(env)` — memoizes the instance per isolate so the migration diff
 *     (see `ensureMigrated` below) and config setup don't re-run every request.
 *   - `mountAuth(env, request)` — routes `/api/auth/*` requests to better-auth.
 *     Call it FIRST in your Worker's `fetch` and return its response when set.
 *
 * Wiring (in your Worker entry, e.g. `src/server/index.ts`):
 *
 * ```ts
 * import { mountAuth } from "../../cirrus/auth/index.js";
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
 * Resolve the caller's identity for Cirrus procedures by passing
 * `resolveIdentity` to `createWorker`, calling `getAuth(env).api.getSession({
 * headers: request.headers })` inside it.
 */
import type { CirrusAuth } from "@cirrus/auth";
import { createAuth, ensureMigrated, handleAuthRequest } from "@cirrus/auth";
import { createMailerFromEnv } from "@cirrus/mail";

/**
 * The Worker env bindings this module needs. Cirrus generates a richer `Env`
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
 * `@cirrus/mail`. In a dev environment this is captured into the studio's Mail
 * inbox; in production it delivers via the `SEND_EMAIL` binding (or
 * `RESEND_API_KEY`). `createMailerFromEnv` owns the capture-vs-deliver decision,
 * so auth mail behaves exactly like `api.mail.sendEmail`.
 *
 * If mail isn't set up yet (`MAIL_FROM` unset — you haven't run `cirrus add
 * email`), the link is logged to the console instead so sign-up / reset still
 * work in dev. Cast through the full `env` since the mailer reads bindings
 * (`SHARD`, `SEND_EMAIL`) and vars (`MAIL_FROM`) outside {@link AuthEnv}'s slice.
 */
const sendAuthEmail = async (env: AuthEnv, message: { subject: string; text: string; to: string }): Promise<void> => {
    const fullEnv = env as unknown as Record<string, unknown>;

    if (typeof fullEnv["MAIL_FROM"] !== "string") {
        // Mail not configured — log the link so the flow still works in dev. Run `cirrus add email`.
        // eslint-disable-next-line no-console -- dev fallback: surface the auth link when no mailer is set up
        console.log(`[auth] email → ${message.to}: ${message.subject}\n${message.text}`);

        return;
    }

    const cloudflareSend = async (from: string, to: string, raw: string): Promise<void> => {
        const { EmailMessage } = await import("cloudflare:email");
        const binding = fullEnv["SEND_EMAIL"] as { send: (m: InstanceType<typeof EmailMessage>) => Promise<void> } | undefined;

        if (binding === undefined) {
            throw new Error("auth: no SEND_EMAIL binding to deliver mail — run `cirrus add email` or set RESEND_API_KEY.");
        }

        await binding.send(new EmailMessage(from, to, raw));
    };

    await createMailerFromEnv(fullEnv, { cloudflareSend }).send(message);
};

/**
 * Construct the better-auth instance. Edit freely — add `socialProviders`,
 * `plugins` (from `@cirrus/auth/plugins`), or a `session` policy
 * (`sessionPresets` from `@cirrus/auth`). The `auth-clerk` / `auth-auth0`
 * registry items scaffold provider snippets you merge into the options here.
 *
 * Email/password sign-up enables verification + a forgot-password reset; both
 * deliver through {@link sendAuthEmail} (captured into the studio Mail tab in
 * dev). Edit the subjects/bodies — or swap to a React template via
 * `@cirrus/mail`'s `renderEmail` — to taste.
 */
export const buildAuth = (env: AuthEnv): CirrusAuth =>
    createAuth({
        baseURL: env.BETTER_AUTH_URL,
        // better-auth accepts a D1Database directly; cast since AuthEnv keeps
        // `DB` opaque (your generated `Env` types it precisely).
        database: env.DB as never,
        emailAndPassword: {
            enabled: true,
            sendResetPassword: async ({ url, user }) => {
                await sendAuthEmail(env, { subject: "Reset your password", text: `Reset your password:\n${url}`, to: user.email });
            },
        },
        emailVerification: {
            sendVerificationEmail: async ({ url, user }) => {
                await sendAuthEmail(env, { subject: "Verify your email address", text: `Verify your email address:\n${url}`, to: user.email });
            },
        },
        secret: env.BETTER_AUTH_SECRET,
    });

/**
 * Per-isolate memoized auth instance. Cloudflare reuses the same `env` bindings
 * across invocations within an isolate, so building once keeps the migration
 * single-flight cache warm (see `ensureMigrated`).
 */
let cached: CirrusAuth | undefined;

/** Get (or lazily build) the memoized auth instance for this isolate. */
export const getAuth = (env: AuthEnv): CirrusAuth => {
    cached ??= buildAuth(env);

    return cached;
};

/**
 * Route `/api/auth/*` to better-auth. Returns the auth `Response` when the
 * request is an auth route, or `undefined` so your Worker keeps dispatching.
 *
 * In dev this also applies better-auth's schema to D1 on first hit via
 * `ensureMigrated` (idempotent, single-flight). For production, pre-apply the
 * schema at deploy time instead — see the README — and drop the
 * `ensureMigrated` call to avoid the per-cold-start diff.
 */
export const mountAuth = async (env: AuthEnv, request: Request): Promise<Response | undefined> => {
    const auth = getAuth(env);

    await ensureMigrated(auth);

    return handleAuthRequest(auth, request);
};
