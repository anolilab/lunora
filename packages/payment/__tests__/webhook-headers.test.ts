import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const PROVIDERS_DIRECTORY = join(import.meta.dirname, "..", "src", "providers");
const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..", "..");

/**
 * Every header the adapters verify with, read off their own `headers.get("…")` calls rather than
 * restated here — the point is to notice when a new adapter adds one.
 */
const verifiedHeaders = (): string[] => {
    const sources = readdirSync(PROVIDERS_DIRECTORY)
        .filter((name) => name.endsWith(".ts"))
        .map((name) => readFileSync(join(PROVIDERS_DIRECTORY, name), "utf8"))
        .join("\n");

    return [...new Set([...sources.matchAll(/headers\.get\("(?<header>[^"]+)"\)/gu)].flatMap((match) => match.groups?.header ?? []))];
};

/**
 * The webhook route at the Worker edge forwards an ALLOWLIST of headers into the shard, so a new
 * adapter that signs with a header nobody added to it fails every delivery with
 * `WEBHOOK_SIGNATURE_INVALID` — and fails it in the deployer's production, since no gate exercises
 * a live webhook. Forwarding only `stripe-signature` shipped exactly that bug once already.
 *
 * The copies are deliberate: `registry/` is copy-in, not a workspace, so nothing typechecks it —
 * `examples/payment-demo` mirrors the shape to get it compiled. This keeps both honest.
 */
describe("webhook signature headers", () => {
    it.each([["examples/payment-demo/lunora/http.ts"], ["registry/payment/payment.ts"], ["registry/payment/README.md"]])(
        "%s forwards every header an adapter verifies with",
        (file) => {
            expect.hasAssertions();

            const headers = verifiedHeaders();

            expect(headers.length).toBeGreaterThan(0);

            const source = readFileSync(join(REPOSITORY_ROOT, file), "utf8");

            expect(headers.filter((header) => !source.includes(`"${header}"`))).toStrictEqual([]);
        },
    );
});
