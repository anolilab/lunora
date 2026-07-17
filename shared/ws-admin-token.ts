/**
 * Ephemeral admin WebSocket sub-token. A browser
 * `WebSocket` can't set an `Authorization` header, so the studio's admin socket
 * credential has to ride the `?token=` query string — which lands in access
 * logs, browser history, and `Referer` headers. Instead of leaking the master
 * `LUNORA_ADMIN_TOKEN` there, the worker mints a short-lived HMAC-signed
 * sub-token (via `POST /_lunora/admin/ws-token`, itself authenticated by the
 * master token in the header) and every WS admin gate accepts it:
 *
 *     token = "v1." + expEpochMs + "." +
 *             base64url(HMAC_SHA256(key = LUNORA_ADMIN_TOKEN, msg = "v1." + expEpochMs))
 *
 * Stateless by construction: the worker and the Durable Object both hold
 * `LUNORA_ADMIN_TOKEN` in `env`, so either isolate can verify a token the other
 * minted with no shared state — and rotating the master token instantly
 * invalidates every outstanding sub-token. The default TTL is 60s: long enough
 * that workerd's coarse `Date.now()` (it advances on I/O) and a slow handshake
 * can't race the expiry, short enough that a leaked URL is stale by the time a
 * log is read.
 *
 * The HMAC envelope (base64url codec, key cache, constant-time verify via
 * `crypto.subtle.verify`) is `shared/hmac-url.ts` — the one canonical
 * definition, so a padding or verify fix there covers this token too.
 *
 * Like its siblings, this is deliberately **not** a package: consumers
 * (`@lunora/runtime` mints + verifies, `@lunora/do` verifies) import it by
 * relative path and the bundler (packem/rollup) inlines it — no runtime
 * dependency edge. Keep it genuinely zero-dependency (relative/built-in imports
 * only) or inlining breaks. Consumers must drop `outDir`/`rootDir` from their
 * `tsconfig.json` (a set `rootDir` raises TS6059 for this out-of-package file
 * under `tsc --noEmit`).
 */
import { fromBase64Url, signCanonical, verifyCanonical } from "./hmac-url";

/** Version tag baked into (and verified on) every minted token. */
const WS_ADMIN_TOKEN_VERSION = "v1";

/**
 * Default sub-token lifetime. Do not shorten below a few seconds: workerd's
 * `Date.now()` is coarse and a slow WS handshake could race the expiry.
 */
const WS_ADMIN_TOKEN_TTL_MS = 60_000;

/** A freshly minted ephemeral WS admin token plus its absolute expiry. */
interface MintedWsAdminToken {
    /** Epoch ms after which the token no longer verifies. */
    expiresAtMs: number;
    /** The `v1.<expEpochMs>.<base64url signature>` wire token. */
    token: string;
}

/**
 * Mint a short-lived WS admin sub-token signed with `secret` (the master admin
 * token). Only the worker mints — the mint endpoint is gated by the master
 * token in the `Authorization` header, so possession of a sub-token never
 * grants the ability to mint another.
 */
const mintWsAdminToken = async (secret: string, options: { now?: number; ttlMs?: number } = {}): Promise<MintedWsAdminToken> => {
    const expiresAtMs = (options.now ?? Date.now()) + (options.ttlMs ?? WS_ADMIN_TOKEN_TTL_MS);
    const canonical = `${WS_ADMIN_TOKEN_VERSION}.${String(expiresAtMs)}`;
    const signature = await signCanonical(secret, canonical);

    return { expiresAtMs, token: `${canonical}.${signature}` };
};

/**
 * Verify a WS admin sub-token against `secret`: split `[version, exp, sig]`,
 * require the `v1` version and a finite, unexpired epoch-ms expiry, then
 * recompute the HMAC over `"v1." + exp` and constant-time compare (via
 * `crypto.subtle.verify`). Malformed, expired, tampered, and wrong-secret
 * tokens all return `false` — never throws.
 */
const verifyWsAdminToken = async (secret: string, token: string, now: number = Date.now()): Promise<boolean> => {
    if (secret.length === 0 || token.length === 0) {
        return false;
    }

    const parts = token.split(".");

    if (parts.length !== 3) {
        return false;
    }

    const [version, expString, signature] = parts as [string, string, string];

    if (version !== WS_ADMIN_TOKEN_VERSION || signature.length === 0) {
        return false;
    }

    const expiresAtMs = Number(expString);

    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
        return false;
    }

    let signatureBytes: Uint8Array;

    try {
        signatureBytes = fromBase64Url(signature);
    } catch {
        return false;
    }

    return verifyCanonical(secret, `${version}.${expString}`, signatureBytes);
};

export type { MintedWsAdminToken };
export { mintWsAdminToken, verifyWsAdminToken, WS_ADMIN_TOKEN_TTL_MS, WS_ADMIN_TOKEN_VERSION };
