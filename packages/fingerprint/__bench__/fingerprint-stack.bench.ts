import { bench, describe } from "vitest";

import { fingerprint, fingerprintLog } from "../src/superlog";

/**
 * The stack-aware OTLP path (cloud pipeline): parse the stacktrace into frames,
 * drop framework frames, normalize the top-N paths, then bucket + hash. Called
 * once per ingested exception span, so a deep stack's parse cost matters.
 *
 * The deep stack mixes user frames with `node_modules`/`node:internal` frames
 * so the `isUserFrame` filter and both frame shapes (`fn (path:line:col)` and
 * bare `path:line:col`) are exercised.
 */
const DEEP_STACK = [
    "Error: upstream timed out",
    "    at listMessages (apps/worker/src/messages/list.ts:42:15)",
    "    at handler (packages/runtime/src/router.ts:118:9)",
    "    at process (node:internal/process/task_queues:95:5)",
    "    at Object.dispatch (/app/node_modules/@lunora/do/dist/index.mjs:2201:20)",
    "    at async run (apps/worker/src/index.ts:12:3)",
    "    at async pump (packages/client/src/socket.ts:88:7)",
    "    at emit (node:events:518:28)",
].join("\n");

describe("fingerprint — stack-aware OTLP path", () => {
    bench("deep mixed stack", () => {
        fingerprint({ message: "upstream timed out after 30000ms", stacktrace: DEEP_STACK, type: "GatewayTimeoutError" });
    });

    bench("no stack (bucket-only)", () => {
        fingerprint({ message: "upstream timed out after 30000ms", stacktrace: null, type: "GatewayTimeoutError" });
    });
});

describe("fingerprintLog — log entry", () => {
    bench("body-only log (no stack)", () => {
        fingerprintLog({ body: "request failed with status 500 for /api/messages", service: "worker", severity: "ERROR", stacktrace: null });
    });

    bench("log with stacktrace", () => {
        fingerprintLog({ body: "request failed", service: "worker", severity: "ERROR", stacktrace: DEEP_STACK });
    });
});
