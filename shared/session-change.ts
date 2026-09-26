/**
 * A page-wide "the auth session may have changed" signal between the code that
 * changes a session and the Lunora clients that must re-resolve it — in this
 * tab and in every other tab of the browser profile.
 *
 * Under a cookie session nothing a `LunoraClient` can observe changes when the
 * user signs in or out: the cookie is `HttpOnly` and set by a request the
 * client did not make. Whoever DID make it — the better-auth fetch plugin in
 * `@lunora/auth/plugins/client`, `@lunora/auth-ui`'s flows — calls
 * {@link notifySessionChanged}; every live `LunoraClient` in the page has
 * registered through {@link onSessionChanged} and asks `/get-session` who is
 * signed in now. The two sides share no import, so neither package depends on
 * the other.
 *
 * The cookie jar is shared by every tab, so a change in one tab is a change in
 * all of them. {@link notifySessionChanged} also posts on a `BroadcastChannel`,
 * and a tab with listeners re-runs them when another tab posts — without
 * posting in turn, so tabs cannot echo each other. better-auth's own cross-tab
 * sign-out message (a `localStorage` write, seen here as a `storage` event) is
 * a second trigger, for apps that do not route their auth calls through the
 * plugin. Browser only: off a page there is no cookie jar to share, so nothing
 * is posted or listened for.
 *
 * **Same-origin tabs only.** Both a `BroadcastChannel` and a `storage` event
 * are scoped to one origin. A tab on another origin that shares the cookie —
 * `app.example.com` beside `admin.example.com` under a parent-domain cookie —
 * hears nothing: it switches identity when its socket next reconnects. Its
 * writes stay safe meanwhile, because every replay names the user that queued
 * it and the worker refuses it for anyone else.
 *
 * Keyed on a `Symbol.for` global, so copies of this file inlined into separate
 * bundles (it is bundler-inlined, not a package) still share one registry, one
 * tab id and one channel.
 *
 * Deliberately **not** a package: keep it zero-dependency. Consumers drop
 * `outDir`/`rootDir` from their `tsconfig.json` (see `shared/` in AGENTS.md).
 */

const STATE_KEY = Symbol.for("lunora:session-change");

/** The channel every tab posts to and listens on. */
const CHANNEL_NAME = "lunora:session-change";

/** better-auth's cross-tab message key, and the trigger in it that can change who is signed in. */
const BETTER_AUTH_MESSAGE_KEY = "better-auth.message";
const BETTER_AUTH_SIGN_OUT = "signout";

/** A listener may return the work it started, so {@link notifySessionChanged} can wait for it. */
type Listener = () => unknown;

interface SessionChangeMessage {
    /** The posting tab, so a tab ignores the echo of its own post. */
    tab: string;
    type: "lunora:session-change";
}

interface State {
    /** Stops listening to other tabs; set while there are listeners in a browser. */
    detach: (() => void) | undefined;
    listeners: Set<Listener>;
    tab: string;
}

const state = (): State => {
    const holder = globalThis as unknown as Record<symbol, State | undefined>;
    let current = holder[STATE_KEY];

    if (current === undefined) {
        current = { detach: undefined, listeners: new Set(), tab: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` };
        holder[STATE_KEY] = current;
    }

    return current;
};

const inBrowser = (): boolean => "document" in globalThis;

/** Run every registered listener; settles once the work they returned has. Never rejects. */
const runListeners = async (): Promise<void> => {
    const pending: unknown[] = [];

    for (const listener of state().listeners) {
        try {
            pending.push(listener());
        } catch {
            /* one listener's failure is not the others' concern */
        }
    }

    await Promise.allSettled(pending);
};

/** Whether a `storage` event is better-auth telling the other tabs of a sign-out. */
const isBetterAuthSignOut = (key: null | string, value: null | string): boolean => {
    if (key !== BETTER_AUTH_MESSAGE_KEY || value === null) {
        return false;
    }

    try {
        const message = JSON.parse(value) as { data?: { trigger?: unknown }; event?: unknown } | null;

        return message?.event === "session" && message.data?.trigger === BETTER_AUTH_SIGN_OUT;
    } catch {
        return false;
    }
};

/** Listen to the other tabs. Returns the function that stops. */
const attachToOtherTabs = (tab: string): (() => void) => {
    const stops: (() => void)[] = [];
    const onRemote = (): void => {
        // Local listeners only: re-posting is what would let tabs echo each other.
        runListeners().catch(() => undefined);
    };

    // An opaque-origin document (a sandboxed iframe, `data:`) refuses to build a
    // channel at all. That must not take the `LunoraClient` constructor down
    // with it, nor cost the `storage` trigger below: go on without the channel.
    let channel: BroadcastChannel | undefined;

    try {
        channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL_NAME) : undefined;
    } catch {
        channel = undefined;
    }

    if (channel !== undefined) {
        const open = channel;

        open.addEventListener("message", (event: MessageEvent<Partial<SessionChangeMessage> | null>) => {
            if (event.data?.type === "lunora:session-change" && event.data.tab !== tab) {
                onRemote();
            }
        });
        stops.push(() => {
            open.close();
        });
    }

    const page = globalThis as unknown as {
        addEventListener?: (type: string, listener: (event: { key: null | string; newValue: null | string }) => void) => void;
        removeEventListener?: (type: string, listener: (event: { key: null | string; newValue: null | string }) => void) => void;
    };

    if (typeof page.addEventListener === "function") {
        const onStorage = (event: { key: null | string; newValue: null | string }): void => {
            if (isBetterAuthSignOut(event.key, event.newValue)) {
                onRemote();
            }
        };

        page.addEventListener("storage", onStorage);
        stops.push(() => {
            page.removeEventListener?.("storage", onStorage);
        });
    }

    return () => {
        for (const stop of stops) {
            stop();
        }
    };
};

/**
 * Register a listener for a session change in this tab or any other. Returns
 * the unregister function; the last one to unregister stops the tab listening
 * to the others.
 */
const onSessionChanged = (listener: Listener): (() => void) => {
    const current = state();

    current.listeners.add(listener);

    if (current.detach === undefined && inBrowser()) {
        current.detach = attachToOtherTabs(current.tab);
    }

    return () => {
        current.listeners.delete(listener);

        if (current.listeners.size === 0) {
            current.detach?.();
            current.detach = undefined;
        }
    };
};

/**
 * Tell every registered listener — in this tab, and in the others — that the
 * session may have changed. Resolves once the work this tab's listeners
 * returned has settled (for a `LunoraClient`, its re-resolve of who is signed
 * in); the other tabs re-resolve on their own. Never rejects: a listener that
 * throws or whose work fails never stops, or fails, the others.
 */
const notifySessionChanged = async (): Promise<void> => {
    if (inBrowser() && typeof BroadcastChannel === "function") {
        try {
            const channel = new BroadcastChannel(CHANNEL_NAME);

            channel.postMessage({ tab: state().tab, type: "lunora:session-change" } satisfies SessionChangeMessage);
            channel.close();
        } catch {
            /* the other tabs re-resolve on their next reconnect instead */
        }
    }

    await runListeners();
};

export { notifySessionChanged, onSessionChanged };
