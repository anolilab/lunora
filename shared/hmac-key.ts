/**
 * The per-secret HMAC-SHA256 `CryptoKey` cache shared by every path that signs
 * or verifies under a static secret per request or message: signed URLs
 * (`shared/hmac-url.ts`), the dispatch requeue MAC, the relay control-frame
 * signature, agent channel and payment webhook verifiers.
 *
 * Its own file rather than an export of `hmac-url.ts`, whose top-level
 * control-character regex the bundler cannot prove pure and would inline into
 * every consumer. Like the other `shared/` helpers this is deliberately **not**
 * a package: keep it zero-dependency (relative/built-in imports only).
 */
import { memoizePromise } from "./promise-memo";

const textEncoder = new TextEncoder();

// The secret is effectively constant per process, so the imported
// (non-extractable) CryptoKey is memoized by secret value: this removes one
// `crypto.subtle.importKey` from every sign/verify. Caching the Promise (not
// the resolved key) also coalesces concurrent imports. The cache is bounded
// (FIFO eviction) so a multi-tenant app cycling through many per-tenant secrets
// can't accumulate unbounded memory. 64 distinct secrets/isolate is well above
// any realistic use, and isolates recycle anyway.
const KEY_CACHE_MAX = 64;
const keyCache = new Map<string, Promise<CryptoKey>>();

// `memoizePromise` rather than a bare `set`: a rejected import used to stay in
// the map, so one failed `importKey` poisoned that secret for the isolate's
// whole life and every later verify against it failed with the original error.
// It carries the FIFO bound too, evicting on the insert path.
const importHmacKey = async (secret: string): Promise<CryptoKey> =>
    memoizePromise(
        keyCache,
        secret,
        async () => crypto.subtle.importKey("raw", textEncoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign", "verify"]),
        KEY_CACHE_MAX,
    );

export { importHmacKey };
