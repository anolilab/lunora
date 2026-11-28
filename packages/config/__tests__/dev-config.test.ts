import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { describeWithheld, DEV_CONFIG_IGNORE, devConfigBasename, sweepStaleDevConfigs, withheldBindings, writeDevConfig } from "../src/cloudflare/dev-config";

describe(withheldBindings, () => {
    it("reads a malformed artifacts value as no binding instead of throwing", () => {
        expect.assertions(1);

        expect(withheldBindings({ artifacts: { binding: "ARTIFACTS" } } as never, () => false)).toStrictEqual([]);
    });

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

        const written = writeDevConfig(root, "dev", '{ "name": "app" }', root);

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

describe("writeDevConfig and git", () => {
    let root: string;

    const git = (...args: string[]): void => {
        // eslint-disable-next-line sonarjs/no-os-command-from-path -- `git` must resolve from PATH; fixed args, no shell.
        spawnSync("git", args, { cwd: root, stdio: "ignore" });
    };
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- `git` must resolve from PATH; fixed args, no shell.
    const isIgnored = (path: string): boolean => spawnSync("git", ["check-ignore", "-q", path], { cwd: root }).status === 0;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-dev-config-git-"));
        mkdirSync(join(root, "services", "parser"), { recursive: true });
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("ignores a service copy through the project's .gitignore", () => {
        expect.assertions(2);

        git("init", "-q");

        const written = writeDevConfig(join(root, "services", "parser"), "service", "{}", root);

        expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(DEV_CONFIG_IGNORE);
        expect(isIgnored(written.configPath)).toBe(true);
    });

    it("leaves .gitignore alone when git already ignores the file", () => {
        expect.assertions(2);

        git("init", "-q");
        writeFileSync(join(root, ".git", "info", "exclude"), `${DEV_CONFIG_IGNORE}\n`, "utf8");

        const written = writeDevConfig(join(root, "services", "parser"), "service", "{}", root);

        expect(existsSync(join(root, ".gitignore"))).toBe(false);
        expect(isIgnored(written.configPath)).toBe(true);
    });

    it("uses the service folder's own .gitignore when the folder is outside the project", () => {
        expect.assertions(2);

        git("init", "-q");

        const app = join(root, "app");

        mkdirSync(app);
        writeDevConfig(join(root, "services", "parser"), "service", "{}", app);

        expect(readFileSync(join(root, "services", "parser", ".gitignore"), "utf8")).toContain(DEV_CONFIG_IGNORE);
        expect(existsSync(join(app, ".gitignore"))).toBe(false);
    });

    it("writes nothing through a .gitignore that is a symlink, which git does not read", () => {
        expect.assertions(1);

        git("init", "-q");
        writeFileSync(join(root, "shared-ignore"), "node_modules\n", "utf8");
        symlinkSync(join(root, "shared-ignore"), join(root, ".gitignore"));

        writeDevConfig(join(root, "services", "parser"), "service", "{}", root);

        expect(readFileSync(join(root, "shared-ignore"), "utf8")).toBe("node_modules\n");
    });

    it("ignores a service copy in a nested repository through that repository's own .gitignore", () => {
        expect.assertions(1);

        git("init", "-q");
        // eslint-disable-next-line sonarjs/no-os-command-from-path -- `git` must resolve from PATH; fixed args, no shell.
        spawnSync("git", ["init", "-q"], { cwd: join(root, "services", "parser"), stdio: "ignore" });

        const written = writeDevConfig(join(root, "services", "parser"), "service", "{}", root);

        // eslint-disable-next-line sonarjs/no-os-command-from-path -- `git` must resolve from PATH; fixed args, no shell.
        expect(spawnSync("git", ["check-ignore", "-q", written.configPath], { cwd: join(root, "services", "parser") }).status).toBe(0);
    });

    it("checks every copy, not just the first in a folder", () => {
        expect.assertions(1);

        git("init", "-q");
        // Covers the app's own copy only, so the service copy written next to it still needs a line.
        writeFileSync(join(root, ".git", "info", "exclude"), ".wrangler.lunora-dev.*\n", "utf8");

        writeDevConfig(root, "dev", "{}", root);

        const service = writeDevConfig(root, "service", "{}", root);

        expect(isIgnored(service.configPath)).toBe(true);
    });

    it("writes no .gitignore outside a repository", () => {
        expect.assertions(1);

        writeDevConfig(root, "dev", "{}", root);

        expect(existsSync(join(root, ".gitignore"))).toBe(false);
    });
});
