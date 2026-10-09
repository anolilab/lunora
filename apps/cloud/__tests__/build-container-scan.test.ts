import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WRANGLER_BUNDLE, WRANGLER_MAP } from "./_helpers/build-scan-fixture";

/**
 * The build box's bundle scan, through the real server (`POST /__lunora/build`).
 *
 * No registry and no real CLI: `pnpm` on the server's PATH is a no-op, and the
 * tarball carries its own `node_modules/.bin/lunora` — a stand-in whose `build`
 * copies a fixture module into `.lunora/build` and whose `cloud deploy --out`
 * writes a release. Everything between — extraction, root resolution, the
 * pinned-binary lookup, collection, the scan and the NDJSON — is the server's own.
 */

const SERVER = fileURLToPath(new URL("../containers/build/server.mjs", import.meta.url));

/** The stand-in CLI: `build` and `cloud deploy --out`, nothing else. */
const FAKE_LUNORA = `#!/usr/bin/env node
const fs = require("node:fs");
const [command] = process.argv.slice(2);

if (command === "build") {
    fs.mkdirSync(".lunora/build", { recursive: true });
    fs.copyFileSync("fixture/index.js", ".lunora/build/index.js");
    if (fs.existsSync("fixture/index.js.map")) fs.copyFileSync("fixture/index.js.map", ".lunora/build/index.js.map");
    console.log("build complete");
} else if (command === "cloud") {
    fs.writeFileSync(process.argv[process.argv.indexOf("--out") + 1], JSON.stringify({ manifest: { bindings: [] } }));
} else {
    process.exit(2);
}
`;

let sandbox: string;
let child: ReturnType<typeof spawn>;
let origin: string;

/** A gzipped tarball of a project whose build emits `bundle` (and `map`, when given). */
const tarball = async (name: string, bundle: string, map?: unknown): Promise<Buffer> => {
    const repo = join(sandbox, name, "repo");

    await mkdir(join(repo, "node_modules", ".bin"), { recursive: true });
    await mkdir(join(repo, "fixture"), { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "fixture", private: true }));
    await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(join(repo, "node_modules", ".bin", "lunora"), FAKE_LUNORA);
    await chmod(join(repo, "node_modules", ".bin", "lunora"), 0o755);
    await writeFile(join(repo, "fixture", "index.js"), bundle);

    if (map !== undefined) {
        await writeFile(join(repo, "fixture", "index.js.map"), JSON.stringify(map));
    }

    const archive = join(sandbox, `${name}.tgz`);

    // The `repo/` wrapper is what `--strip-components=1` drops, as GitHub's would be.
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- the system `tar`, as the box itself runs it
    execFileSync("tar", ["-czf", archive, "-C", join(sandbox, name), "repo"]);

    return readFile(archive);
};

/** Every NDJSON record the server streamed for one build. */
const build = async (source: Buffer): Promise<Record<string, unknown>[]> => {
    const response = await fetch(`${origin}/__lunora/build`, { body: new Uint8Array(source), method: "POST" });
    const text = await response.text();

    return text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
};

describe("build box bundle scan", () => {
    beforeAll(async () => {
        sandbox = await mkdtemp(join(tmpdir(), "build-box-scan-"));
        await mkdir(join(sandbox, "bin"), { recursive: true });
        await mkdir(join(sandbox, "home"), { recursive: true });
        // `pnpm install --frozen-lockfile`, as a no-op: the tarball already holds `.bin/lunora`.
        await writeFile(join(sandbox, "bin", "pnpm"), "#!/bin/sh\nexit 0\n");
        await chmod(join(sandbox, "bin", "pnpm"), 0o755);

        child = spawn(process.execPath, [SERVER], {
            env: { ...process.env, HOME: join(sandbox, "home"), PATH: `${join(sandbox, "bin")}:${process.env.PATH ?? ""}`, PORT: "0" },
            stdio: ["ignore", "pipe", "inherit"],
        });

        for await (const chunk of child.stdout ?? []) {
            const port = /listening on (\d+)/u.exec(String(chunk))?.[1];

            if (port !== undefined) {
                origin = `http://127.0.0.1:${port}`;
                break;
            }
        }
    }, 20_000);

    afterAll(async () => {
        child.kill("SIGKILL");
        await once(child, "close");
        await rm(sandbox, { force: true, recursive: true });
    });

    it("streams an advisory record and a warning line per finding, and keeps them off the release", async () => {
        expect.assertions(5);

        // Built into `.lunora/build`, two levels down: the sources move with it.
        const records = await build(
            await tarball("rearm", WRANGLER_BUNDLE, { ...WRANGLER_MAP, sources: ["../../src/index.ts", "../../node_modules/dep/index.js"] }),
        );
        const advisories = records.filter((record) => "advisory" in record).map((record) => record["advisory"]);
        const warnings = records.filter((record) => typeof record["line"] === "string" && /\bwarn/iu.test(record["line"]));
        const release = records.at(-1) ?? {};

        // Only the tenant's alarm: the dependency's loop is dropped.
        expect(advisories).toMatchObject([{ file: "src/index.ts", level: "WARN", line: 7, location: "source", name: "alarm_always_rearms" }]);
        // What the Studio's Warnings tab matches on.
        expect(warnings.map((record) => record["line"])).toStrictEqual([
            expect.stringMatching(/^warning: Alarm re-arms itself almost immediately — .*src\/index\.ts:7/u),
        ]);
        expect(typeof release["bundleHash"]).toBe("string");
        expect(Object.keys(release).filter((key) => key.startsWith("advisor"))).toStrictEqual([]);
        // Before the terminal record, so the control plane stores them while the lease is held.
        expect(records.findIndex((record) => "advisory" in record)).toBeLessThan(records.length - 1);
    }, 30_000);

    it("logs a periodic alarm as a note, which the Warnings tab does not pick up", async () => {
        expect.assertions(3);

        // No sourcemap: attributed by region comment. One hourly job, one tight re-arm.
        const bundle = [
            "// src/index.ts",
            "var Hourly = class {",
            "  async alarm() {",
            "    await this.ctx.storage.setAlarm(Date.now() + 36e5);",
            "  }",
            "};",
            "var Tight = class {",
            "  async alarm() {",
            "    await this.ctx.storage.setAlarm(Date.now());",
            "  }",
            "};",
            "export { Hourly, Tight };",
        ].join("\n");
        const records = await build(await tarball("levels", bundle));
        const lines = records.filter((record) => typeof record["line"] === "string").map((record) => record["line"] as string);

        expect(records.filter((record) => "advisory" in record).map((record) => (record["advisory"] as { level: string }).level)).toStrictEqual([
            "WARN",
            "INFO",
        ]);
        expect(lines.filter((line) => line.startsWith("note:"))).toStrictEqual([
            expect.stringMatching(/^note: Periodic alarm with no way to stop — .*every 1 h/u),
        ]);
        // What `BuildLogsCard` counts as a warning: the tight re-arm only.
        expect(lines.filter((line) => /\bwarn/iu.test(line))).toStrictEqual([expect.stringMatching(/^warning: Alarm re-arms itself almost immediately/u)]);
    }, 30_000);

    it("skips a scan it cannot run with one warning, and still releases the build", async () => {
        expect.assertions(3);

        const records = await build(await tarball("unparsable", "export const = 1;\n"));
        const lines = records.filter((record) => typeof record["line"] === "string").map((record) => record["line"] as string);
        const release = records.at(-1) ?? {};

        expect(lines.filter((line) => line.startsWith("warning:"))).toStrictEqual([
            "warning: build scan skipped: the bundle could not be parsed (Unexpected token (1:13))",
        ]);
        expect(release).not.toHaveProperty("error");
        expect(typeof release["bundleHash"]).toBe("string");
    }, 30_000);
});
