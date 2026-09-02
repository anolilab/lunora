/**
 * Structural projection of the Cloudflare **Browser Rendering** binding
 * (`env.BROWSER`). The binding is a `Fetcher` under the hood — `@cloudflare/playwright`
 * drives it via `launch(env.BROWSER)`. Declared locally (an empty structural
 * marker) so unit tests can pass a plain-object double and the real binding
 * satisfies the same shape without importing `@cloudflare/workers-types` into
 * the public surface. See https://developers.cloudflare.com/browser-rendering/.
 *
 * It is intentionally opaque: callers never touch the binding directly, they
 * hand it to {@link LunoraBrowserOptions.binding} and the Playwright layer
 * consumes it. `fetch` is REQUIRED (the real binding is a `Fetcher`, so it
 * always has one) so the marker actually excludes an arbitrary value like `{}` —
 * a bare object fails to type-check where a binding is required, catching the
 * misuse at the call site instead of deferring to an opaque launch error.
 * @experimental
 */
export interface BrowserBindingLike {
    readonly fetch: typeof fetch;
}

/**
 * Minimal projection of a Playwright `Route` (the argument the `page.route`
 * handler receives). Only the members the SSRF redirect guard drives are
 * declared: inspect the intercepted request's URL / navigation-ness, then either
 * let it proceed ({@link RouteLike.continue}) or reject it ({@link RouteLike.abort}).
 */
export interface RouteLike {
    /** Reject the intercepted request (fail-closed); `errorCode` is a Playwright abort reason. */
    abort: (errorCode?: string) => Promise<void>;
    /** Allow the intercepted request to proceed. */
    continue: () => Promise<void>;
    /** The intercepted request: its URL and (when available) whether it is a top-level navigation. */
    request: () => { isNavigationRequest?: () => boolean; url: () => string };
}

/**
 * Minimal projection of a Playwright `Page` — just the methods the helpers drive.
 * Declared structurally so a test can inject a plain stub instead of a real
 * headless page (which needs workerd + the Browser Rendering binding).
 * @experimental
 */
export interface PageLike {
    /** Return the page's serialized HTML after the navigation settles. */
    content: () => Promise<string>;
    /** Run a function in the page context and return its (serializable) result. */
    evaluate: <T>(function_: () => T) => Promise<T>;

    /** Navigate to a URL; resolves once the configured wait condition is met. */
    goto: (url: string, options?: { timeout?: number; waitUntil?: "commit" | "domcontentloaded" | "load" | "networkidle" }) => Promise<unknown>;
    /** Render the page to a PDF buffer. */
    pdf: (options?: Record<string, unknown>) => Promise<Uint8Array>;

    /**
     * Register a request interceptor (Playwright `page.route`). Optional: a fake
     * or older page double without it still works — the SSRF redirect guard only
     * activates when interception is available, and the initial-URL guard applies
     * regardless. `pattern` follows Playwright's glob/URL matcher.
     */
    route?: (pattern: string, handler: (route: RouteLike) => unknown) => Promise<void>;
    /** Render the page to a PNG/JPEG buffer. */
    screenshot: (options?: Record<string, unknown>) => Promise<Uint8Array>;
    /** Constrain the page viewport (a hard cap so a hostile page can't pin the worker). */
    setViewportSize?: (viewport: { height: number; width: number }) => Promise<void>;
}

/**
 * Minimal projection of a Playwright `BrowserContext`. Only `newPage` is used;
 * declared structurally for the same test-double reason as {@link PageLike}.
 * @experimental
 */
export interface BrowserContextLike {
    newPage: () => Promise<PageLike>;
}

/**
 * Minimal projection of a Playwright `Browser` (the value `launch` resolves to).
 * Only `newContext`/`close` are used; declared structurally for the same
 * test-double reason as {@link PageLike}.
 * @experimental
 */
export interface BrowserLike {
    close: () => Promise<void>;
    newContext: () => Promise<BrowserContextLike>;

    /**
     * The Browser Rendering session this browser is attached to, when the
     * runtime exposes it.
     *
     * Optional because this is a structural projection, not a re-declaration of
     * the upstream Playwright type — but without it there is no way to learn
     * the id of a session you just held open with `launch(fn, { keepAlive })`,
     * which makes {@link Browser.connect} unreachable except by guessing from
     * {@link Browser.sessions}.
     */
    sessionId?: () => string | undefined;
}

/* eslint-disable no-secrets/no-secrets -- the entropy scanner trips on the repeated `@cloudflare/playwright` package name in these doc comments, not a credential */

/**
 * Structural projection of `@cloudflare/playwright`'s `launch` export
 * (`import { launch } from "@cloudflare/playwright"`). Injected via
 * {@link LunoraBrowserOptions.launch} so the factory never imports
 * `@cloudflare/playwright` at module top — that keeps the heavy optional peer
 * dep out of the bundle for apps that never screenshot, and lets tests pass a
 * fake. Calling it with the Browser Rendering binding resolves a {@link BrowserLike}.
 * @experimental
 */
export type BrowserLaunchLike = (binding: BrowserBindingLike, options?: Record<string, unknown>) => Promise<BrowserLike>;

/**
 * One live Browser Rendering session, as `@cloudflare/playwright`'s `sessions()`
 * reports it. `connectionId` is set while another worker holds the session — you
 * can only {@link Browser.connect} to a free one.
 * @experimental
 */
export interface BrowserSession {
    connectionId?: string;
    sessionId: string;
    startTime?: number;
}

/**
 * Structural projection of `@cloudflare/playwright`'s `connect` export —
 * re-attaches to an existing session rather than starting a new browser.
 * Injected like {@link BrowserLaunchLike} so the peer dep stays optional.
 * @experimental
 */
export type BrowserConnectLike = (binding: BrowserBindingLike, sessionId: string) => Promise<BrowserLike>;

/**
 * Structural projection of `@cloudflare/playwright`'s `sessions` export — lists
 * the account's live Browser Rendering sessions for this binding.
 * @experimental
 */
export type BrowserSessionsLike = (binding: BrowserBindingLike) => Promise<ReadonlyArray<BrowserSession>>;

/**
 * Options shared by the page-driving helpers ({@link Browser.screenshot} etc.).
 * @experimental
 */
export interface NavigateOptions {
    /**
     * Hard timeout in milliseconds for the navigation + operation. Clamped to a
     * sane ceiling so a hung/hostile page can't pin the worker. Default 30000.
     */
    timeoutMs?: number;

    /**
     * Playwright navigation wait condition. Playwright's set differs from
     * Puppeteer's: `load`, `domcontentloaded`, `networkidle`, `commit`.
     * Default `load`.
     */
    waitUntil?: "commit" | "domcontentloaded" | "load" | "networkidle";
}

/**
 * Options for {@link Browser.screenshot}.
 * @experimental
 */
export interface ScreenshotOptions extends NavigateOptions {
    /** Capture the full scrollable page rather than just the viewport. */
    fullPage?: boolean;
    /** Image encoding. Default `png`. */
    type?: "jpeg" | "png";

    /**
     * Viewport size. Each dimension is hard-capped (see the factory's
     * `MAX_VIEWPORT_*`) so a caller can't request a multi-million-pixel render.
     */
    viewport?: { height: number; width: number };
}

/**
 * Options for {@link Browser.pdf}.
 * @experimental
 */
export interface PdfOptions extends NavigateOptions {
    /** Paper format (`A4`, `Letter`, …) forwarded to Playwright. */
    format?: string;
    /** Print background graphics. Default `false`. */
    printBackground?: boolean;

    /**
     * Viewport used while laying out the page before printing. Hard-capped like
     * {@link ScreenshotOptions.viewport}.
     */
    viewport?: { height: number; width: number };
}

/**
 * `LunoraBrowserOptions` is part of the experimental `@lunora/browser` API and may change without a major version bump.
 * @experimental
 */
export interface LunoraBrowserOptions {
    /**
     * Strict host allowlist. When set (non-empty), a navigation URL is refused
     * unless its hostname exactly matches one of these entries (case-insensitive,
     * trailing-dot-normalized, IPv6 brackets stripped). This is the only guard
     * that fully closes DNS rebinding: a public hostname that resolves to a
     * private/metadata IP can still be pinned out if it isn't on the list. Set it
     * whenever you pass client-controlled URLs to the browser.
     *
     * Leaving it unset (the default) is NOT unguarded: it turns
     * {@link LunoraBrowserOptions.resolveDns} on, so every host is resolved over
     * DoH and refused if it maps to a private address. Setting an allowlist turns
     * that re-check off (the allowlist is the stronger guard, and may deliberately
     * name an internal host); `resolveDns: true` forces both.
     */
    allowedHosts?: string[];

    /**
     * Opt out of the SSRF guard that, by default, refuses to navigate to a
     * private / internal / loopback / link-local host (RFC1918, `127.0.0.0/8`,
     * `169.254.0.0/16` incl. the cloud-metadata address, CGNAT, IPv6 ULA/
     * link-local, and `localhost` / `*.internal` / `*.local` literals). Leave it
     * `false` (the default) unless every caller-supplied URL is trusted — e.g.
     * you deliberately drive the browser at an internal service reachable through
     * a Cloudflare Tunnel / private-network binding. Setting it `true` re-opens
     * the SSRF surface, so never combine it with caller-controlled URLs.
     */
    allowPrivateTargets?: boolean;

    /** The Cloudflare Browser Rendering binding (`env.BROWSER`). Required. */
    binding: BrowserBindingLike;

    /**
     * The `@cloudflare/playwright` `connect` function, injected like
     * {@link LunoraBrowserOptions.launch}. Required for {@link Browser.connect}.
     */
    connect?: BrowserConnectLike;

    /**
     * The `@cloudflare/playwright` `launch` function. Injected rather than
     * imported at module top so the optional peer dep stays out of the bundle
     * for non-browser apps and tests can pass a double. The generated worker
     * passes the real function; omitting it makes the helper throw on first use
     * with a clear "install `@cloudflare/playwright`" error.
     */
    launch?: BrowserLaunchLike;

    /**
     * Best-effort DNS-rebinding re-check. When `true` (and `allowPrivateTargets`
     * is `false`), the factory resolves the URL's hostname over Cloudflare DoH
     * (`https://cloudflare-dns.com/dns-query`) and refuses to navigate if any
     * resolved A/AAAA record is a private/internal address — closing the gap
     * where a public hostname resolves to a private IP after the string guard
     * passes.
     *
     * **On by default when no {@link LunoraBrowserOptions.allowedHosts} is set**,
     * because a `scrape`/`screenshot` action that forwards a client-supplied URL
     * is the common shape and the string guard alone lets
     * `http://127.0.0.1.nip.io:8787/…` through to an internal service. It costs
     * one DNS round-trip per navigation and is TOCTOU-imperfect (the browser
     * re-resolves independently), and if the DoH lookup itself fails it falls
     * back to the string guard rather than allowing a resolved private IP.
     *
     * Configuring `allowedHosts` turns it OFF by default: an exact-origin
     * allowlist is the stronger guard and may deliberately name an internal host
     * (reachable over a Tunnel / private-network binding) that a resolved-address
     * check would refuse. Set this explicitly to `true` to run both, or to
     * `false` for trusted, non-caller-supplied URLs where the round-trip matters.
     */
    resolveDns?: boolean;
    /* eslint-enable no-secrets/no-secrets */

    /**
     * The `@cloudflare/playwright` `sessions` function, injected like
     * {@link LunoraBrowserOptions.launch}. Required for {@link Browser.sessions}.
     */
    sessions?: BrowserSessionsLike;

    /**
     * Default navigation timeout (ms) applied when a per-call `timeoutMs` is not
     * given. Clamped to the factory's `MAX_TIMEOUT_MS`. Default 30000.
     */
    timeoutMs?: number;
}

/**
 * The `ctx.browser` surface — Cloudflare Browser Rendering driven through
 * `@cloudflare/playwright`. **Action-only**: every method performs
 * non-deterministic network I/O (it navigates a real headless browser to a
 * URL), so codegen wires it onto `ActionCtx` exclusively — never `QueryCtx`/
 * `MutationCtx` — exactly like `ctx.ai` / `ctx.fetch`. Each helper launches a
 * browser, opens a context + page, navigates, performs the op, and always
 * closes the browser in a `finally` (a leaked session is billed and
 * rate-limited).
 * @experimental
 */
export interface Browser {
    /**
     * Re-attach to an existing session and hand the browser to `fn`.
     *
     * Get the id either by reading it inside the call that opened the session
     * (`launch(async (browser) => browser.sessionId?.(), { keepAlive: 600 })`)
     * and persisting it, or by picking a free one out of
     * {@link Browser.sessions} — an entry with a `connectionId` is already held
     * by another worker.
     *
     * The session is deliberately **left open** afterwards — closing it is the
     * whole thing you are avoiding. Close it when the flow is done by passing
     * `close: true`, or let `keepAlive` lapse.
     *
     * This is what makes agent-style browsing possible: a model calls
     * `navigate`, then `click`, then `extract` as three separate action
     * invocations, and the page has to survive between them. With only the
     * per-call lifecycle each step got a fresh browser, so `click` ran against
     * a blank page — silently, which is the worst shape for that bug.
     */
    connect: <T>(sessionId: string, function_: (browser: BrowserLike) => Promise<T>, options?: { close?: boolean }) => Promise<T>;

    /** Serialized HTML of `url` after navigation settles. */
    content: (url: string, options?: NavigateOptions) => Promise<string>;

    /**
     * Low-level escape hatch: launch a raw Playwright `Browser` and hand it to
     * `fn` (e.g. for multi-page flows or APIs not surfaced here).
     *
     * The browser is **always closed** when `fn` resolves or throws — unless
     * `keepAlive` is set, which holds the session open for that many seconds so
     * a later {@link Browser.connect} can re-attach. Do not retain references to
     * the browser past the callback either way.
     */
    launch: <T>(function_: (browser: BrowserLike) => Promise<T>, options?: { keepAlive?: number }) => Promise<T>;

    /** Render `url` to a PDF buffer. */
    pdf: (url: string, options?: PdfOptions) => Promise<Uint8Array>;

    /**
     * Navigate to `url`, run `fn` inside the page context, and return its
     * (serializable) result. `fn` runs in the browser, not the worker — it
     * cannot close over worker-side variables.
     */
    scrape: <T>(url: string, function_: (...args: never[]) => T, options?: NavigateOptions) => Promise<T>;

    /** Render `url` to an image buffer (PNG by default). */
    screenshot: (url: string, options?: ScreenshotOptions) => Promise<Uint8Array>;

    /**
     * List the live Browser Rendering sessions for this binding, so a caller can
     * pick a free one to {@link Browser.connect} to. An entry with a
     * `connectionId` is already held by another worker.
     */
    sessions: () => Promise<ReadonlyArray<BrowserSession>>;
}
