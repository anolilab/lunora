import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { describeWithheldWorkersAi, devConfigBasename, sweepStaleDevConfigs, withheldWorkersAi, writeDevConfig } from "../src/cloudflare/dev-config";

describe("withheldWorkersAi", () => {
    it("withholds a declared ai binding when there is no Cloudflare login", () => {
        expect.assertions(1);

        expect(withheldWorkersAi({ binding: "AI" }, () => false)).toBe("AI");
    });

    it("names the binding the app declared", () => {
        expect.assertions(1);

        expect(withheldWorkersAi({ binding: "MY_AI" }, () => false)).toBe("MY_AI");
    });

    it("keeps the binding when there is a login", () => {
        expect.assertions(1);

        expect(withheldWorkersAi({ binding: "AI" }, () => true)).toBeUndefined();
    });

    it("never probes credentials when no ai binding is declared", () => {
        expect.assertions(3);

        let probed = false;
        const probe = (): boolean => {
            probed = true;

            return false;
        };

        expect(withheldWorkersAi(undefined, probe)).toBeUndefined();
        expect(withheldWorkersAi(null, probe)).toBeUndefined();
        expect(probed).toBe(false);
    });

    it("falls back to AI when the declared binding has no name", () => {
        expect.assertions(1);

        expect(withheldWorkersAi({}, () => false)).toBe("AI");
    });
});

describe("describeWithheldWorkersAi", () => {
    it("names the binding and the login that turns it back on", () => {
        expect.assertions(2);

        const message = describeWithheldWorkersAi("AI");

        expect(message).toContain("AI binding left out");
        expect(message).toContain("wrangler login");
    });
});

describe("devConfigBasename", () => {
    it("gives each call a distinct name under the lunora prefix", () => {
        expect.assertions(3);

        const first = devConfigBasename("dev");
        const second = devConfigBasename("service");

        expect(first).toMatch(/^\.wrangler\.lunora-dev\.\d+\.\d+\.jsonc$/);
        expect(second).toMatch(/^\.wrangler\.lunora-service\.\d+\.\d+\.jsonc$/);
        expect(first).not.toBe(second);
    });
});

describe("writeDevConfig and the stale sweep", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-dev-config-test-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("writes the contents and removes the file on cleanup", () => {
        expect.assertions(3);

        const written = writeDevConfig(root, "dev", '{ "name": "app" }');

        expect(readFileSync(written.configPath, "utf8")).toBe('{ "name": "app" }');

        written.cleanup();
        written.cleanup();

        expect(existsSync(written.configPath)).toBe(false);
        expect(() => {
            written.cleanup();
        }).not.toThrow();
    });

    it("removes configs whose owning process is gone and keeps live ones", () => {
        expect.assertions(4);

        // pid 2147483646 is above the platform's pid ceiling, so it can't be running.
        const staleDev = join(root, ".wrangler.lunora-dev.2147483646.1.jsonc");
        const staleService = join(root, ".wrangler.lunora-service.2147483646.2.jsonc");
        const live = join(root, `.wrangler.lunora-dev.${String(process.pid)}.99.jsonc`);
        const unrelated = join(root, "wrangler.jsonc");

        writeFileSync(staleDev, "{}", "utf8");
        writeFileSync(staleService, "{}", "utf8");
        writeFileSync(live, "{}", "utf8");
        writeFileSync(unrelated, "{}", "utf8");

        sweepStaleDevConfigs(root);

        expect(existsSync(staleDev)).toBe(false);
        expect(existsSync(staleService)).toBe(false);
        expect(existsSync(live)).toBe(true);
        expect(existsSync(unrelated)).toBe(true);
    });

    it("does not throw when the directory cannot be read", () => {
        expect.assertions(1);

        expect(() => {
            sweepStaleDevConfigs(join(root, "missing"));
        }).not.toThrow();
    });
});
