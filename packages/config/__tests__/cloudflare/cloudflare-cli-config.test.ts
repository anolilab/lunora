import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLOUDFLARE_CLI_CONFIG_WARNING_ENV, detectCloudflareCliConfig, warnCloudflareCliConfigOnce } from "../../src/cloudflare/cloudflare-cli-config";

const ISSUE_URL = "https://github.com/anolilab/lunora/issues/964";

describe("cloudflare cli config", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cf-config-"));
        // The warning is gated by a once-per-process-tree env var; clear it so each
        // test exercises the first-claim path. Restored by `unstubAllEnvs`.
        vi.stubEnv(CLOUDFLARE_CLI_CONFIG_WARNING_ENV, "");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
        vi.unstubAllEnvs();
    });

    describe(detectCloudflareCliConfig, () => {
        it("returns undefined when the project has no cloudflare.config.*", () => {
            expect.assertions(1);

            expect(detectCloudflareCliConfig(workdir)).toBeUndefined();
        });

        it.each(["cloudflare.config.ts", "cloudflare.config.mts", "cloudflare.config.js", "cloudflare.config.mjs"])(
            "detects %s in the project root",
            (fileName) => {
                expect.assertions(1);

                writeFileSync(join(workdir, fileName), "export default {};\n", "utf8");

                expect(detectCloudflareCliConfig(workdir)?.message).toContain(`${fileName} found`);
            },
        );

        it("ignores a lookalike that is not a cf config", () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "cloudflare.config.json"), "{}\n", "utf8");

            expect(detectCloudflareCliConfig(workdir)).toBeUndefined();
        });

        it.each(["wrangler.jsonc", "wrangler.json"])("names the %s actually present", (wranglerName) => {
            expect.assertions(2);

            writeFileSync(join(workdir, wranglerName), "{}\n", "utf8");
            writeFileSync(join(workdir, "cloudflare.config.ts"), "export default {};\n", "utf8");

            const message = detectCloudflareCliConfig(workdir)?.message ?? "";

            expect(message).toContain(`cloudflare.config.ts found next to ${wranglerName}.`);
            expect(message).toContain(`Lunora manages ${wranglerName}`);
        });

        it("says 'in the project root' when there is no wrangler config yet", () => {
            expect.assertions(2);

            writeFileSync(join(workdir, "cloudflare.config.ts"), "export default {};\n", "utf8");

            const message = detectCloudflareCliConfig(workdir)?.message ?? "";

            expect(message).toContain("cloudflare.config.ts found in the project root.");
            expect(message).not.toContain("next to");
        });

        it("says resource commands are fine and links the tracking issue in the fix", () => {
            expect.assertions(3);

            writeFileSync(join(workdir, "cloudflare.config.ts"), "export default {};\n", "utf8");

            const fix = detectCloudflareCliConfig(workdir)?.fix ?? "";

            expect(fix).toContain("resource commands");
            expect(fix).toContain("`cf deploy`");
            expect(fix).toContain(ISSUE_URL);
        });
    });

    describe(warnCloudflareCliConfigOnce, () => {
        it("stays quiet without a cf config, and leaves the guard unclaimed", () => {
            expect.assertions(3);

            const warn = vi.fn<(message: string) => void>();

            expect(warnCloudflareCliConfigOnce(workdir, warn)).toBe(false);
            expect(warn).not.toHaveBeenCalled();
            expect(process.env[CLOUDFLARE_CLI_CONFIG_WARNING_ENV]).toBe("");
        });

        it("warns once per process tree, however often it is asked", () => {
            expect.assertions(5);

            writeFileSync(join(workdir, "wrangler.jsonc"), "{}\n", "utf8");
            writeFileSync(join(workdir, "cloudflare.config.ts"), "export default {};\n", "utf8");

            const warn = vi.fn<(message: string) => void>();

            expect(warnCloudflareCliConfigOnce(workdir, warn)).toBe(true);
            expect(warnCloudflareCliConfigOnce(workdir, warn)).toBe(false);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0]?.[0]).toContain(ISSUE_URL);
            expect(process.env[CLOUDFLARE_CLI_CONFIG_WARNING_ENV]).toBe("1");
        });

        it("stays quiet when an ancestor process already claimed it", () => {
            expect.assertions(2);

            vi.stubEnv(CLOUDFLARE_CLI_CONFIG_WARNING_ENV, "1");
            writeFileSync(join(workdir, "cloudflare.config.ts"), "export default {};\n", "utf8");

            const warn = vi.fn<(message: string) => void>();

            expect(warnCloudflareCliConfigOnce(workdir, warn)).toBe(false);
            expect(warn).not.toHaveBeenCalled();
        });
    });
});
