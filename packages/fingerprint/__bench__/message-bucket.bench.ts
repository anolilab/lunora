import { bench, describe } from "vitest";

import { messageBucketFor, normalizeMessage } from "../src/superlog";

/**
 * The regex normalizers in isolation — the CPU-heaviest part of a fingerprint
 * once the SHA-256 floor is subtracted. `messageBucketFor` (~10 sequential
 * `.replace` passes) drives every stack-less grouping; `normalizeMessage`
 * (~11 passes, adds string-literal scrubbing) drives log-body fingerprints.
 *
 * Inputs are chosen to hit distinct cost profiles: a clean message where the
 * passes mostly no-op, an id-heavy message where every pass rewrites, and an
 * Anthropic SDK envelope that first runs the unwrap match.
 */
const CLEAN = "Connection reset by peer while reading response";
const ID_HEAVY = "User 12345 (a1b2c3d4-e5f6-7890-abcd-ef1234567890) not found at 2026-07-24T10:15:30Z from 10.0.0.1 token abcdef0123456789abcdef";
const ANTHROPIC =
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your rate limit"},"request_id":"req_011CabcdEFGH"}';

describe("messageBucketFor — stack-less bucketer", () => {
    bench("clean message", () => {
        messageBucketFor(CLEAN);
    });

    bench("id-heavy message", () => {
        messageBucketFor(ID_HEAVY);
    });

    bench("anthropic envelope (unwrap + bucket)", () => {
        messageBucketFor(ANTHROPIC);
    });
});

describe("normalizeMessage — log-body normalizer", () => {
    bench("clean message", () => {
        normalizeMessage(CLEAN);
    });

    bench("id-heavy message", () => {
        normalizeMessage(ID_HEAVY);
    });
});
