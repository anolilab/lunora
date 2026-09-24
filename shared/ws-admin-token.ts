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

/** Env values that read as "on". */
const TRUTHY_ENV_VALUES = new Set(["1", "enabled", "on", "true", "yes"]);

/** Env values that read as "off". */
const FALSY_ENV_VALUES = new Set(["0", "disabled", "false", "no", "off"]);

/**
 * Read a boolean env knob against ONE vocabulary, falling back to `fallback` for
 * an unset, blank, or unrecognised value.
 *
 * Lives here because the WS admin gate is enforced in two isolates — the worker
 * (`checkAdminWsToken`) and the Durable Object (`isAdminSocket`) — that must agree
 * on `LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN` exactly. They previously each held their
 * own value set, so flipping the default meant flipping two copies in lockstep;
 * missing one would have left the worker refusing a master token in `?token=`
 * while the DO accepted it (or the reverse) — a split-brain on an auth gate that
 * no type and no single-package test can catch. This is the same
 * no-runtime-dependency-edge case the rest of `shared/` exists for.
 *
 * Taking `fallback` rather than negating a single set also keeps ONE vocabulary
 * repo-wide: an unrecognised value never means "on" for one flag and "off" for
 * another — it always means "whatever this flag defaults to".
 * @param value the raw env value (`undefined` when unset).
 * @param fallback the value to use when `value` says nothing recognisable.
 */
const isEnvFlagEnabled = (value: string | undefined, fallback: boolean): boolean => {
    const normalized = (value ?? "").trim().toLowerCase();

    if (TRUTHY_ENV_VALUES.has(normalized)) {
        return true;
    }

    return FALSY_ENV_VALUES.has(normalized) ? false : fallback;
};

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

/**
 * Canonical string the socket binding is signed over. A constant: the binding
 * identifies the master token, not the socket, so every socket authorized under
 * one token derives the same value.
 */
const ADMIN_SOCKET_BINDING_CANONICAL = `${WS_ADMIN_TOKEN_VERSION}.admin-socket-binding`;

/**
 * Fingerprint of the master admin token, stamped on an admin socket's
 * hibernation attachment at upgrade and re-derived from `env` on every later
 * admin read.
 *
 * The token itself authorizes ONCE, at the upgrade; the socket then lives for
 * hours. Rotating or clearing `LUNORA_ADMIN_TOKEN` closes the HTTP admin plane
 * on the next request, and without this it closed nothing on the socket plane —
 * a 60-second sub-token bought 60 seconds to OPEN a socket that then served
 * `runSql` output for the rest of its life. Comparing the stamped fingerprint
 * against the current one makes rotation a revocation there too.
 *
 * An HMAC rather than the token: the value rides a hibernation attachment that
 * admin introspection can summarise, and a fingerprint that leaks tells an
 * attacker nothing it can present.
 */
const adminSocketBinding = async (secret: string): Promise<string> => signCanonical(secret, ADMIN_SOCKET_BINDING_CANONICAL);

export type { MintedWsAdminToken };
export { adminSocketBinding, isEnvFlagEnabled, mintWsAdminToken, verifyWsAdminToken, WS_ADMIN_TOKEN_TTL_MS, WS_ADMIN_TOKEN_VERSION };
