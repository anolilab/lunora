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
import { messageBucketFor } from "./superlog";

/** Hex length of the grouping hash — kept at 16 to match the vendored core. */
const HASH_LEN = 16;

/** Cap for the display title so a runaway message can't blow out the UI. */
const TITLE_MAX = 120;

/** First truthy (non-empty) value, or the empty string — the intent of `a || b`. */
const firstNonEmpty = (...values: (string | null | undefined)[]): string => {
    for (const value of values) {
        if (value) {
            return value;
        }
    }

    return "";
};

const buildTitle = (message: string, code: string | null | undefined, culprit: string): string => {
    const firstLine = (message.split("\n", 1)[0] ?? "").trim();
    const base = firstNonEmpty(firstLine, code, culprit, "Error");

    return base.length > TITLE_MAX ? `${base.slice(0, TITLE_MAX - 1)}…` : base;
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
    const culprit = firstNonEmpty(input.functionPath, "unknown");
    const bucket = messageBucketFor(input.message);
    const canonical = `lunora::${culprit}::${bucket}`;
    const hash = sha256Hex(canonical).slice(0, HASH_LEN);
    const title = buildTitle(input.message, input.code, culprit);
    const code = input.code ?? undefined;

    return code === undefined || code === "" ? { hash, title, culprit, bucket } : { hash, title, culprit, bucket, code };
};
