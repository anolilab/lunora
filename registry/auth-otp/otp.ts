/**
 * Passwordless email OTP sign-in / verification — added by
 * `lunora registry add auth-otp`.
 *
 * This file is YOURS: it's copied into your project so you own and edit it.
 * It wires better-auth's `emailOTP` plugin (re-exported by
 * `@lunora/auth/plugins`) and delivers the one-time code through `@lunora/mail`.
 * `createMailerFromEnv` picks the transport by environment: in dev every send is
 * captured into the studio's Mail tab; in production it delivers via the
 * `SEND_EMAIL` binding (run `lunora add email`) or `RESEND_API_KEY`. `MAIL_FROM`
 * is required and is already set by the base `auth` item.
 *
 * See https://www.better-auth.com/docs/plugins/email-otp for the full config
 * surface (code length, expiry, `sendVerificationOnSignUp`, …).
 *
 * # Wire it into your auth instance
 *
 * Merge this plugin into the `plugins` array in `lunora/auth/index.ts`:
 *
 * ```ts
 * // lunora/auth/index.ts
 * import { emailOtpPlugin } from "./otp.js";
 *
 * export const buildAuth = (env: AuthEnv): LunoraAuth =>
 *     createAuth({
 *         baseURL: env.BETTER_AUTH_URL,
 *         database: env.DB as never,
 *         emailAndPassword: { enabled: true },
 *         secret: env.BETTER_AUTH_SECRET,
 *         plugins: [emailOtpPlugin(env)],
 *     });
 * ```
 *
 * # Sign in from the client
 *
 * ```ts
 * await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
 * await authClient.signIn.emailOtp({ email, otp });
 * ```
 */
import { emailOTP } from "@lunora/auth/plugins";
import { createMailerFromEnv } from "@lunora/mail";

/** The env bindings this plugin reads. `MAIL_FROM` is the sender; the rest selects the transport. */
export interface EmailOtpEnv {
    /** Sender address for the OTP email (set by the base `auth` item). */
    MAIL_FROM?: string;
    [key: string]: unknown;
}

/**
 * Env-name values that mark a development deployment. `lunora dev` sets
 * `WORKER_ENV=development`; a real deploy that sets none of these stays
 * production (fail closed), so the dev-only console fallback below never leaks
 * live one-time codes into production Worker logs.
 */
const DEV_ENVIRONMENT_PATTERN = /^(?:dev(?:elopment)?|local(?:host)?|test)$/iu;
const ENVIRONMENT_VARS = ["CF_ENV", "ENVIRONMENT", "NODE_ENV", "WORKER_ENV"] as const;

const isDevEnvironment = (env: Record<string, unknown>): boolean =>
    ENVIRONMENT_VARS.some((key) => typeof env[key] === "string" && DEV_ENVIRONMENT_PATTERN.test(env[key] as string));

/**
 * Deliver an auth email through `@lunora/mail` — the SAME transport selection as
 * the base `auth` item's `sendAuthEmail`, so OTP mail behaves identically to
 * verification/reset mail: captured into the studio Mail tab in dev, delivered
 * via the `SEND_EMAIL` binding (or `RESEND_API_KEY`) in production, and — in
 * development only — logged to the console when `MAIL_FROM` isn't set yet so the
 * dev flow works before `lunora add email`. In production a missing `MAIL_FROM`
 * fails closed: the OTP is a live login credential, so we throw rather than
 * write one-time codes (and recipient addresses) to Worker logs. The
 * `cloudflareSend` callback (it needs `cloudflare:email`) is what lets
 * `createMailerFromEnv` reach the binding in production; it's passed only when a
 * `SEND_EMAIL` binding exists, so a Resend-only deploy still falls back to
 * `RESEND_API_KEY` instead of throwing inside `cloudflareSend`.
 */
const sendPluginEmail = async (env: EmailOtpEnv, message: { subject: string; text: string; to: string }): Promise<void> => {
    const fullEnv = env as unknown as Record<string, unknown>;

    if (typeof fullEnv["MAIL_FROM"] !== "string") {
        if (!isDevEnvironment(fullEnv)) {
            throw new Error(
                "auth: mail is not configured (`MAIL_FROM` unset) — run `lunora add email` before deploying. Refusing to log OTP codes in production.",
            );
        }

        // Dev only — surface the OTP so the flow still works. Run `lunora add email`.
        // eslint-disable-next-line no-console -- dev fallback: surface the OTP when no mailer is set up
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
    // prefers it over `RESEND_API_KEY`, so passing it unconditionally would break a
    // Resend-only deployment (the documented "SEND_EMAIL binding or RESEND_API_KEY" path).
    await createMailerFromEnv(fullEnv, fullEnv["SEND_EMAIL"] === undefined ? {} : { cloudflareSend }).send(message);
};

/**
 * Build the email-OTP plugin. The `sendVerificationOTP` callback emails the
 * generated code through `@lunora/mail`; in dev it surfaces in the studio Mail
 * tab.
 */
export const emailOtpPlugin = (env: EmailOtpEnv): ReturnType<typeof emailOTP> =>
    emailOTP({
        sendVerificationOTP: async ({ email, otp }: { email: string; otp: string }): Promise<void> => {
            await sendPluginEmail(env, { subject: "Your verification code", text: `Your code: ${otp}`, to: email });
        },
    });
