import { bench, describe } from "vitest";

import { sha256Hex } from "../src/sha256";

/**
 * The vendored portable SHA-256 — every fingerprint ends in exactly one call
 * here, so its floor is the floor of the whole package. Canonical grouping
 * strings are short (a `lunora::culprit::bucket` triple, capped well under a KB),
 * so the single-block case is what the runtime actually pays; the multi-block
 * and long inputs guard against a regression in the block-compression loop.
 */
const ONE_BLOCK = "lunora::messages:list::user <n> not found"; // < 55 bytes → one 64-byte block
const CANONICAL = "lunora::http:router::no route found for get <path>";
const MULTI_BLOCK = `lunora::messages:list::${"connection reset by peer while reading the upstream response body ".repeat(4)}`; // several blocks
const LONG = "x".repeat(4096);

describe("sha256Hex — grouping-hash floor", () => {
    bench("one block (~40 bytes)", () => {
        sha256Hex(ONE_BLOCK);
    });

    bench("canonical grouping string", () => {
        sha256Hex(CANONICAL);
    });

    bench("multi-block (~280 bytes)", () => {
        sha256Hex(MULTI_BLOCK);
    });

    bench("long input (4 KiB)", () => {
        sha256Hex(LONG);
    });
});
