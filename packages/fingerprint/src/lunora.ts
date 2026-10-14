/**
 * The Lunora fingerprint adapter — the entry the runtime, the DO request log,
 * and the Studio use to fold errors into **Issues**.
 *
 * Lunora errors carry no stack frames on the wire: an observability event's
 * error is `{ code, message, status }` and the durable request log
 * (`__lunora_reqlog__`) persists only `outcome` plus `error_message` — there is
 * no stored error code. So unlike the stack-aware `fingerprint`, the canonical
 * grouping key here is over the function path plus the normalized message only.
 * That is the one thing both an in-flight sink event and a persisted reqlog row
 * can always agree on, so a live Issue and one recomputed from history collapse
 * onto the same hash. The code and status ride along as display metadata, never
 * folded into the group.
 *
 * Container crashes flow through the same seam: the ShardDO records a container
 * lifecycle error as a reqlog entry whose function path is `container:` plus the
 * container name and whose message is the exit reason, so a crash-loop groups by
 * container and reason right beside ordinary Worker errors.
 */
import { sha256Hex } from "./sha256";
import { messageBucketFor, stripNullBytes } from "./superlog";

/** Hex length of the grouping hash — kept at 16 to match the vendored core. */
const HASH_LEN = 16;

/** Cap for the display title so a runaway message can't blow out the UI. */
const TITLE_MAX = 120;

/** Above this, a code point came from combining a surrogate pair (UTF-16 astral char). */
const MAX_BMP_CODE_POINT = 0xff_ff;

const buildTitle = (message: string, code: string | null | undefined, culprit: string): string => {
    const firstLine = (message.split("\n", 1)[0] ?? "").trim();
    // `||` not `??` on purpose — an empty string must fall through to the next
    // candidate, which nullish-coalescing would keep.
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty-string fallthrough is intended
    const base = firstLine || code || culprit || "Error";

    if (base.length <= TITLE_MAX) {
        return base;
    }

    let end = TITLE_MAX - 1;
    // Don't cut between a surrogate pair: `slice(0, end)` keeps code units
    // `[0, end)`, so if the last retained unit (index `end - 1`) combines with
    // the one at index `end` into an astral code point, that partner is
    // dropped, leaving an invalid lone surrogate at the end of the title.
    // `codePointAt` returns a value above `MAX_BMP_CODE_POINT` exactly when
    // that pairing happens; trim one more unit instead.
    const lastCodePoint = base.codePointAt(end - 1) ?? 0;

    if (lastCodePoint > MAX_BMP_CODE_POINT) {
        end -= 1;
    }

    return `${base.slice(0, end)}…`;
};

/** Input to `fingerprintError`: what every Lunora error source can supply. */
export interface FingerprintErrorInput {
    /** Machine error code, when known (metadata only — not part of the hash). */
    code?: string | null;
    /** Function path being invoked, e.g. `messages:list` or `container:transcoder`. */
    functionPath: string;
    /** Human-readable error message (may include user input). */
    message: string;
}

/** A grouped error identity — one Issue. */
export interface ErrorFingerprint {
    /** The normalized message bucket the hash was built from (useful for inspection). */
    bucket: string;
    /** The error code, when supplied — display metadata, not part of the hash. */
    code?: string;
    /** What raised it — the function path (or `container:` plus the container name). */
    culprit: string;
    /** Stable 16-char hex grouping id: `sha256("lunora::" + culprit + "::" + bucket)`. */
    hash: string;
    /** Concise, human-readable title for the group (first message line, capped). */
    title: string;
}

/**
 * Fold a single Lunora error into its stable `ErrorFingerprint`. Pure and
 * synchronous — safe to call per row when grouping a request-log page, and it
 * produces the same hash for the same function-path-and-message pair regardless
 * of whether the error came from a live sink event or a persisted history row.
 */
export const fingerprintError = (input: FingerprintErrorInput): ErrorFingerprint => {
    // Strip NUL bytes from the raw inputs up front — before bucketing/hashing —
    // so neither the grouping hash nor any returned display field (title/bucket/
    // culprit) can carry one downstream into a Postgres/SQLite upsert (the exact
    // poisoning `stripNullBytes` documents defending against, applied everywhere
    // else in this package but missed here). This only changes the hash for a
    // message or functionPath that itself contains a NUL byte — already-broken
    // input that couldn't be persisted anyway — so every existing non-NUL hash
    // is unaffected.
    const message = stripNullBytes(input.message);
    // Same NUL-stripping applies to `code`: it feeds `buildTitle`'s fallback
    // (when `message` is empty) and is returned verbatim as display metadata, so
    // an unsanitized NUL-bearing code could still poison persistence downstream.
    const code = stripNullBytes(input.code) ?? undefined;
    // `||` not `??` on purpose — matches the pre-existing empty-string fallthrough.

    const culprit = stripNullBytes(input.functionPath) || "unknown";
    const bucket = messageBucketFor(message);
    const canonical = `lunora::${culprit}::${bucket}`;
    const hash = sha256Hex(canonical).slice(0, HASH_LEN);
    const title = buildTitle(message, code, culprit);

    return code === undefined || code === "" ? { hash, title, culprit, bucket } : { hash, title, culprit, bucket, code };
};
