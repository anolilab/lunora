/**
 * CAPTCHA widgets — Turnstile, reCAPTCHA v2, hCaptcha, captchafox.
 *
 * better-auth's `captcha` plugin is **server-side only**: it reads an
 * `x-captcha-response` header off the requests you list and verifies it with the
 * provider. Nothing about the widget is its business, which leaves two jobs for
 * the client, and they belong in different places.
 *
 * **Rendering the widget and capturing a token** is {@link renderCaptcha}, driven
 * by each port's `<Captcha>` component.
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
 *             for (const [key, value] of Object.entries(captchaHeaders(context.url?.toString()))) {
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

/**
 * The routes better-auth's `captcha` plugin guards by default.
 *
 * The token must only be attached to these. `fetchOptions.onRequest` runs for
 * every* auth call, and `captchaHeaders()` consumes on read — so without this
 * filter a background `getSession` (a session refetch on focus, a `<UserButton>`
 * elsewhere in the shell) spends the token on a route that ignores it, and the
 * sign-in the user then clicks arrives with no header at all.
 *
 * Mirrors the plugin's own `defaultEndpoints`. If you passed `endpoints` to
 * `captcha()`, pass the same list to {@link captchaHeaders}.
 */
const CAPTCHA_ENDPOINTS: ReadonlyArray<string> = ["/sign-up/email", "/sign-in/email", "/request-password-reset"];

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

/**
 * Whether `path` is one the plugin guards.
 *
 * Mirrors better-auth's own matcher rather than approximating it: it compares a
 * normalized pathname* and supports a trailing `*`. A plain `endsWith` looks
 * equivalent until someone follows this module's own advice and passes their
 * `captcha({ endpoints })` list — a wildcard entry like `/sign-in/*` would then
 * never match, no header would ever be attached, and every sign-in would fail
 * with `MISSING_RESPONSE`.
 */
const ORIGIN = /^[a-z]+:\/\/[^/]+/iu;
const DOUBLE_SLASH = /\/{2,}/gu;
const TRAILING_SLASH = /\/$/u;

const isGuarded = (path: string, endpoints: ReadonlyArray<string>, basePath: string): boolean => {
    // Accept a full URL or a bare path; strip the query and the auth basePath,
    // collapse doubled slashes, drop a trailing one — as better-auth does.
    const withoutOrigin = path.replace(ORIGIN, "");
    const withoutQuery = withoutOrigin.split("?")[0] ?? "";
    const trimmedBase = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
    const relative = withoutQuery.startsWith(trimmedBase) ? withoutQuery.slice(trimmedBase.length) : withoutQuery;
    const pathname = relative.replaceAll(DOUBLE_SLASH, "/").replace(TRAILING_SLASH, "") || "/";

    return endpoints.some((endpoint) => (endpoint.endsWith("*") ? pathname.startsWith(endpoint.slice(0, -1)) : endpoint === pathname));
};

/** Options for {@link captchaHeaders}. */
interface CaptchaHeaderOptions {
    /** Your auth mount path, so a full URL can be reduced to what better-auth compares. Defaults to `/api/auth`. */
    basePath?: string;
    /** The list you passed to `captcha({ endpoints })`, if you passed one. */
    endpoints?: ReadonlyArray<string>;
}

/** A widget the plugin rendered: the handle a reset needs. */
type CaptchaWidget = { api: CaptchaGlobal; id: unknown };

/** The widget whose solve produced the token in the store; `undefined` for a token set outside a widget. */
let tokenOwner: CaptchaWidget | undefined;

/**
 * Spends kept for requests still waiting on a reset. A request older than these
 * falls back to resetting every widget, which is what every reset did before.
 */
const SPEND_HISTORY = 64;

/**
 * One entry per token `captchaHeaders` has handed to a request, holding the widget
 * that produced it (`undefined` when none did). A controller reads its position
 * before a request and resets only the widgets spent since then, so another
 * form's spend or a fresh solve is not mistaken for its own. Only the last
 * {@link SPEND_HISTORY} are kept, so a long-lived page does not grow the list or
 * keep the handles of unmounted widgets.
 */
const spent: (CaptchaWidget | undefined)[] = [];

/** How many spends have aged out of `spent`, so an index into it is `spentBase + position`. */
let spentBase = 0;

/** Read before a request; pass to {@link resetCaptchaIfSpent} after it. */
const captchaSpends = (): number => spentBase + spent.length;

const captchaHeaders = (path?: string, options: CaptchaHeaderOptions = {}): Record<string, string> => {
    // A path the plugin does not guard must not consume the token — see the
    // note on CAPTCHA_ENDPOINTS. Called without a path (a caller attaching it
    // deliberately to one request) it still works.
    if (path !== undefined && !isGuarded(path, options.endpoints ?? CAPTCHA_ENDPOINTS, options.basePath ?? "/api/auth")) {
        return {};
    }

    const { token } = store.get();

    if (token === undefined || token === "") {
        return {};
    }

    store.set({});
    spent.push(tokenOwner);

    if (spent.length > SPEND_HISTORY) {
        spent.shift();
        spentBase += 1;
    }

    tokenOwner = undefined;

    return { [CAPTCHA_HEADER]: token };
};

/** Publish a token and the widget that produced it; the owner is what a later reset targets. */
const storeToken = (token: string | undefined, owner: CaptchaWidget | undefined): void => {
    tokenOwner = token === undefined ? undefined : owner;
    store.set({ token });
};

/** Publish a solved token. Exported for tests; {@link renderCaptcha} uses {@link storeToken} to tag its widget. */
const setCaptchaToken = (token: string | undefined): void => {
    storeToken(token, undefined);
};

/** The bit of a `<script>` element this module sets, named so the DOM lib isn't needed. */
interface ScriptElement {
    addEventListener: (type: string, listener: () => void) => void;
    async: boolean;
    defer: boolean;
    src: string;
}

/** One in-flight load per script URL, so several widgets share it. */
const scripts = new Map<string, Promise<void>>();

const loadScript = async (source: string): Promise<void> => {
    const existing = scripts.get(source);

    if (existing) {
        return existing;
    }

    const pending = new Promise<void>((resolve, reject) => {
        /*
         * Reached structurally rather than through the DOM's `Document`, like
         * every other global in `core/`. A consumer project that also pulls in
         * `@cloudflare/workers-types` has a different `head.append` in scope —
         * HTMLRewriter's, which takes a string — so naming `Document` here type
         * -errors in the app rather than in this package.
         */
        const documentReference = (
            globalThis as {
                document?: {
                    createElement: (tag: string) => ScriptElement;
                    head: { appendChild: (node: ScriptElement) => void };
                };
            }
        ).document;

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

        // eslint-disable-next-line unicorn/prefer-dom-node-append -- `append` is what the autofix wants, but a consumer that also has @cloudflare/workers-types in scope resolves it to HTMLRewriter's string-only `append` and fails to compile. `appendChild` is unambiguous.
        documentReference.head.appendChild(element);
    });

    scripts.set(source, pending);

    return pending;
};

/** The `render` surface every one of these providers happens to share. */
interface CaptchaGlobal {
    render: (element: Element, parameters: { callback: (token: string) => void; "expired-callback"?: () => void; sitekey: string }) => unknown;
    reset?: (widgetId?: unknown) => void;
}

/** Every widget currently mounted, so a failed submit can re-arm all of them. */
const widgets = new Set<{ api: CaptchaGlobal; id: unknown }>();

/**
 * Reset every live widget and drop any pending token.
 *
 * The token is spent by the request that carried it (see {@link captchaHeaders}),
 * so after a failed submit the widget still shows "solved" while holding nothing
 * the server will accept — the retry goes out without a header and fails with
 * `MISSING_RESPONSE`. The form controllers call this on every failure so the
 * user is asked to solve again instead.
 */
const resetCaptcha = (): void => {
    // The token goes first and a throwing provider is skipped: this runs from
    // controller catch blocks, where an escaping error would leave the form
    // stuck in "submitting".
    store.set({});

    for (const widget of widgets) {
        try {
            widget.api.reset?.(widget.id);
        } catch {
            // A widget that cannot reset (script blocked, element gone) must not stop the others.
        }
    }
};

/**
 * Reset the widgets, but only if a request since `mark` (a {@link captchaSpends}
 * reading) actually carried a token. A form whose request went to an unguarded
 * endpoint, or failed before the header was attached, spent nothing — resetting
 * would erase a solve another card on the page is still holding.
 */
const resetCaptchaIfSpent = (mark: number): void => {
    // The request's spends have aged out of the history: attribute nothing and reset everything.
    if (mark < spentBase) {
        resetCaptcha();

        return;
    }

    const owners = spent.slice(mark - spentBase);

    if (owners.length === 0) {
        return;
    }

    // A spend no widget produced (the app set the token itself) cannot be attributed, so reset everything as before.
    if (owners.includes(undefined)) {
        resetCaptcha();

        return;
    }

    // Reset only the widgets that spent a token, and leave the store alone: a token solved since then is not ours.
    const spentWidgets = new Set(owners as CaptchaWidget[]);

    for (const widget of spentWidgets) {
        try {
            widget.api.reset?.(widget.id);
        } catch {
            // A widget that cannot reset must not stop the others.
        }
    }

    // A token the spent widget solved again while the request was pending now shows unsolved, so drop it with the widget.
    if (tokenOwner !== undefined && spentWidgets.has(tokenOwner)) {
        setCaptchaToken(undefined);
    }
};

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
    let widget: { api: CaptchaGlobal; id: unknown } | undefined;
    let disposed = false;

    /**
     * The token *this* widget last produced. Compared by identity on teardown
     * rather than tracked as a boolean: with two widgets on a page (a sign-in /
     * sign-up tab pair) a flag set when A solved is still set after B solves, so
     * unmounting A would wipe B's answer.
     */
    let ownToken: string | undefined;

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
                    ownToken = token;
                    storeToken(token, widget);
                },
                // A token expires long before a slow user finishes a form; drop
                // it rather than send one the provider will reject.
                "expired-callback": () => {
                    // Only our own token: another widget may have solved since, and its answer is still good.
                    if (ownToken !== undefined && store.get().token === ownToken) {
                        setCaptchaToken(undefined);
                    }

                    ownToken = undefined;
                },
                sitekey: options.siteKey,
            });
            widget = { api, id: widgetId };
            widgets.add(widget);

            return true;
        })
        .catch((error: unknown) => {
            options.onError?.(error);
        });

    return () => {
        disposed = true;

        if (widget !== undefined) {
            widgets.delete(widget);
        }

        // Only if the store still holds *our* token — another widget may have
        // solved since, and consuming clears it anyway.
        if (ownToken !== undefined && store.get().token === ownToken) {
            setCaptchaToken(undefined);
        }

        const api = (globalThis as unknown as Record<string, CaptchaGlobal | undefined>)[provider.global];

        api?.reset?.(widgetId);
    };
};

export type { CaptchaHeaderOptions, CaptchaProvider, RenderCaptchaOptions };
export { CAPTCHA_ENDPOINTS, CAPTCHA_HEADER, captchaHeaders, captchaSpends, PROVIDERS, renderCaptcha, resetCaptcha, resetCaptchaIfSpent, setCaptchaToken };
