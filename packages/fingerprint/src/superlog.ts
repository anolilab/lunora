/**
 * Deterministic error fingerprinting — vendored from Superlog Labs' superlog.
 *
 * Source: `@superlog/fingerprint` (packages/fingerprint/src/index.ts in
 * superloglabs/superlog), Apache-2.0. See the package `NOTICE` for attribution.
 *
 * The algorithm is reproduced faithfully — the message bucketer, the stack-frame
 * normalizer, and the `type::bucket::frames` canonical string — with a single
 * change: the Node-only `node:crypto` `createHash("sha256")` backend is replaced
 * with the portable synchronous {@link sha256Hex} so this file runs unchanged on
 * the browser, the Cloudflare Workers (workerd) runtime, and Node. The canonical
 * string and the resulting 16-char hash are byte-for-byte identical to upstream.
 *
 * Consumed two ways in Lunora: the full stack-aware {@link fingerprint} for
 * OTLP-sourced errors in the cloud pipeline (spans carry `exception.stacktrace`),
 * and — via the Lunora adapter in `./lunora` — the {@link messageBucketFor}
 * bucketer alone for the stack-less runtime/reqlog error path.
 */
import { sha256Hex } from "./sha256";

export interface Fingerprint {
    hash: string;
    exceptionType: string;
    topFrame: string | null;
    normalizedFrames: string[];
}

export interface LogFingerprintInput {
    service: string;
    severity: string;
    body: string;
    exceptionType?: string | null;
    stacktrace?: string | null;
}

interface Frame {
    fn: string | null;
    path: string;
}

const TOP_N_FRAMES = 5;
const HASH_LEN = 16;

const IGNORE_PATH = [/node_modules\//, /^node:internal\//, /^node:async_hooks/, /async_hooks\.js/, /^webpack:\/\/\//];

const NUL_BYTE = String.fromCharCode(0);

/**
 * Postgres `text` and `jsonb` columns reject the NUL byte (0x00) with
 * `22021 invalid byte sequence for encoding "UTF8": 0x00`. Telemetry can carry
 * a raw NUL inside an exception message, body, or stack frame, and these
 * fingerprint outputs flow straight into an issues upsert — so strip NUL before
 * it can poison a parameter. Passes null/undefined through unchanged.
 */
export const stripNullBytes = <T extends string | null | undefined>(value: T): T => (typeof value === "string" ? value.split(NUL_BYTE).join("") : value) as T;

export const fingerprint = (input: { type: string; stacktrace: string | null | undefined; message?: string | null }): Fingerprint => {
    const type = input.type || "Error";
    const frames = parseFrames(input.stacktrace ?? "");
    const userFrames = frames.filter(isUserFrame).slice(0, TOP_N_FRAMES);

    const picked = userFrames.length > 0 ? userFrames : frames.slice(0, TOP_N_FRAMES);
    const normalized = picked.map(formatFrame);
    const messageBucket = messageBucketFor(input.message);
    const canonical = `${type}::${messageBucket}::${normalized.join("|")}`;
    const hash = sha256Hex(canonical).slice(0, HASH_LEN);

    // The hash is hex (always safe); the human-readable fields below may be
    // persisted, so they must be NUL-free.
    const safeFrames = normalized.map((frame) => stripNullBytes(frame));

    return {
        hash,
        exceptionType: stripNullBytes(type),
        topFrame: safeFrames[0] ?? null,
        normalizedFrames: safeFrames,
    };
};

export const fingerprintLog = (input: LogFingerprintInput): Fingerprint => {
    if (input.stacktrace && input.stacktrace.trim().length > 0) {
        return fingerprint({
            type: input.exceptionType || input.severity || "LogError",
            stacktrace: input.stacktrace,
        });
    }

    const type = input.exceptionType || input.severity || "LogError";
    const service = input.service || "unknown";
    const normalized = normalizeMessage(input.body ?? "");
    const canonical = `log::${service}::${type}::${normalized}`;
    const hash = sha256Hex(canonical).slice(0, HASH_LEN);

    return {
        hash,
        exceptionType: stripNullBytes(type),
        topFrame: null,
        normalizedFrames: [],
    };
};

/**
 * Bucket key for grouping by error message. Lighter than {@link normalizeMessage}:
 * preserves alphabetic content (so `model is not supported` doesn't collapse onto
 * `extra inputs are not permitted`) but strips identifiers that vary per
 * occurrence. Anthropic-style envelopes are unwrapped first so the per-request
 * `request_id` doesn't leak into the bucket.
 */
const MESSAGE_BUCKET_MAX = 160;

/**
 * Upper bound on the raw message length fed to the bucketer's regexes. Several
 * of them (the email/word patterns especially) backtrack super-linearly on a
 * long run with no delimiter, and an `error_message` is stored verbatim with no
 * size cap and can carry attacker-influenced input — so an unbounded message
 * would let one crafted error stall the DO's single thread. The final bucket is
 * only {@link MESSAGE_BUCKET_MAX} chars anyway, so clamping the input first is
 * transparent for any real message and bounds the regex work.
 */
const MESSAGE_INPUT_MAX = 1024;

export const messageBucketFor = (message: string | null | undefined): string => {
    if (!message) {
        return "";
    }

    let s = unwrapAnthropicErrorMessage(message.length > MESSAGE_INPUT_MAX ? message.slice(0, MESSAGE_INPUT_MAX) : message);

    s = s.replace(/https?:\/\/\S+/gi, "<url>");
    s = collapseRequestPaths(s);
    s = s.replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, "<email>");
    s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>");
    s = s.replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?(?:[+-]\d{2}:?\d{2})?\b/g, "<ts>");
    s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<ip>");
    s = s.replace(/\b0x[0-9a-f]+\b/gi, "<hex>");
    s = s.replace(/\b[A-Za-z0-9_]{20,}\b/g, "<id>");
    s = s.replace(/\b\d+\b/g, "<n>");
    s = s.replace(/\s+/g, " ").trim().toLowerCase();

    return s.length > MESSAGE_BUCKET_MAX ? s.slice(0, MESSAGE_BUCKET_MAX) : s;
};

/**
 * Collapse leading-slash request paths to a single `<path>` token. A route
 * scanner hammering a server emits one error per probed URL (`/wp-admin`,
 * `/.env`, `/.git/config`, …) that are otherwise identical — same type, same
 * stacktrace. Without this every probed path becomes its own fingerprint, so a
 * single bot sweep explodes into tens of thousands of distinct issues and floods
 * ingestion. We only collapse a slash at a token boundary (start or after
 * whitespace) so in-word slashes like `and/or` or `client/server` stay intact.
 * The HTTP method (`GET`/`POST`) is left alone, so a sweep groups into at most a
 * handful of issues (one per method) instead of thousands.
 */
const collapseRequestPaths = (s: string): string => s.replace(/(^|\s)\/\S*/g, "$1<path>");

const unwrapAnthropicErrorMessage = (raw: string): string => {
    // SDK errors land as `<status> <json>`; pull `error.message` if present so we
    // hash the human-readable failure, not the JSON wrapper.
    const m = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);

    return m && m[1] ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\") : raw;
};

export const normalizeMessage = (body: string): string => {
    // Same super-linear-backtracking guard as messageBucketFor — clamp before
    // the regexes run so an unbounded body can't stall the thread.
    let s = body.length > MESSAGE_INPUT_MAX ? body.slice(0, MESSAGE_INPUT_MAX) : body;

    s = s.replace(/https?:\/\/\S+/gi, "<url>");
    s = collapseRequestPaths(s);
    s = s.replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, "<email>");
    s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>");
    s = s.replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?(?:[+-]\d{2}:?\d{2})?\b/g, "<ts>");
    s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<ip>");
    s = s.replace(/\b0x[0-9a-f]+\b/gi, "<hex>");
    s = s.replace(/"(?:[^"\\]|\\.)*"/g, "<str>");
    s = s.replace(/'(?:[^'\\]|\\.)*'/g, "<str>");
    s = s.replace(/\b[0-9a-f]{20,}\b/gi, "<hex>");
    s = s.replace(/\b\d+\b/g, "<n>");
    s = s.replace(/\s+/g, " ").trim().toLowerCase();

    return s;
};

/**
 * Strip a trailing `:<line>:<col>` from a frame location, returning the bare
 * path (or `null` when the suffix isn't there).
 *
 * Deliberately index-based rather than a regex. The upstream patterns
 * (`^(.+?)\s+\((.+?):\d+:\d+\)$` / `^(.+?):\d+:\d+$`) pair a lazy `.+?` with a
 * numeric suffix, which backtracks quadratically on an adversarial line — and a
 * stacktrace is attacker-influenced input (it can carry a user-supplied string
 * in a frame name). CodeQL flags them as polynomial-ReDoS sinks. Scanning from
 * the end is linear and accepts exactly the same shapes.
 */
const splitLocation = (location: string): string | null => {
    const colonBeforeColumn = location.lastIndexOf(":");

    if (colonBeforeColumn <= 0) {
        return null;
    }

    const colonBeforeLine = location.lastIndexOf(":", colonBeforeColumn - 1);

    if (colonBeforeLine <= 0) {
        return null;
    }

    const line = location.slice(colonBeforeLine + 1, colonBeforeColumn);
    const column = location.slice(colonBeforeColumn + 1);

    if (!isDigits(line) || !isDigits(column)) {
        return null;
    }

    return location.slice(0, colonBeforeLine);
};

const isDigits = (s: string): boolean => s.length > 0 && !/\D/.test(s);

/**
 * Split `fn (path:line:col)` into its function and location halves. Mirrors the
 * lazy `(.+?)\s+\(` of the upstream regex — the FIRST whitespace-then-`(` whose
 * remainder parses as a location wins — so a frame whose function name itself
 * contains ` (` groups identically to upstream.
 */
const splitFramedLocation = (body: string): Frame | null => {
    if (!body.endsWith(")")) {
        return null;
    }

    for (let index = body.indexOf("("); index > 0; index = body.indexOf("(", index + 1)) {
        const separator = body[index - 1] ?? "";

        // The upstream `\s+` — the `(` must be preceded by whitespace, so an
        // in-name paren like `Object.foo(anonymous)` isn't mistaken for a location.
        if (!/\s/.test(separator)) {
            continue;
        }

        const path = splitLocation(body.slice(index + 1, -1));
        const fn = body.slice(0, index).trimEnd();

        // Upstream's `(.+?)` requires a non-empty function name; an empty one
        // falls through to the bare `path:line:col` shape, as it does there.
        if (path !== null && fn.length > 0) {
            return { fn, path };
        }
    }

    return null;
};

const parseFrames = (stacktrace: string): Frame[] => {
    const out: Frame[] = [];

    for (const raw of stacktrace.split("\n")) {
        const line = raw.trim();

        if (!line.startsWith("at ")) {
            continue;
        }

        const body = line.slice(3);
        const framed = splitFramedLocation(body);

        if (framed) {
            out.push(framed);
            continue;
        }

        const bare = splitLocation(body);

        if (bare !== null && bare.length > 0) {
            out.push({ fn: null, path: bare });
        }
    }

    return out;
};

const isUserFrame = (f: Frame): boolean => !IGNORE_PATH.some((re) => re.test(f.path));

const formatFrame = (f: Frame): string => {
    const path = normalizePath(f.path);

    return f.fn ? `${f.fn}@${path}` : path;
};

const normalizePath = (p: string): string => {
    let out = p
        .replace(/^webpack-internal:\/\/\/?/, "")
        .replace(/^\([^)]*\)\//, "")
        .replace(/^\.\//, "")
        .replace(/^file:\/\//, "");

    out = out.replace(/^.*?\/((?:apps|packages|src|app|lib|pages)\/.*)$/, "$1");

    return out;
};
