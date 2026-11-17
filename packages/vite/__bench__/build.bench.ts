import { createBuilder } from "vite";
import { afterAll, bench, describe } from "vitest";

import { lunora } from "../src/index";
import { createFixture, removeFixture } from "./fixture";

// A whole `vite build` of a Lunora app with the Cloudflare plugin: the client
// and worker environments, and every Lunora hook along the way (each
// environment's config pass, codegen, binding provisioning, bundle-meta). The
// worker entry imports nothing from the workspace, so this needs no other
// package built and no workerd. Skipped under CI/CodSpeed: a full build per
// iteration, instrumented, does not fit that job's time budget.
const reduced = process.env["CODSPEED_ENV"] !== undefined || process.env["CI"] === "true";

const fixture = createFixture("build");

afterAll(() => {
    removeFixture(fixture);
});

describe("vite build", () => {
    bench.skipIf(reduced)(
        "client + worker build of a 40-procedure app",
        async () => {
            const builder = await createBuilder({ configFile: false, logLevel: "silent", plugins: [lunora({ projectRoot: fixture })], root: fixture });

            await builder.buildApp();
        },
        { iterations: 4, time: 0, warmupIterations: 1 },
    );
});
