import type { BetterAuthOptions } from "better-auth";

/**
 * Lunora-friendly view over better-auth's `session` option.
 *
 * This is a typed alias for better-auth's own `session` shape — Lunora stays a
 * thin wrapper, so we don't reimplement the fields, we just give them a named,
 * documented home so callers get autocomplete without reaching into
 * `BetterAuthOptions`. The most relevant fields for session rotation / richer
 * policies are `expiresIn` (absolute session lifetime, in seconds),
 * `updateAge` (rolling-rotation interval, in seconds — how often an active
 * session's expiry is pushed forward; `0` rotates on every use),
 * `disableSessionRefresh` (turn rolling rotation off entirely so sessions
 * expire at the absolute `expiresIn` regardless of activity), `freshAge`
 * (freshness window, in seconds, for sensitive operations like account
 * deletion; `0` treats every session as fresh — not recommended), and
 * `cookieCache` (signed-cookie session cache that skips DB reads —
 * `createAuth` fills `{ enabled: true, maxAge: 60 }` when you leave it unset, so
 * a revoked session keeps authenticating for up to that many seconds; pass
 * `{ enabled: false }` where that window is unacceptable).
 *
 * See better-auth's `session` option for the full field list.
 */
type SessionPolicy = NonNullable<BetterAuthOptions["session"]>;

/** One minute, expressed in seconds — for readable preset arithmetic. */
const MINUTE = 60;

const HOUR = 60 * MINUTE;

const DAY = 24 * HOUR;

/**
 * Validate a {@link SessionPolicy} and return it unchanged (pass-through).
 *
 * better-auth happily accepts the `session` block verbatim, so the only job
 * here is to catch obviously-broken numeric inputs at construction time —
 * negative or non-finite durations — rather than letting them produce
 * surprising cookie expiries at runtime. Field names mirror better-auth's
 * `session` option exactly so the validated object forwards 1:1.
 */
const validateSessionPolicy = (policy: SessionPolicy): SessionPolicy => {
    const durationFields = ["expiresIn", "updateAge", "freshAge"] as const;

    for (const field of durationFields) {
        const value = (policy as Record<string, unknown>)[field];

        if (value === undefined) {
            continue;
        }

        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            throw new TypeError(`@lunora/auth: \`session.${field}\` must be a non-negative, finite number of seconds`);
        }
    }

    return policy;
};

/**
 * Ready-made {@link SessionPolicy} presets covering the common rotation /
 * expiry trade-offs. Spread or override fields as needed:
 *
 * ```ts
 * import { createAuth, sessionPresets } from "@lunora/auth";
 *
 * export const auth = createAuth({
 *     secret: env.AUTH_SECRET,
 *     database: env.DB,
 *     session: { ...sessionPresets.rolling, freshAge: 60 * 5 },
 * });
 * ```
 *
 * - `rolling` — balanced default: 7-day absolute expiry, rotated once per day,
 *   with a 60s signed-cookie session cache so bursts of authenticated calls
 *   skip the per-request DB session read.
 * - `strict` — short, security-sensitive: 1-hour expiry, 15-minute rotation,
 *   cookie cache **off** (fast revocation / short freshness is the whole point).
 * - `longLived` — low-friction consumer apps: 30-day expiry, daily rotation,
 *   with the same 60s cookie cache as `rolling`.
 */
const sessionPresets: Record<"longLived" | "rolling" | "strict", SessionPolicy> = {
    longLived: {
        cookieCache: { enabled: true, maxAge: 60 },
        expiresIn: 30 * DAY,
        freshAge: DAY,
        updateAge: DAY,
    },
    rolling: {
        cookieCache: { enabled: true, maxAge: 60 },
        expiresIn: 7 * DAY,
        freshAge: DAY,
        updateAge: DAY,
    },
    strict: {
        cookieCache: { enabled: false },
        expiresIn: HOUR,
        freshAge: 5 * MINUTE,
        updateAge: 15 * MINUTE,
    },
};

export type { SessionPolicy };
export { sessionPresets, validateSessionPolicy };
