import { createServer } from "vite";
import { afterAll, bench, describe } from "vitest";

import { lunora } from "../src/index";
import { createFixture, removeFixture } from "./fixture";

// `vite dev` until it serves: `createServer` (every Lunora startup hook, then
// the Cloudflare plugin booting the worker in workerd) → `listen` → the first
// `/_lunora` request answered by the worker. Needs workerd and a localhost
// loopback, which the instrumented CI runner does not give a bench — so it is
// skipped there (`CI` / `CODSPEED_ENV`) and runs locally.
const skip = process.env["CODSPEED_ENV"] !== undefined || process.env["CI"] === "true";

const fixture = createFixture("dev");

afterAll(() => {
    removeFixture(fixture);
});

describe("vite dev", () => {
    bench.skipIf(skip)(
        "createServer → listen → first worker response",
        async () => {
            const server = await createServer({
                configFile: false,
                logLevel: "silent",
                plugins: [lunora({ projectRoot: fixture })],
                root: fixture,
                server: { port: 0 },
            });

            try {
                await server.listen();
                await fetch(new URL("_lunora/health", server.resolvedUrls?.local[0]));
            } finally {
                await server.close();
            }
        },
        { iterations: 4, time: 0, warmupIterations: 1 },
    );
});
