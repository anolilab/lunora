import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { planDevCommand, runDevCommand } from "../../src/commands/dev.js";
import type { Logger } from "../../src/util/logger.js";
import { createRecordingSpawner } from "../../src/util/spawn.js";

const silentLogger = (): Logger => ({
    error: () => {},
    info: () => {},
    success: () => {},
    warn: () => {},
});

let workdir: string;

beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "cirrus-cli-dev-"));
});

afterEach(() => {
    rmSync(workdir, { force: true, recursive: true });
});

describe("cirrus dev", () => {
    test("plans `vite` when vite.config.ts is present (no wrangler config)", () => {
        writeFileSync(join(workdir, "vite.config.ts"), "export default {};", "utf8");

        const plan = planDevCommand({ cwd: workdir, logger: silentLogger() });

        expect(plan.mode).toBe("vite");
        expect(plan.descriptors[0]?.command).toBe("pnpm");
        expect(plan.descriptors[0]?.args.join(" ")).toContain("vite");
    });

    test("plans `concurrent` when both vite.config.ts and wrangler.jsonc are present", () => {
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

    test("--no-vite overrides concurrent mode to standalone even when both configs exist", () => {
        writeFileSync(join(workdir, "vite.config.ts"), "export default {};", "utf8");
        writeFileSync(join(workdir, "wrangler.jsonc"), "{}", "utf8");

        const plan = planDevCommand({ cwd: workdir, logger: silentLogger(), noVite: true });

        expect(plan.mode).toBe("standalone");
        expect(plan.descriptors).toHaveLength(1);
    });

    test("plans `standalone` when --no-vite is passed even with vite.config.ts", () => {
        writeFileSync(join(workdir, "vite.config.ts"), "export default {};", "utf8");

        const plan = planDevCommand({ cwd: workdir, logger: silentLogger(), noVite: true });

        expect(plan.mode).toBe("standalone");
        expect(plan.descriptors[0]?.args.join(" ")).toContain("wrangler");
        expect(plan.descriptors[0]?.args.join(" ")).toContain("dev");
    });

    test("plans `standalone` when no vite config exists", () => {
        const plan = planDevCommand({ cwd: workdir, logger: silentLogger() });

        expect(plan.mode).toBe("standalone");
    });

    test("propagates --port to the spawned process", () => {
        writeFileSync(join(workdir, "vite.config.ts"), "export default {};", "utf8");

        const plan = planDevCommand({ cwd: workdir, logger: silentLogger(), port: 5179 });

        expect(plan.descriptors[0]?.args).toContain("--port");
        expect(plan.descriptors[0]?.args).toContain("5179");
    });

    test("runDevCommand calls the injected spawner with the planned descriptor", async () => {
        writeFileSync(join(workdir, "vite.config.ts"), "export default {};", "utf8");

        const { calls, spawner } = createRecordingSpawner();

        const result = await runDevCommand({ cwd: workdir, logger: silentLogger(), spawner });

        expect(result.code).toBe(0);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.descriptor.command).toBe("pnpm");
        expect(calls[0]?.descriptor.args.join(" ")).toContain("vite");
    });
});
