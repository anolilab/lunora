/**
 * Passwordless magic-link sign-in — added by `lunora registry add auth-magic-link`.
 *
 * This file is YOURS: it's copied into your project so you own and edit it.
 * It wires better-auth's `magicLink` plugin (re-exported by
 * `@lunora/auth/plugins`) and delivers the sign-in link through `@lunora/mail`.
 * `createMailerFromEnv` picks the transport by environment: in dev every send is
 * captured into the studio's Mail tab; in production it delivers via the
 * `SEND_EMAIL` binding (run `lunora add email`) or `RESEND_API_KEY`. `MAIL_FROM`
 * is required and is already set by the base `auth` item.
 *
 * See https://www.better-auth.com/docs/plugins/magic-link for the full config
 * surface (link expiry, `disableSignUp`, custom token generation, …).
 *
 * # Wire it into your auth instance
 *
 * Merge this plugin into the `plugins` array in `lunora/auth/index.ts`:
 *
 * ```ts
 * // lunora/auth/index.ts
 * import { magicLinkPlugin } from "./magic-link.js";
 *
 * export const buildAuth = (env: AuthEnv): LunoraAuth =>
 *     createAuth({
 *         baseURL: env.BETTER_AUTH_URL,
 *         database: env.DB as never,
 *         emailAndPassword: { enabled: true },
 *         secret: env.BETTER_AUTH_SECRET,
 *         plugins: [magicLinkPlugin(env)],
 *     });
 * ```
 *
 * # Sign in from the client
 *
 * ```ts
 * await authClient.signIn.magicLink({ email, callbackURL: "/" });
 * ```
 */
import { magicLink } from "@lunora/auth/plugins";
import { createMailerFromEnv } from "@lunora/mail";

/** The env bindings this plugin reads. `MAIL_FROM` is the sender; the rest selects the transport. */
export interface MagicLinkEnv {
    /** Sender address for the magic-link email (set by the base `auth` item). */
    MAIL_FROM?: string;
    [key: string]: unknown;
}

/**
 * Deliver an auth email through `@lunora/mail` — the SAME transport selection as
 * the base `auth` item's `sendAuthEmail`, so magic-link mail behaves identically
 * to verification/reset mail: captured into the studio Mail tab in dev, delivered
 * via the `SEND_EMAIL` binding (or `RESEND_API_KEY`) in production, and logged to
 * the console when `MAIL_FROM` isn't set yet so the dev flow works before
 * `lunora add email`. The `cloudflareSend` callback (it needs `cloudflare:email`)
 * is what lets `createMailerFromEnv` reach the binding in production — omitting it
 * is why an unwired send would otherwise throw `no transport configured`.
 */
const sendPluginEmail = async (env: MagicLinkEnv, message: { subject: string; text: string; to: string }): Promise<void> => {
    const fullEnv = env as unknown as Record<string, unknown>;

    if (typeof fullEnv["MAIL_FROM"] !== "string") {
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

    await createMailerFromEnv(fullEnv, { cloudflareSend }).send(message);
};

/**
 * Build the magic-link plugin. The `sendMagicLink` callback emails the
 * generated sign-in URL through `@lunora/mail`; in dev it surfaces in the studio
 * Mail tab.
 */
export const magicLinkPlugin = (env: MagicLinkEnv): ReturnType<typeof magicLink> =>
    magicLink({
        sendMagicLink: async ({ email, url }: { email: string; url: string }): Promise<void> => {
            await sendPluginEmail(env, { subject: "Your sign-in link", text: `Sign in:\n${url}`, to: email });
        },
    });
