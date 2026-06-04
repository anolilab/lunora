import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { planDevCommand, runConcurrent, runDevCommand } from "../../src/commands/dev.js";
import type { Logger } from "../../src/util/logger.js";
import { createRecordingSpawner } from "../../src/util/spawn.js";

const silentLogger = (): Logger => {
    return {
        error: () => {},
        info: () => {},
        success: () => {},
        warn: () => {},
    };
};

let workdir: string;

describe("cirrus dev", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "cirrus-cli-dev-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("cirrus dev", () => {
        it("plans `vite` when vite.config.ts is present (no wrangler config)", () => {
            expect.assertions(3);

            writeFileSync(join(workdir, "vite.config.ts"), "export default {};", "utf8");

            const plan = planDevCommand({ cwd: workdir, logger: silentLogger() });

            expect(plan.mode).toBe("vite");
            expect(plan.descriptors[0]?.command).toBe("pnpm");
            expect(plan.descriptors[0]?.args.join(" ")).toContain("vite");
        });

        it("plans `concurrent` when both vite.config.ts and wrangler.jsonc are present", () => {
            expect.assertions(7);

            writeFileSync(join(workdir, "vite.config.ts"), "export default {};", "utf8");
            writeFileSync(join(workdir, "wrangler.jsonc"), "{}", "utf8");

            const plan = planDevCommand({ cwd: workdir, logger: silentLogger() });

            expect(plan.mode).toBe("concurrent");
            expect(plan.descriptors).toHaveLength(2);
            expect(plan.descriptors[0]?.tag).toBe("vite");
            expect(plan.descriptors[1]?.tag).toBe("wrangler");
            expect(plan.descriptors[0]?.args.join(" ")).toContain("vite");
            expect(plan.descriptors[1]?.args.join(" ")).toContain("wrangler");
            expect(plan.descriptors[1]?.args.join(" ")).toContain("dev");
        });

        it("--no-vite overrides concurrent mode to standalone even when both configs exist", () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "vite.config.ts"), "export default {};", "utf8");
            writeFileSync(join(workdir, "wrangler.jsonc"), "{}", "utf8");

            const plan = planDevCommand({ cwd: workdir, logger: silentLogger(), noVite: true });

            expect(plan.mode).toBe("standalone");
            expect(plan.descriptors).toHaveLength(1);
        });

        it("plans `standalone` when --no-vite is passed even with vite.config.ts", () => {
            expect.assertions(3);

            writeFileSync(join(workdir, "vite.config.ts"), "export default {};", "utf8");

            const plan = planDevCommand({ cwd: workdir, logger: silentLogger(), noVite: true });

            expect(plan.mode).toBe("standalone");
            expect(plan.descriptors[0]?.args.join(" ")).toContain("wrangler");
            expect(plan.descriptors[0]?.args.join(" ")).toContain("dev");
        });

        it("plans `standalone` when no vite config exists", () => {
            expect.assertions(1);

            const plan = planDevCommand({ cwd: workdir, logger: silentLogger() });

            expect(plan.mode).toBe("standalone");
        });

        it("propagates --port to the spawned process", () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "vite.config.ts"), "export default {};", "utf8");

            const plan = planDevCommand({ cwd: workdir, logger: silentLogger(), port: 5179 });

            expect(plan.descriptors[0]?.args).toContain("--port");
            expect(plan.descriptors[0]?.args).toContain("5179");
        });

        it("runDevCommand calls the injected spawner with the planned descriptor", async () => {
            expect.assertions(4);

            writeFileSync(join(workdir, "vite.config.ts"), "export default {};", "utf8");

            const { calls, spawner } = createRecordingSpawner();

            const result = await runDevCommand({ cwd: workdir, logger: silentLogger(), spawner });

            expect(result.code).toBe(0);
            expect(calls).toHaveLength(1);
            expect(calls[0]?.descriptor.command).toBe("pnpm");
            expect(calls[0]?.descriptor.args.join(" ")).toContain("vite");
        });
    });

    describe("runConcurrent first-exit teardown", () => {
        it("kills the surviving child when one exits so it does not hang", async () => {
            expect.assertions(1);

            // One child crashes immediately (exit 1); the sibling would
            // otherwise sleep for 30s. Before the fix, Promise.all over both
            // exit promises never resolved (the live child kept running) and
            // `cirrus dev` hung until the user Ctrl-C'd. The first-exit teardown
            // SIGTERMs the survivor, so this must resolve well under the test
            // timeout instead of waiting out the 30s sleep.
            const result = await runConcurrent(
                [
                    { args: ["-e", "process.exit(1)"], command: process.execPath, tag: "crasher" },
                    { args: ["-e", "setTimeout(() => {}, 30000)"], command: process.execPath, tag: "survivor" },
                ],
                silentLogger(),
            );

            // worst non-zero code is surfaced (the crasher's exit 1, or the
            // SIGTERM'd survivor's null->0); either way the call resolved.
            expect(result.code).toBeDefined();
        }, 10_000);
    });
});
