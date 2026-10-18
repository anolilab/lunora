import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { describeWithheld, devConfigBasename, sweepStaleDevConfigs, withheldBindings, writeDevConfig } from "../src/cloudflare/dev-config";

describe(withheldBindings, () => {
    it("withholds a declared ai binding when there is no Cloudflare login", () => {
        expect.assertions(1);

        expect(withheldBindings({ ai: { binding: "AI" } }, () => false)).toStrictEqual([{ binding: "AI", kind: "ai" }]);
    });

    it("names the binding the app declared", () => {
        expect.assertions(1);

        expect(withheldBindings({ ai: { binding: "MY_AI" } }, () => false)).toStrictEqual([{ binding: "MY_AI", kind: "ai" }]);
    });

    it("withholds every declared artifacts binding, remote-only like ai", () => {
        expect.assertions(1);

        expect(withheldBindings({ artifacts: [{ binding: "ARTIFACTS" }, { binding: "MIRROR" }] }, () => false)).toStrictEqual([
            { binding: "ARTIFACTS", kind: "artifacts" },
            { binding: "MIRROR", kind: "artifacts" },
        ]);
    });

    it("keeps every binding when there is a login", () => {
        expect.assertions(1);

        expect(withheldBindings({ ai: { binding: "AI" }, artifacts: [{ binding: "ARTIFACTS" }] }, () => true)).toStrictEqual([]);
    });

    it("never probes credentials when neither binding is declared", () => {
        expect.assertions(4);

        let probed = false;
        const probe = (): boolean => {
            probed = true;

            return false;
        };

        expect(withheldBindings(undefined, probe)).toStrictEqual([]);
        expect(withheldBindings({ ai: null, artifacts: [] }, probe)).toStrictEqual([]);
        expect(withheldBindings({}, probe)).toStrictEqual([]);
        expect(probed).toBe(false);
    });

    it("falls back to AI when the declared binding has no name", () => {
        expect.assertions(1);

        expect(withheldBindings({ ai: {} }, () => false)).toStrictEqual([{ binding: "AI", kind: "ai" }]);
    });
});

describe(describeWithheld, () => {
    it("names the binding and the login that turns it back on", () => {
        expect.assertions(3);

        const message = describeWithheld({ binding: "AI", kind: "ai" });

        expect(message).toContain("AI binding left out");
        expect(message).toContain("wrangler login");
        expect(describeWithheld({ binding: "ARTIFACTS", kind: "artifacts" })).toContain("Artifacts is off");
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
