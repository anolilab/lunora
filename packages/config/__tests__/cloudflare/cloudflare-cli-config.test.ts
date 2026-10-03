import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    CLOUDFLARE_CLI_CONFIG_ADVICE,
    CLOUDFLARE_CLI_CONFIG_FILES,
    CLOUDFLARE_CLI_CONFIG_WARNING_ENV,
    CLOUDFLARE_CLI_ISSUE_URL,
    describeCloudflareCliConfig,
    findCloudflareCliConfig,
    warnCloudflareCliConfigOnce,
} from "../../src/cloudflare/cloudflare-cli-config";

let workdir: string;

describe("cloudflare cli config", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-cf-config-"));
        writeFileSync(join(workdir, "wrangler.jsonc"), "{}\n", "utf8");
        Reflect.deleteProperty(process.env, CLOUDFLARE_CLI_CONFIG_WARNING_ENV);
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
        Reflect.deleteProperty(process.env, CLOUDFLARE_CLI_CONFIG_WARNING_ENV);
    });

    describe(findCloudflareCliConfig, () => {
        it("returns undefined when the project has no cloudflare.config.*", () => {
            expect.assertions(1);

            expect(findCloudflareCliConfig(workdir)).toBeUndefined();
        });

        it.each(CLOUDFLARE_CLI_CONFIG_FILES)("finds %s in the project root", (fileName) => {
            expect.assertions(1);

            writeFileSync(join(workdir, fileName), "export default {};\n", "utf8");

            expect(findCloudflareCliConfig(workdir)).toBe(join(workdir, fileName));
        });

        it("ignores a lookalike that is not a cf config", () => {
            expect.assertions(1);

            writeFileSync(join(workdir, "cloudflare.config.json"), "{}\n", "utf8");

            expect(findCloudflareCliConfig(workdir)).toBeUndefined();
        });
    });

    describe(describeCloudflareCliConfig, () => {
        it("names the file and the cf lifecycle commands, and the advice links the tracking issue", () => {
            expect.assertions(4);

            const message = describeCloudflareCliConfig(join(workdir, "cloudflare.config.ts"));

            expect(message).toContain("cloudflare.config.ts found next to wrangler.jsonc");
            expect(message).toContain("Lunora manages wrangler.jsonc");
            expect(CLOUDFLARE_CLI_CONFIG_ADVICE).toContain("resource commands");
            expect(CLOUDFLARE_CLI_CONFIG_ADVICE).toContain(CLOUDFLARE_CLI_ISSUE_URL);
        });
    });

    describe(warnCloudflareCliConfigOnce, () => {
        it("stays quiet without a cf config", () => {
            expect.assertions(2);

            const warn = vi.fn<(message: string) => void>();

            expect(warnCloudflareCliConfigOnce(workdir, warn)).toBe(false);
            expect(warn).not.toHaveBeenCalled();
        });

        it("warns once per process tree, however often it is asked", () => {
            expect.assertions(4);

            writeFileSync(join(workdir, "cloudflare.config.ts"), "export default {};\n", "utf8");

            const warn = vi.fn<(message: string) => void>();

            expect(warnCloudflareCliConfigOnce(workdir, warn)).toBe(true);
            expect(warnCloudflareCliConfigOnce(workdir, warn)).toBe(false);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(process.env[CLOUDFLARE_CLI_CONFIG_WARNING_ENV]).toBe("1");
        });
    });
});
