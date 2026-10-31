import { digestAdminTokenSecret, parseAdminTokenHeader } from "../../../shared/admin-token";
import { evictOldestEntry } from "../../../shared/evict-oldest";

/**
 * How long one isolate trusts a verified named token without asking the store
 * again — and therefore the bound on how long a revoked token keeps working on
 * an isolate that is not the one that revoked it. Never past the token's own expiry.
 */
const ADMIN_TOKEN_CACHE_TTL_MS = 30_000;

/**
 * How long a refusal is remembered without asking the store again, so a stream of
 * well-formed guesses cannot each cost a shard round trip. A name the store does
 * not know is refused name-wide, whatever the secret; a known name with a wrong
 * secret only for that secret, so guesses never lock out the real token. The
 * name-wide entry is also how long a token created on ANOTHER isolate can be
 * refused here after its name was guessed; the creating isolate clears it.
 */
const ADMIN_TOKEN_REFUSAL_TTL_MS = 5000;

/** Bounds the refusal cache, so a flood of distinct guesses evicts the oldest instead of growing memory. */
const ADMIN_TOKEN_REFUSAL_CAPACITY = 1024;

/**
 * Lookups of names this isolate has never seen the store confirm, allowed in a
 * burst and then refilled at {@link ADMIN_TOKEN_UNKNOWN_NAME_REFILL_MS}. Without
 * it, an anonymous caller sending a fresh well-formed name on every request
 * forces a default-shard round trip per request (the shard that also serves the
 * app's data), and the bounded refusal cache cannot help against distinct names.
 *
 * When the budget is spent an unknown name is not looked up on its own. Instead the
 * isolate refreshes its set of CONFIRMED names from the store, one listing at most
 * every {@link ADMIN_TOKEN_NAME_REFRESH_MS} however many requests ask: a flood of
 * invented names costs the store that one listing, and cannot lock out a real
 * token, because every token that exists is in the listing and a listed name
 * never spends budget. A name created since the last listing is refused until the
 * next one, so a brand-new token's first use on another isolate can be refused
 * once during a flood and works on retry. A name the store has confirmed (live
 * token, or a known name with a wrong secret) never spends budget, so established
 * tokens are unaffected by a flood.
 */
const ADMIN_TOKEN_UNKNOWN_NAME_BURST = 20;

/** One unknown-name lookup is earned back this often. */
const ADMIN_TOKEN_UNKNOWN_NAME_REFILL_MS = 1000;

/** At most one name listing per isolate in this window, however many requests ask for it. */
const ADMIN_TOKEN_NAME_REFRESH_MS = 5000;

/** Bounds the set of names the store has confirmed, which only the store's own answers can grow. */
const ADMIN_TOKEN_KNOWN_NAME_CAPACITY = 1024;

interface AdminTokenVerifier {
    /**
     * Forget everything this isolate knows about `name`: drop its cached grants and
     * refusals, and void any lookup already in flight. Called on revoke (so the
     * token is refused at once) and on create (so an earlier refusal of the name
     * cannot block the new token).
     */
    evict: (name: string) => void;

    /**
     * The token an `Authorization` header authenticates as, and until when this
     * isolate vouches for it (never past the token's expiry), plus that expiry, or `undefined`. A
     * malformed bearer never reaches `lookup`.
     */
    verify: (authorization: null | string) => Promise<AdminTokenGrant | undefined>;
}

interface AdminTokenVerifierOptions {
    /**
     * Every token name the store holds. Read rarely, to learn the names that are real when the
     * unknown-name budget is spent; absent, an isolate in a flood has no way to admit a real name.
     */
    listNames?: () => Promise<string[]>;
    /** Whether the store holds a live token `name` with this secret digest (and its expiry), or why not. Must not throw on refusal. */
    lookup: (name: string, digest: string) => Promise<AdminTokenLookup>;
    now?: () => number;
}

/**
 * `transient` marks a refusal the store did not decide (it was unreachable or
 * answered garbage): it fails closed but is not remembered, so the real token
 * works again as soon as the store does.
 */
type AdminTokenLookup = { expiresAt?: number; live: true } | { live: false; nameKnown: boolean; transient?: boolean };

interface AdminTokenGrant {
    /** The token's own expiry, when it has one. Unlike `until`, which is only the cache window. */
    expiresAt?: number;
    name: string;
    until: number;
}

type CacheEntry = AdminTokenGrant;

const createAdminTokenVerifier = ({ listNames, lookup, now = Date.now }: AdminTokenVerifierOptions): AdminTokenVerifier => {
    // Keyed by name AND digest, so a cached entry for one secret never vouches for another.
    const verifiedUntil = new Map<string, CacheEntry>();
    const refusedUntil = new Map<string, CacheEntry>();
    // Bumped by `evict`. A lookup that started under an older epoch raced a revoke
    // (or create), so its answer is stale and is neither cached nor trusted.
    const epochs = new Map<string, number>();
    // Lookups already asking the store, so callers whose cache entry lapsed together (a busy CI
    // token, a fan-out wave) share one round trip. `evict` drops them: a caller arriving after a
    // revoke must ask the store itself, never receive an answer that started before it.
    const inFlight = new Map<string, Promise<AdminTokenLookup>>();
    // Names the store has confirmed exist; the only names allowed to look up without budget.
    const knownNames = new Map<string, true>();
    let budget = ADMIN_TOKEN_UNKNOWN_NAME_BURST;
    let refilledAt = now();

    const spendUnknownNameBudget = (): boolean => {
        const elapsed = now() - refilledAt;
        const earned = Math.floor(elapsed / ADMIN_TOKEN_UNKNOWN_NAME_REFILL_MS);

        if (earned > 0) {
            budget = Math.min(ADMIN_TOKEN_UNKNOWN_NAME_BURST, budget + earned);
            refilledAt += earned * ADMIN_TOKEN_UNKNOWN_NAME_REFILL_MS;
        }

        if (budget <= 0) {
            return false;
        }

        budget -= 1;

        return true;
    };

    const dropName = (cache: Map<string, CacheEntry>, name: string): void => {
        for (const [key, entry] of cache) {
            if (entry.name === name) {
                cache.delete(key);
            }
        }
    };

    const rememberName = (name: string): void => {
        if (!knownNames.has(name)) {
            evictOldestEntry(knownNames, ADMIN_TOKEN_KNOWN_NAME_CAPACITY);
            knownNames.set(name, true);
        }
    };

    // One listing in flight at a time, and one per interval: concurrent and repeated askers share it.
    let namesRefreshedAt = Number.NEGATIVE_INFINITY;
    let namesRefresh: Promise<void> | undefined;

    const refreshKnownNames = (): Promise<void> => {
        if (namesRefresh !== undefined) {
            return namesRefresh;
        }

        if (listNames === undefined || now() - namesRefreshedAt < ADMIN_TOKEN_NAME_REFRESH_MS) {
            return Promise.resolve();
        }

        namesRefreshedAt = now();
        namesRefresh = (async (): Promise<void> => {
            try {
                for (const name of await listNames()) {
                    rememberName(name);
                }
            } catch {
                // An unreachable store admits nothing: the names stay unconfirmed and the next window retries.
            } finally {
                namesRefresh = undefined;
            }
        })();

        return namesRefresh;
    };

    /** The budget is spent: ask which names are real, and admit this one only if it is. */
    const admitAfterRefresh = async (name: string): Promise<boolean> => {
        await refreshKnownNames();

        return knownNames.has(name);
    };

    const startLookup = (name: string, digest: string, key: string): Promise<AdminTokenLookup> => {
        const started = lookup(name, digest);

        inFlight.set(key, started);

        const settled = (): void => {
            if (inFlight.get(key) === started) {
                inFlight.delete(key);
            }
        };

        started.finally(settled).catch(() => undefined);

        return started;
    };

    const refuse = (name: string, key: string, nameKey: string, nameKnown: boolean): void => {
        if (nameKnown) {
            rememberName(name);
        } else {
            knownNames.delete(name);
        }

        evictOldestEntry(refusedUntil, ADMIN_TOKEN_REFUSAL_CAPACITY);
        refusedUntil.set(nameKnown ? key : nameKey, { name, until: now() + ADMIN_TOKEN_REFUSAL_TTL_MS });
    };

    return {
        evict: (name) => {
            dropName(verifiedUntil, name);
            dropName(refusedUntil, name);
            knownNames.delete(name);

            for (const key of inFlight.keys()) {
                if (key.startsWith(`${name}\u0000`)) {
                    inFlight.delete(key);
                }
            }

            epochs.set(name, (epochs.get(name) ?? 0) + 1);
        },
        verify: async (authorization) => {
            const parsed = parseAdminTokenHeader(authorization);

            if (parsed === undefined) {
                return undefined;
            }

            const { name } = parsed;
            const digest = await digestAdminTokenSecret(parsed.secret);
            const key = `${name}\u0000${digest}`;
            const nameKey = `${name}\u0000*`;

            const cached = verifiedUntil.get(key);

            if (cached !== undefined && cached.until > now()) {
                return cached;
            }

            if ((refusedUntil.get(nameKey)?.until ?? 0) > now() || (refusedUntil.get(key)?.until ?? 0) > now()) {
                return undefined;
            }

            verifiedUntil.delete(key);
            refusedUntil.delete(key);
            refusedUntil.delete(nameKey);

            const epoch = epochs.get(name);
            let pending = inFlight.get(key);

            if (pending === undefined) {
                // The budget check is synchronous, so a burst of concurrent requests cannot overdraw it,
                // and a lookup that is allowed starts in the same tick so concurrent callers still share it.
                const admitted = knownNames.has(name) || spendUnknownNameBudget();

                if (!admitted && !(await admitAfterRefresh(name))) {
                    return undefined;
                }

                pending = startLookup(name, digest, key);
            }

            const live = await pending;

            if (epochs.get(name) !== epoch) {
                return undefined;
            }

            if (!live.live) {
                if (live.transient === true) {
                    return undefined;
                }

                refuse(name, key, nameKey, live.nameKnown);

                return undefined;
            }

            // The store checked expiry when it answered; the token may have expired while the answer was in flight.
            const until = Math.min(now() + ADMIN_TOKEN_CACHE_TTL_MS, live.expiresAt ?? Number.POSITIVE_INFINITY);

            if (until <= now()) {
                return undefined;
            }

            rememberName(name);

            const grant: AdminTokenGrant = { name, until, ...(live.expiresAt === undefined ? {} : { expiresAt: live.expiresAt }) };

            verifiedUntil.set(key, grant);

            return grant;
        },
    };
};

export type { AdminTokenGrant, AdminTokenLookup, AdminTokenVerifier };
export { ADMIN_TOKEN_CACHE_TTL_MS, ADMIN_TOKEN_NAME_REFRESH_MS, ADMIN_TOKEN_REFUSAL_TTL_MS, ADMIN_TOKEN_UNKNOWN_NAME_BURST, createAdminTokenVerifier };
