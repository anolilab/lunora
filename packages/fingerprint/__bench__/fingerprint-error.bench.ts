import { bench, describe } from "vitest";

import { fingerprintError } from "../src/lunora";

/**
 * The stack-less runtime / request-log path — the hottest entry in practice.
 * Both the local Studio (folding a request-log page into Issues) and the Cloud
 * (recomputing groups from durable reqlog rows) call this **once per row**, so
 * the per-call cost sets how large a page can be grouped inside one DO tick.
 *
 * Each variant exercises a different slice of the pipeline:
 *
 * - **short, clean** — the common case: a terse message with nothing to
 * normalize. Measures the fixed bucketer + SHA-256 floor.
 * - **id-heavy** — a message full of per-occurrence identifiers (user id, uuid,
 * timestamp). Every regex in the bucketer fires and rewrites the string, the
 * worst realistic normalization load.
 * - **route probe** — a bot-sweep URL. Exercises the request-path collapse that
 * keeps a scanner from exploding into thousands of distinct Issues.
 * - **long message** — a 500-char message that trips the `MESSAGE_INPUT_MAX`
 * clamp; measures the slice guard plus a full-width bucket.
 */
describe("fingerprintError — per-row grouping", () => {
    bench("short, clean message", () => {
        fingerprintError({ code: "INTERNAL_SERVER_ERROR", functionPath: "messages:list", message: "Connection reset by peer" });
    });

    bench("id-heavy message (every regex fires)", () => {
        fingerprintError({
            code: "NOT_FOUND",
            functionPath: "messages:list",
            message: "User 12345 (a1b2c3d4-e5f6-7890-abcd-ef1234567890) not found at 2026-07-24T10:15:30Z from 10.0.0.1",
        });
    });

    bench("route-probe message (path collapse)", () => {
        fingerprintError({ functionPath: "http:router", message: "no route found for GET /wp-admin/install.php" });
    });

    bench("long message (input clamp)", () => {
        fingerprintError({ functionPath: "messages:list", message: `boom ${"x".repeat(500)} tail` });
    });
});
