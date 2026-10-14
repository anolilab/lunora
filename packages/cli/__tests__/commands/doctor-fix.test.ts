import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyDoctorFixes } from "../../src/commands/doctor/fix";
import type { Logger } from "../../src/util/logger";

const PLACEHOLDER = "<replace-with-d1-create-id>";

const WRANGLER = `{
    // The app's own database. The id is filled in by \`lunora doctor --fix\`.
    "name": "app",
    "d1_databases": [
        {
            "binding": "DB",
            "database_name": "app-db",
            "database_id": "${PLACEHOLDER}",
        },
    ],
}
`;

interface StubDatabase {
    name: string;
    uuid: string;
}

/**
 * A `wrangler` stand-in: `d1 list --json` answers from `databases`, and
 * `d1 create <name>` adds one with a fixed uuid. Every call is recorded so a test
 * can assert that nothing was created when it should not have been.
 */
const stubWrangler = (databases: StubDatabase[]) => {
    const calls: string[][] = [];

    const runner = async (args: ReadonlyArray<string>) => {
        calls.push([...args]);

        if (args[0] === "d1" && args[1] === "list") {
            return {
                code: 0,
                stderr: "",
                stdout: JSON.stringify(
                    databases.map((db) => {
                        return { name: db.name, uuid: db.uuid };
                    }),
                ),
            };
        }

        if (args[0] === "d1" && args[1] === "create") {
            databases.push({ name: args[2] as string, uuid: "11111111-2222-3333-4444-555555555555" });

            return { code: 0, stderr: "", stdout: "" };
        }

        return { code: 1, stderr: `unexpected ${args.join(" ")}`, stdout: "" };
    };

    return { calls, runner };
};

const silentLogger: Logger = {
    debug: () => 0,
    error: () => 0,
    info: () => 0,
    success: () => 0,
    warn: () => 0,
};

describe("lunora doctor --fix", () => {
    let workdir: string;
    const savedAdminToken = process.env.LUNORA_ADMIN_TOKEN;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "doctor-fix-"));
        writeFileSync(join(workdir, ".gitignore"), ".dev.vars\n");
        delete process.env.LUNORA_ADMIN_TOKEN;
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });

        if (savedAdminToken === undefined) {
            delete process.env.LUNORA_ADMIN_TOKEN;
        } else {
            process.env.LUNORA_ADMIN_TOKEN = savedAdminToken;
        }
    });

    it("points a placeholder D1 id at the existing database and keeps the config's comments", async () => {
        expect.hasAssertions();

        writeFileSync(join(workdir, "wrangler.jsonc"), WRANGLER);
        const { calls, runner } = stubWrangler([{ name: "app-db", uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }]);

        const result = await applyDoctorFixes({
            configPath: join(workdir, "wrangler.jsonc"),
            cwd: workdir,
            dryRun: false,
            logger: silentLogger,
            runner,
        });

        const written = readFileSync(join(workdir, "wrangler.jsonc"), "utf8");

        expect(written).toContain('"database_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"');
        expect(written).not.toContain(PLACEHOLDER);
        expect(written).toContain("// The app's own database.");
        expect(calls.some((call) => call[1] === "create")).toBe(false);
        expect(result.applied.some((line) => line.includes("app-db"))).toBe(true);
    });

    it("creates the database when the account has none, then writes its id", async () => {
        expect.hasAssertions();

        writeFileSync(join(workdir, "wrangler.jsonc"), WRANGLER);
        const { calls, runner } = stubWrangler([]);

        await applyDoctorFixes({ configPath: join(workdir, "wrangler.jsonc"), cwd: workdir, dryRun: false, logger: silentLogger, runner });

        expect(calls).toContainEqual(["d1", "create", "app-db"]);
        expect(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")).toContain('"database_id": "11111111-2222-3333-4444-555555555555"');
    });

    it("under dryRun creates nothing and writes nothing", async () => {
        expect.hasAssertions();

        writeFileSync(join(workdir, "wrangler.jsonc"), WRANGLER);
        const { calls, runner } = stubWrangler([]);

        const result = await applyDoctorFixes({ configPath: join(workdir, "wrangler.jsonc"), cwd: workdir, dryRun: true, logger: silentLogger, runner });

        expect(calls.some((call) => call[1] === "create")).toBe(false);
        expect(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")).toContain(PLACEHOLDER);
        expect(result.applied.some((line) => line.startsWith("would run `wrangler d1 create app-db`"))).toBe(true);
    });

    it("mints the admin token into a new .dev.vars when it is missing", async () => {
        expect.hasAssertions();

        const result = await applyDoctorFixes({ configPath: undefined, cwd: workdir, dryRun: false, logger: silentLogger });

        const devVars = readFileSync(join(workdir, ".dev.vars"), "utf8");

        expect(devVars).toMatch(/^LUNORA_ADMIN_TOKEN="[0-9a-f]{64}"$/mu);
        expect(result.applied.some((line) => line.includes("LUNORA_ADMIN_TOKEN"))).toBe(true);
    });

    it("never overwrites a value that is already set", async () => {
        expect.hasAssertions();

        writeFileSync(join(workdir, ".dev.vars"), 'LUNORA_ADMIN_TOKEN="keep-me"\n');

        await applyDoctorFixes({ configPath: undefined, cwd: workdir, dryRun: false, logger: silentLogger });

        expect(readFileSync(join(workdir, ".dev.vars"), "utf8")).toBe('LUNORA_ADMIN_TOKEN="keep-me"\n');
    });

    it("refuses to write .dev.vars when git would not ignore it", async () => {
        expect.hasAssertions();

        writeFileSync(join(workdir, ".gitignore"), "node_modules\n");

        const result = await applyDoctorFixes({ configPath: undefined, cwd: workdir, dryRun: false, logger: silentLogger });

        expect(existsSync(join(workdir, ".dev.vars"))).toBe(false);
        expect(result.skipped.some((line) => line.includes("not in .gitignore"))).toBe(true);
    });

    it("does not mint a second admin token when one is already exported", async () => {
        expect.hasAssertions();

        process.env.LUNORA_ADMIN_TOKEN = "from-the-shell";

        await applyDoctorFixes({ configPath: undefined, cwd: workdir, dryRun: false, logger: silentLogger });

        expect(existsSync(join(workdir, ".dev.vars"))).toBe(false);
    });

    it("accepts a /.dev.vars rule inside a git repository, which the exact-line check would refuse", async () => {
        expect.hasAssertions();

        // eslint-disable-next-line sonarjs/no-os-command-from-path -- `git` must resolve from PATH; fixed args, no shell.
        spawnSync("git", ["init", "-q"], { cwd: workdir });
        writeFileSync(join(workdir, ".gitignore"), "/.dev.vars\n");

        await applyDoctorFixes({ configPath: undefined, cwd: workdir, dryRun: false, logger: silentLogger });

        expect(readFileSync(join(workdir, ".dev.vars"), "utf8")).toMatch(/^LUNORA_ADMIN_TOKEN="[0-9a-f]{64}"$/mu);
    });

    it("never mints over a real value that a later placeholder duplicate shadows", async () => {
        expect.hasAssertions();

        // eslint-disable-next-line no-secrets/no-secrets -- fixture values in a .dev.vars body, not credentials.
        const original = 'LUNORA_ADMIN_TOKEN="kept"\nAUTH_SECRET="real-value"\nAUTH_SECRET="<replace-with-secret>"\n';
        writeFileSync(join(workdir, ".dev.vars"), original);

        await applyDoctorFixes({ configPath: undefined, cwd: workdir, dryRun: false, logger: silentLogger });

        expect(readFileSync(join(workdir, ".dev.vars"), "utf8")).toBe(original);
    });
});
