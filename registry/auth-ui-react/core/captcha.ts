/**
 * CAPTCHA widgets — Turnstile, reCAPTCHA v2, hCaptcha, captchafox.
 *
 * better-auth's `captcha` plugin is **server-side only**: it reads an
 * `x-captcha-response` header off the requests you list and verifies it with the
 * provider. Nothing about the widget is its business, which leaves two jobs for
 * the client, and they belong in different places.
 *
 * **Rendering the widget and capturing a token** is {@link renderCaptcha}, driven
 * by each port's `&lt;Captcha>` component.
 *
 * **Attaching the token to auth requests** is *not* done here. Every flow would
 * have to thread fetch options through, and better-auth already has one place for
 * it: `createAuthClient`'s `fetchOptions.onRequest`. So the token is published to
 * a module-level store and `lunora/auth-ui/client.ts` reads it:
 *
 * ```ts
 * export const authClient = createLunoraAuthClient(createAuthClient, {
 *     fetchOptions: {
 *         onRequest: (context) => {
 *             for (const [key, value] of Object.entries(captchaHeaders())) {
 *                 context.headers.set(key, value);
 *             }
 *         },
 *     },
 * });
 * ```
 *
 * The token is consumed on read: these providers issue single-use tokens, so
 * sending the same one twice fails verification on the second request.
 */
import { createStore } from "./store";

/** The providers better-auth's `captcha` plugin can verify. */
type CaptchaProvider = "captchafox" | "cloudflare-turnstile" | "google-recaptcha" | "hcaptcha";

/** The header better-auth's captcha plugin reads. */
const CAPTCHA_HEADER = "x-captcha-response";

/** Script URL and the global each provider exposes, keyed by provider id. */
const PROVIDERS: Readonly<Record<CaptchaProvider, { global: string; script: string }>> = {
    captchafox: { global: "CaptchaFox", script: "https://cdn.captchafox.com/api.js?render=explicit" },
    "cloudflare-turnstile": { global: "turnstile", script: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" },
    "google-recaptcha": { global: "grecaptcha", script: "https://www.google.com/recaptcha/api.js?render=explicit" },
    hcaptcha: { global: "hcaptcha", script: "https://js.hcaptcha.com/1/api.js?render=explicit" },
};

const store = createStore<{ token?: string }>({});

/**
 * The pending token as request headers, and clear it.
 *
 * Empty when there is no token — an app without a captcha, or a request made
 * before the user solved it, then simply sends nothing and the server decides.
 */
const captchaHeaders = (): Record<string, string> => {
    const { token } = store.get();

    if (token === undefined || token === "") {
        return {};
    }

    store.set({});

    return { [CAPTCHA_HEADER]: token };
};

/** Publish a solved token. Called by {@link renderCaptcha}; exported for tests. */
const setCaptchaToken = (token: string | undefined): void => {
    store.set({ token });
};

/** One in-flight load per script URL, so several widgets share it. */
const scripts = new Map<string, Promise<void>>();

const loadScript = async (source: string): Promise<void> => {
    const existing = scripts.get(source);

    if (existing) {
        return existing;
    }

    const pending = new Promise<void>((resolve, reject) => {
        const documentReference = (globalThis as { document?: Document }).document;

        if (documentReference === undefined) {
            reject(new Error("no document to load a captcha script into"));

            return;
        }

        const element = documentReference.createElement("script");

        element.async = true;
        element.defer = true;
        element.src = source;
        element.addEventListener("load", () => {
            resolve();
        });
        element.addEventListener("error", () => {
            // Drop the cached promise so a later mount can retry — a blocked or
            // flaky CDN shouldn't poison the widget for the rest of the session.
            scripts.delete(source);
            reject(new Error(`could not load ${source}`));
        });

        documentReference.head.append(element);
    });

    scripts.set(source, pending);

    return pending;
};

/** The `render` surface every one of these providers happens to share. */
interface CaptchaGlobal {
    render: (element: Element, parameters: { callback: (token: string) => void; "expired-callback"?: () => void; sitekey: string }) => unknown;
    reset?: (widgetId?: unknown) => void;
}

interface RenderCaptchaOptions {
    onError?: (error: unknown) => void;
    provider: CaptchaProvider;
    siteKey: string;
}

/**
 * Load the provider's script and render a widget into `element`.
 *
 * Returns a teardown that resets the widget and clears any token it produced, so
 * unmounting a sign-in card can't leave a stale single-use token behind for the
 * next request to spend.
 */
const renderCaptcha = (element: Element, options: RenderCaptchaOptions): (() => void) => {
    const provider = PROVIDERS[options.provider];
    let widgetId: unknown;
    let disposed = false;

    void loadScript(provider.script)
        .then(() => {
            if (disposed) {
                return false;
            }

            const api = (globalThis as unknown as Record<string, CaptchaGlobal | undefined>)[provider.global];

            if (api === undefined) {
                throw new Error(`${provider.global} did not appear after its script loaded`);
            }

            widgetId = api.render(element, {
                callback: (token: string) => {
                    setCaptchaToken(token);
                },
                // A token expires long before a slow user finishes a form; drop
                // it rather than send one the provider will reject.
                "expired-callback": () => {
                    setCaptchaToken(undefined);
                },
                sitekey: options.siteKey,
            });

            return true;
        })
        .catch((error: unknown) => {
            options.onError?.(error);
        });

    return () => {
        disposed = true;
        setCaptchaToken(undefined);

        const api = (globalThis as unknown as Record<string, CaptchaGlobal | undefined>)[provider.global];

        api?.reset?.(widgetId);
    };
};

export type { CaptchaProvider, RenderCaptchaOptions };
export { CAPTCHA_HEADER, captchaHeaders, PROVIDERS, renderCaptcha, setCaptchaToken };
