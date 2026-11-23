import type { BetterAuthOptions } from "better-auth";

type CookieCache = NonNullable<NonNullable<BetterAuthOptions["session"]>["cookieCache"]>;

/**
 * The session cookie cache `createAuth` runs `options` with: the caller's own when set, else the default. The
 * default is a 60 s cache, or none with better-auth's `admin()` plugin: the cache serves the pre-ban user and
 * `banUser` deletes sessions the cache does not consult, so a ban would wait out the window. The worker's identity
 * memo derives its window from this too, so the two cannot disagree about whether a ban is immediate.
 */
const effectiveCookieCache = (options: Pick<BetterAuthOptions, "plugins" | "session">): CookieCache => {
    if (options.session?.cookieCache !== undefined) {
        return options.session.cookieCache;
    }

    return (options.plugins ?? []).some((plugin) => plugin.id === "admin") ? { enabled: false } : { enabled: true, maxAge: 60 };
};

export { effectiveCookieCache };
export type { CookieCache };
