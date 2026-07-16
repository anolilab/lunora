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
    readonly fetch: (...args: never[]) => unknown;
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
    evaluate: <T>(function_: (...args: never[]) => T) => Promise<T>;

    /** Navigate to a URL; resolves once the configured wait condition is met. */
    goto: (url: string, options?: { timeout?: number; waitUntil?: string }) => Promise<unknown>;
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
     * whenever you pass client-controlled URLs to the browser. Leave it unset (the
     * default) to keep the previous behavior (only the string-based SSRF guard).
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
     * The `@cloudflare/playwright` `launch` function. Injected rather than
     * imported at module top so the optional peer dep stays out of the bundle
     * for non-browser apps and tests can pass a double. The generated worker
     * passes the real function; omitting it makes the helper throw on first use
     * with a clear "install `@cloudflare/playwright`" error.
     */
    launch?: BrowserLaunchLike;
    /* eslint-enable no-secrets/no-secrets */

    /**
     * Best-effort DNS-rebinding re-check. When `true` (and `allowPrivateTargets`
     * is `false`), the factory resolves the URL's hostname over Cloudflare DoH
     * (`https://cloudflare-dns.com/dns-query`) and refuses to navigate if any
     * resolved A/AAAA record is a private/internal address — closing the gap
     * where a public hostname resolves to a private IP after the string guard
     * passes. Off by default: it adds a DNS round-trip and is TOCTOU-imperfect
     * (the browser re-resolves independently). If the DoH lookup itself fails, it
     * falls back to the string guard rather than allowing a resolved private IP.
     * For a hard guarantee prefer {@link LunoraBrowserOptions.allowedHosts}.
     */
    resolveDns?: boolean;

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
    /** Serialized HTML of `url` after navigation settles. */
    content: (url: string, options?: NavigateOptions) => Promise<string>;

    /**
     * Low-level escape hatch: launch a raw Playwright `Browser` and hand it to
     * `fn` (e.g. for multi-page flows or APIs not surfaced here). The browser is
     * **always closed** when `fn` resolves or throws — do not retain references
     * to it past the callback.
     */
    launch: <T>(function_: (browser: BrowserLike) => Promise<T>) => Promise<T>;

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
}
