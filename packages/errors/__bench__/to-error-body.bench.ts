import { bench, describe } from "vitest";

import { LunoraError } from "../src/base";
import { findSolutionByMessage, flattenHint, resolveHint } from "../src/catalog";
import { toErrorBody } from "../src/to-error-body";

/*
 * `toErrorBody` is the single builder every transport edge (HTTP, DO RPC,
 * WS/SSE frames, shape subscriptions) runs to turn a throw into a wire
 * envelope. One call per failed request — cheap individually, but it sits on
 * the error path of every surface, and an error storm is exactly when the
 * runtime can least afford extra work.
 *
 * The branch that actually costs something is the message-matched hint
 * fallback: the solution lookup linearly scans `MESSAGE_SOLUTIONS`, running
 * each rule's `test` until one matches. That scan only runs for an error with
 * neither a carried `hint` nor a catalog hint for its `code` — so the
 * "unmatched message" bench (a full scan that finds nothing) is the worst case
 * and the number to watch as the rule list grows.
 *
 * `getCatalogEntry`, `isInternalCode` and `isLunoraError` are deliberately NOT
 * benched on their own. Each is a property read plus a guard — a handful of
 * instructions that CodSpeed's instrumentation dwarfs, so a standalone bench
 * would emit noise-driven regression alerts without guarding anything. They sit
 * on the `toErrorBody` path above, where a real regression would surface.
 */

// ---- Fixtures ------------------------------------------------------------

const publicError = new LunoraError("NOT_FOUND", "Document not found in table 'messages'");

const internalError = new LunoraError("INTERNAL", "SQLITE_ERROR: no such column: internal_col at /srv/app/db.ts:412");

const errorWithData = new LunoraError("VALIDATION_ERROR", "Validation failed", {
    data: { field: "email", received: "not-an-email" },
});

const errorWithHint = new LunoraError("TOO_MANY_REQUESTS", "Rate limit exceeded", {
    hint: ["Retry with backoff.", "Consider `.shardBy()` to spread load."],
});

const foreignError = new TypeError("fetch failed");

/** A message no `MESSAGE_SOLUTIONS` rule recognizes — the full-scan worst case. */
const unmatchedMessage = "something went sideways in a way nobody has a canned answer for";

const encodeData = (data: unknown): unknown => structuredClone(data);

// ---- Benches -------------------------------------------------------------

describe("toErrorBody — per failed request", () => {
    bench("public LunoraError (echoed)", () => {
        toErrorBody(publicError);
    });

    bench("internal-coded LunoraError (redacted)", () => {
        toErrorBody(internalError);
    });

    bench("LunoraError with encoded data", () => {
        toErrorBody(errorWithData, { encodeData });
    });

    bench("LunoraError carrying its own hint", () => {
        toErrorBody(errorWithHint);
    });

    bench("foreign error (generic 500)", () => {
        toErrorBody(foreignError);
    });
});

describe("resolveHint — hint resolution order", () => {
    bench("carried hint (short-circuits)", () => {
        resolveHint({ code: "TOO_MANY_REQUESTS", hint: ["retry"], message: "x" });
    });

    bench("catalog hint by code", () => {
        resolveHint({ code: "NOT_FOUND", message: "x" });
    });

    bench("message fallback — unmatched (full rule scan)", () => {
        resolveHint({ message: unmatchedMessage });
    });
});

describe("findSolutionByMessage — linear rule scan", () => {
    bench("unmatched message (worst case)", () => {
        findSolutionByMessage(unmatchedMessage);
    });
});

describe("flattenHint — terminal rendering", () => {
    bench("multi-line hint with code fences and emphasis", () => {
        flattenHint(["Run **`lunora dev`** first.", "```ts", "const x = 1;", "```", "Then retry the `query`."]);
    });
});
