import type { BrowserBindingLike, BrowserContextLike, BrowserLaunchLike, BrowserLike, PageLike, RouteLike, RouteResponseLike } from "../../src/types";

/** One response of the fake network. */
interface FakeResponse {
    body?: string;
    headers?: Record<string, string>;
    status: number;
}

/** What the handlers did with one request. */
interface RouteOutcome {
    aborted?: string;
    /** Every handler fell through (`continue`, or `fallback` past the last): the browser fetches it, redirects and all. */
    continued: boolean;
    fetched: string[];
    fulfilled?: { body?: string; contentType?: string; response?: FakeApiResponse; status?: number };
}

/** What the WebSocket handler did with one socket. */
interface SocketOutcome {
    closed?: { code?: number; reason?: string };
    connected: boolean;
}

interface FakeApiResponse extends RouteResponseLike {
    readonly url: string;
}

interface PageSpy extends PageLike {
    gotoCalls: string[];
    gotoOptions: ({ timeout?: number; waitUntil?: string } | undefined)[];
    screenshotCalls: Record<string, unknown>[];
    viewportCalls: { height: number; width: number }[];
}

interface ContextSpy extends BrowserContextLike {
    /** The registered route handlers, oldest first (Playwright runs the newest first). */
    handlers: AnyHandler[];
    pages: () => PageSpy[];
}

interface BrowserSpy extends BrowserLike {
    closed: number;
    contextList: ContextSpy[];
    contextsOpened: number;
    /** Open a context on this browser the way another connection to the session would: behind our back. */
    openForeignContext: () => ContextSpy;
    pages: PageSpy[];
}

type AnyHandler = (route: never) => unknown;

type RouteHandler = <TResponse extends RouteResponseLike>(route: RouteLike<TResponse>) => unknown;

interface FakeLaunch extends BrowserLaunchLike {
    browsers: BrowserSpy[];
    /** Hand one request to the newest context's handlers, the way Playwright does, and report what they did. */
    dispatch: (url: string, kind: { frame?: unknown; navigation: boolean }) => Promise<RouteOutcome>;
    /** Hand one WebSocket to the newest context's WebSocket handler. */
    dispatchSocket: (url: string) => Promise<SocketOutcome>;
    /** Every `launch` options object the factory passed. */
    launchOptions: (Record<string, unknown> | undefined)[];
    /** Every URL that reached the fake network, in order: what an SSRF test must keep private hosts out of. */
    requested: string[];
    /** Every handler registered with `context.route`, across all contexts. */
    routeHandlers: AnyHandler[];
}

interface FakeLaunchOptions {
    /** The browser's `close()` rejects. */
    closeThrows?: boolean;
    /** `page.goto` rejects, as a failed navigation does. */
    gotoThrows?: boolean;
    /** The network behind the browser. Default: every URL answers 200 with a small page. */
    network?: (url: string) => FakeResponse;
    /** Members to override on every page. */
    page?: Partial<PageLike>;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const PAGE_HTML = "<html><body>hi</body></html>";

const isRedirect = (response: FakeResponse): boolean => REDIRECTS.has(response.status) && response.headers?.["location"] !== undefined;

/** A binding marker the fake chain never calls; `fetch` only has to type-check. */
const fakeBinding = (): BrowserBindingLike => {
    return { fetch: async () => new Response() };
};

/**
 * A fake `@cloudflare/playwright` `launch` (browser → context → page) that models
 * the Playwright behaviour the SSRF guard rests on:
 *
 * A route handler is called for the FIRST request of a navigation only. Redirect
 * hops, whether the browser follows them after `route.continue()` or after a
 * fulfilled 3xx, reach the network without any handler seeing them.
 * `route.fetch` follows up to `maxRedirects` hops itself. Handlers run newest
 * first, and `fallback` passes to the next older one. Everything that reaches
 * the network is recorded in `requested`.
 */
const fakeLaunch = (config: FakeLaunchOptions = {}): FakeLaunch => {
    const network =
        config.network ??
        ((): FakeResponse => {
            return { body: PAGE_HTML, status: 200 };
        });
    const browsers: BrowserSpy[] = [];
    const requested: string[] = [];
    const routeHandlers: AnyHandler[] = [];
    const contexts: ContextSpy[] = [];
    const socketHandlers: ((socket: never) => unknown)[] = [];

    /** The browser fetching `url` on its own: every hop follows without a handler. */
    const browserLoad = (url: string): FakeResponse => {
        let current = url;

        for (let hop = 0; hop <= 20; hop += 1) {
            requested.push(current);

            const response = network(current);

            if (!isRedirect(response)) {
                return response;
            }

            current = new URL(response.headers?.["location"] ?? "", current).href;
        }

        throw new Error("net::ERR_TOO_MANY_REDIRECTS");
    };

    /** Follow `url` the way `route.fetch` does, up to `maxRedirects` hops. */
    const fetchFrom = (url: string, maxRedirects: number, outcome: RouteOutcome): FakeApiResponse => {
        let current = url;

        for (let hop = 0; ; hop += 1) {
            requested.push(current);
            outcome.fetched.push(current);

            const response = network(current);

            if (!isRedirect(response) || hop >= maxRedirects) {
                const finalUrl = current;

                return { headers: () => response.headers ?? {}, status: () => response.status, url: finalUrl };
            }

            current = new URL(response.headers?.["location"] ?? "", current).href;
        }
    };

    const runHandlers = async (handlers: AnyHandler[], url: string, kind: { frame?: unknown; navigation: boolean }): Promise<RouteOutcome> => {
        const outcome: RouteOutcome = { continued: false, fetched: [] };
        let index = handlers.length - 1;
        let currentUrl = url;

        const route: RouteLike<FakeApiResponse> & { fallback: (options?: { url?: string }) => Promise<void> } = {
            abort: async (errorCode) => {
                outcome.aborted = errorCode ?? "failed";
            },
            continue: async () => {
                outcome.continued = true;
            },
            fallback: async (options) => {
                currentUrl = options?.url ?? currentUrl;
                index -= 1;

                const next = handlers[index];

                if (next === undefined) {
                    outcome.continued = true;

                    return;
                }

                await (next as (route: unknown) => unknown)(route);
            },
            fetch: async (options) => fetchFrom(options?.url ?? currentUrl, options?.maxRedirects ?? 20, outcome),
            fulfill: async (options) => {
                outcome.fulfilled = options;
            },
            request: () => {
                return { frame: () => kind.frame, isNavigationRequest: () => kind.navigation, url: () => currentUrl };
            },
        };

        const newest = handlers[index];

        if (newest === undefined) {
            outcome.continued = true;
        } else {
            await (newest as (route: unknown) => unknown)(route);
        }

        return outcome;
    };

    /** The one frame every fake page reports as its main frame. */
    const mainFrame = { main: true };

    /** A page navigation: the handlers see the first request only; the browser follows every redirect after unseen. */
    const navigate = async (url: string, handlers: AnyHandler[]): Promise<void> => {
        const outcome = await runHandlers(handlers, url, { frame: mainFrame, navigation: true });

        if (outcome.aborted !== undefined) {
            throw new Error(`net::ERR_${outcome.aborted.toUpperCase()} at ${url}`);
        }

        if (outcome.continued) {
            browserLoad(url);

            return;
        }

        // A fulfilled redirect is followed by the browser, unguarded.
        const response = outcome.fulfilled?.response;
        const location = response?.headers()["location"];

        if (response !== undefined && REDIRECTS.has(response.status()) && location !== undefined) {
            browserLoad(new URL(location, response.url).href);
        }
    };

    const makeContext = (pages: PageSpy[]): ContextSpy => {
        const handlers: AnyHandler[] = [];
        const own: PageSpy[] = [];
        const pageListeners: ((page: PageSpy) => unknown)[] = [];
        let context: ContextSpy;

        const makePage = (): PageSpy => {
            const page: PageSpy & { context: () => ContextSpy } = {
                content: async () => PAGE_HTML,
                context: () => context,
                evaluate: async (function_) => function_(),
                goto: async (url, gotoOptions) => {
                    page.gotoCalls.push(url);
                    page.gotoOptions.push(gotoOptions);

                    if (config.gotoThrows) {
                        throw new Error("navigation failed");
                    }

                    await navigate(url, handlers);

                    return undefined;
                },
                gotoCalls: [],
                gotoOptions: [],
                mainFrame: () => mainFrame,
                pdf: async () => new Uint8Array([37, 80, 68, 70]),
                screenshot: async (screenshotOptions) => {
                    page.screenshotCalls.push(screenshotOptions ?? {});

                    return new Uint8Array([137, 80, 78, 71]);
                },
                screenshotCalls: [],
                setViewportSize: async (viewport) => {
                    page.viewportCalls.push(viewport);
                },
                viewportCalls: [],
                ...config.page,
            };

            return page;
        };

        const spy: ContextSpy & Record<string, unknown> = {
            handlers,
            newCDPSession: async () => {
                return {};
            },
            newPage: async () => {
                const page = makePage();

                own.push(page);
                pages.push(page);

                for (const listener of pageListeners) {
                    listener(page);
                }

                return page;
            },
            on: (event: string, listener: (page: PageSpy) => unknown) => {
                if (event === "page") {
                    pageListeners.push(listener);
                }
            },
            pages: () => own,
            route: async (_pattern, registered) => {
                handlers.push(registered);
                routeHandlers.push(registered);
            },
            routeWebSocket: async (_pattern: string, handler: (socket: never) => unknown) => {
                socketHandlers.push(handler);
            },
            unroute: async (_pattern: string, handler?: AnyHandler) => {
                const kept = handlers.filter((registered) => handler !== undefined && registered !== handler);

                handlers.splice(0, handlers.length, ...kept);
            },
            unrouteAll: async () => {
                handlers.splice(0);
            },
        };

        context = spy;
        contexts.push(spy);

        return spy;
    };

    const launch = (async (_binding: BrowserBindingLike, launchOptions?: Record<string, unknown>): Promise<BrowserLike> => {
        launch.launchOptions.push(launchOptions);

        const browser: BrowserSpy & Record<string, unknown> = {
            close: async () => {
                browser.closed += 1;

                if (config.closeThrows) {
                    throw new Error("close failed");
                }
            },
            closed: 0,
            contextList: [],
            contexts: () => browser.contextList,
            contextsOpened: 0,
            newBrowserCDPSession: async () => {
                return {};
            },
            newContext: async () => {
                browser.contextsOpened += 1;

                const context = makeContext(browser.pages);

                browser.contextList.push(context);

                return context;
            },
            openForeignContext: () => {
                const context = makeContext(browser.pages);

                browser.contextList.push(context);

                return context;
            },
            pages: [],
        };

        browsers.push(browser);

        return browser;
    }) as FakeLaunch;

    launch.browsers = browsers;
    launch.launchOptions = [];
    launch.requested = requested;
    launch.routeHandlers = routeHandlers;
    launch.dispatch = async (url, kind) => {
        const context = contexts.at(-1);

        if (context === undefined || context.handlers.length === 0) {
            throw new Error("no route handler registered");
        }

        return runHandlers(context.handlers, url, kind);
    };
    launch.dispatchSocket = async (url) => {
        const handler = socketHandlers.at(-1);

        if (handler === undefined) {
            throw new Error("no WebSocket handler registered");
        }

        const outcome: SocketOutcome = { connected: false };

        await (handler as (socket: unknown) => unknown)({
            close: async (options?: { code?: number; reason?: string }) => {
                outcome.closed = options ?? {};
            },
            connectToServer: () => {
                outcome.connected = true;
            },
            url: () => url,
        });

        return outcome;
    };

    return launch;
};

export type { BrowserSpy, ContextSpy, FakeLaunch, FakeResponse, PageSpy, RouteHandler, RouteOutcome, SocketOutcome };
export { fakeBinding, fakeLaunch };
