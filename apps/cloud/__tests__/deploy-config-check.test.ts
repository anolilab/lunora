import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../scripts/check-deploy-config.ts", import.meta.url));

/**
 * The pre-deploy gate over the configs as committed. Among its checks, a deployed cell must
 * bind the `BACKUPS` bucket and name its own D1 in `CONTROL_PLANE_DATABASE_ID`; without either
 * the control-plane backup sweep skips every tick and nothing fails.
 */
describe("deploy:check", () => {
    it.each(["staging", "production"])("passes the committed %s cell", (cell) => {
        const run = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, cell], { encoding: "utf8" });

        expect(run.stderr).not.toContain("Refusing to deploy");
        expect(run.status).toBe(0);
    });
});
