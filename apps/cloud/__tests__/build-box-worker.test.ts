import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WRANGLER_BUNDLE, WRANGLER_MAP } from "./_helpers/build-scan-fixture";

/**
 * The build box's `runtime: "worker"` path, through the real server
 * (`POST /__lunora/build?runtime=worker`).
 *
 * No registry and no real wrangler: `pnpm` on the server's PATH is a no-op, and
 * the tarball carries a stand-in `wrangler` package — its `unstable_readConfig`
 * reads a `wrangler.json` and resolves `main`, and its `.bin/wrangler` answers
 * `deploy &lt;entry> --dry-run --outdir &lt;dir>` by writing a fixture module there,
 * printing what it was run with as log lines so the test can see them.
 * Everything between — the config read in a child process, the translation, the
 * shim, collection, the scan and the NDJSON — is the server's own.
 */

const SERVER = fileURLToPath(new URL("../containers/build/server.mjs", import.meta.url));

/** The stand-in `wrangler` package: the two config readers the box calls, over `wrangler.json`. */
const FAKE_WRANGLER_PACKAGE = `const fs = require("node:fs");
const path = require("node:path");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

exports.experimental_readRawConfig = ({ config }) => ({ rawConfig: read(config) });
exports.unstable_readConfig = ({ config }) => {
    const raw = read(config);

    // A real resolved config carries defaults the file never declared; the box must drop them.
    return { ...raw, jsx_factory: "React.createElement", main: path.resolve(path.dirname(config), raw.main), triggers: raw.triggers ?? { crons: [] } };
};
`;

/** The stand-in `.bin/wrangler`: `deploy &lt;entry> --config &lt;c> --dry-run --outdir &lt;dir>`. */
const FAKE_WRANGLER_BIN = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const outdir = argv[argv.indexOf("--outdir") + 1];

console.log("ARGV " + JSON.stringify(argv));
const env = process.env;
console.log("ENV " + JSON.stringify({ hide: env["WRANGLER_HIDE_BANNER"], metrics: env["WRANGLER_SEND_METRICS"], token: env["CLOUDFLARE_API_TOKEN"] ?? null }));
console.log("SHIM " + JSON.stringify(fs.readFileSync(argv[1], "utf8")));
console.log("RUNTIME " + JSON.stringify(fs.existsSync(path.join(path.dirname(argv[1]), "shim-runtime.mjs"))));
fs.mkdirSync(outdir, { recursive: true });
fs.copyFileSync("fixture/index.js", path.join(outdir, "index.js"));

if (fs.existsSync("fixture/index.js.map")) {
    // Sources relative to the out-dir, as wrangler writes them: the out-dir is outside the repo.
    const map = JSON.parse(fs.readFileSync("fixture/index.js.map", "utf8"));

    map.sources = map.sources.map((source) => path.relative(outdir, path.join(process.cwd(), source)));
    fs.writeFileSync(path.join(outdir, "index.js.map"), JSON.stringify(map));
}

if (process.env.FAKE_EXTRA_MODULE === "1" || fs.existsSync("fixture/extra")) {
    fs.writeFileSync(path.join(outdir, "chunk.js"), "export {};");
}

fs.writeFileSync(path.join(outdir, "README.md"), "dry run");
`;

/** A plain Worker: a cron, a queue it both produces to and consumes, a Durable Object class, vars and assets. */
const WORKER_CONFIG = {
    compatibility_date: "2025-06-01",
    durable_objects: { bindings: [{ class_name: "Counter", name: "COUNTER" }] },
    main: "src/index.ts",
    migrations: [{ new_sqlite_classes: ["Counter"], tag: "v1" }],
    name: "plain-worker",
    queues: { consumers: [{ queue: "jobs" }], producers: [{ binding: "JOB_QUEUE", queue: "jobs" }] },
    triggers: { crons: ["*/5 * * * *"] },
    vars: { GREETING: "hello" },
};

let sandbox: string;
let child: ReturnType<typeof spawn>;
let origin: string;

interface Project {
    /** Extra files, relative to the repo root. */
    files?: Record<string, string>;
    /** Leave `.bin/wrangler` out. */
    noWrangler?: boolean;
    /** A symlink to create, relative to the repo root → its target. */
    symlinks?: Record<string, string>;
    wrangler?: Record<string, unknown>;
}

/** A gzipped tarball of a plain Worker project. */
const tarball = async (name: string, project: Project = {}): Promise<Buffer> => {
    const repo = join(sandbox, name, "repo");

    await mkdir(join(repo, "node_modules", ".bin"), { recursive: true });
    await mkdir(join(repo, "node_modules", "wrangler"), { recursive: true });
    await mkdir(join(repo, "fixture"), { recursive: true });
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "public"), { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify({ devDependencies: { wrangler: "4.0.0" }, name: "plain", private: true }));
    await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(join(repo, "node_modules", "wrangler", "package.json"), JSON.stringify({ main: "index.js", name: "wrangler" }));
    await writeFile(join(repo, "node_modules", "wrangler", "index.js"), FAKE_WRANGLER_PACKAGE);

    if (project.noWrangler !== true) {
        await writeFile(join(repo, "node_modules", ".bin", "wrangler"), FAKE_WRANGLER_BIN);
        await chmod(join(repo, "node_modules", ".bin", "wrangler"), 0o755);
    }

    await writeFile(join(repo, "src", "index.ts"), "export default { fetch() { return new Response('ok'); } };\n");
    await writeFile(join(repo, "public", "index.html"), "<h1>hi</h1>\n");
    await writeFile(join(repo, "fixture", "index.js"), "export default { fetch() { return new Response('ok'); } };\n");

    if (project.wrangler !== undefined) {
        await writeFile(join(repo, "wrangler.json"), JSON.stringify(project.wrangler));
    }

    await Promise.all(
        Object.entries(project.files ?? {}).map(async ([path, content]) => {
            await mkdir(join(repo, path, ".."), { recursive: true });
            await writeFile(join(repo, path), content);
        }),
    );
    await Promise.all(Object.entries(project.symlinks ?? {}).map(async ([path, target]) => symlink(target, join(repo, path))));

    const archive = join(sandbox, `${name}.tgz`);

    // eslint-disable-next-line sonarjs/no-os-command-from-path -- the system `tar`, as the box itself runs it
    execFileSync("tar", ["-czf", archive, "-C", join(sandbox, name), "repo"]);

    return readFile(archive);
};

/** Every NDJSON record the server streamed for one build. */
const build = async (source: Buffer, query = "runtime=worker"): Promise<Record<string, unknown>[]> => {
    const response = await fetch(`${origin}/__lunora/build?${query}`, { body: new Uint8Array(source), method: "POST" });
    const text = await response.text();

    return text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
};

/** The stand-in's `&lt;TAG> &lt;json>` log line, parsed. */
const tagged = (records: Record<string, unknown>[], tag: string): unknown => {
    const line = records.map((record) => record["line"]).find((value): value is string => typeof value === "string" && value.startsWith(`${tag} `));

    return line === undefined ? undefined : JSON.parse(line.slice(tag.length + 1));
};

describe("build box worker runtime", () => {
    beforeAll(async () => {
        sandbox = await mkdtemp(join(tmpdir(), "build-box-worker-"));
        await mkdir(join(sandbox, "bin"), { recursive: true });
        await mkdir(join(sandbox, "home"), { recursive: true });
        await writeFile(join(sandbox, "bin", "pnpm"), "#!/bin/sh\nexit 0\n");
        await chmod(join(sandbox, "bin", "pnpm"), 0o755);

        child = spawn(process.execPath, [SERVER], {
            env: {
                ...process.env,
                // Must never reach wrangler: a dry run needs no account.
                CLOUDFLARE_API_TOKEN: "leaked",
                HOME: join(sandbox, "home"),
                PATH: `${join(sandbox, "bin")}:${process.env.PATH ?? ""}`,
                PORT: "0",
            },
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

    it("releases a plain Worker: manifest, vars, crons, assets and the bundle, built behind the shim", async () => {
        expect.assertions(9);

        const records = await build(await tarball("release", { wrangler: { ...WORKER_CONFIG, assets: { directory: "./public" } } }));
        const release = records.at(-1) ?? {};

        expect(release).not.toHaveProperty("error");
        expect(release).toMatchObject({
            assets: { files: [{ content: Buffer.from("<h1>hi</h1>\n").toString("base64"), path: "/index.html" }] },
            cronSpecs: ["*/5 * * * *"],
            manifest: {
                bindings: [
                    // Synthesized: the config named no binding, and the platform binds assets as ASSETS.
                    { binding: "ASSETS", type: "assets" },
                    { binding: "COUNTER", className: "Counter", sqlite: true, type: "durable_object" },
                    { binding: "jobs", resource: "jobs", type: "queue_consumer" },
                    { binding: "JOB_QUEUE", resource: "jobs", type: "queue_producer" },
                ].toSorted((a, b) => a.type.localeCompare(b.type) || a.binding.localeCompare(b.binding)),
                compatibilityDate: "2025-06-01",
                vars: { GREETING: "hello" },
            },
            scriptName: "plain-worker",
        });
        expect(typeof release["bundleHash"]).toBe("string");
        expect(Buffer.from(release["bundle"] as string, "base64").toString("utf8")).toContain("new Response('ok')");

        const argv = tagged(records, "ARGV") as string[];

        // The pinned wrangler bundles the generated entry, into a directory outside the repo.
        // `argv[1]` is the generated entry, beside the repo; asserted through its content below.
        expect([argv[0], ...argv.slice(2)]).toStrictEqual([
            "deploy",
            "--config",
            expect.stringMatching(/\/build-[^/]+\/wrangler\.json$/u) as unknown as string,
            "--dry-run",
            "--outdir",
            expect.stringMatching(/\.worker\/out$/u) as unknown as string,
        ]);
        expect(tagged(records, "ENV")).toStrictEqual({ hide: "true", metrics: "false", token: null });

        const shim = tagged(records, "SHIM") as string;

        expect(shim).toContain('import { wrapEntry } from "./shim-runtime.mjs";');
        // The forwarded `{alias}--job-queue` maps back to the Worker's own queue name.
        expect(shim).toContain('wrapEntry(worker.default, {"--job-queue":"jobs"})');
        expect(tagged(records, "RUNTIME")).toBe(true);
    }, 30_000);

    it("re-exports the Worker's module from its resolved, absolute main", async () => {
        expect.assertions(2);

        const records = await build(await tarball("main", { wrangler: WORKER_CONFIG }));
        const shim = tagged(records, "SHIM") as string;
        const [, entry] = /^export \* from ("[^"]+");$/mu.exec(shim) ?? [];

        // The extracted repo (GitHub's wrapper directory stripped), not wherever the archive was made.
        expect(JSON.parse(entry ?? '""')).toMatch(/\/home\/build-[^/]+\/src\/index\.ts$/u);
        expect(shim).toMatch(/^import \* as worker from "[^"]+\/build-[^/]+\/src\/index\.ts";$/mu);
    }, 30_000);

    it("keeps a tenant finding attributed to its source although the bundle is built outside the repo", async () => {
        expect.assertions(2);

        const records = await build(
            await tarball("scan", {
                files: {
                    "fixture/index.js": WRANGLER_BUNDLE,
                    "fixture/index.js.map": JSON.stringify({ ...WRANGLER_MAP, sources: ["src/index.ts", "node_modules/dep/index.js"] }),
                },
                wrangler: WORKER_CONFIG,
            }),
        );
        const advisories = records.filter((record) => "advisory" in record).map((record) => record["advisory"]);

        // The dependency's loop is still dropped; the tenant's alarm is not.
        expect(advisories).toMatchObject([{ file: "src/index.ts", level: "WARN", line: 7, location: "source", name: "alarm_always_rearms" }]);
        expect(records.at(-1)).toHaveProperty("bundleHash");
    }, 30_000);

    it("refuses a project whose wrangler is not in its lockfile, never fetching one", async () => {
        expect.assertions(1);

        const records = await build(await tarball("no-wrangler", { noWrangler: true, wrangler: WORKER_CONFIG }));

        expect(records.at(-1)?.["error"]).toMatch(/^node_modules\/\.bin\/wrangler is missing after install — add wrangler to the project's devDependencies/u);
    }, 30_000);

    it("refuses a project with no wrangler config", async () => {
        expect.assertions(1);

        const records = await build(await tarball("no-config"));

        expect(records.at(-1)?.["error"]).toMatch(/^no wrangler\.json, wrangler\.jsonc or wrangler\.toml in the repository root/u);
    }, 30_000);

    it("refuses a var that is not a string, by name, rather than stringify it", async () => {
        expect.assertions(1);

        const records = await build(await tarball("vars", { wrangler: { ...WORKER_CONFIG, vars: { GREETING: "hi", LIMIT: 3, ON: true } } }));

        expect(records.at(-1)?.["error"]).toMatch(/these are not strings: LIMIT \(number\), ON \(boolean\)/u);
    }, 30_000);

    it("refuses an assets binding the platform cannot honour", async () => {
        expect.assertions(1);

        const records = await build(await tarball("assets-name", { wrangler: { ...WORKER_CONFIG, assets: { binding: "STATIC", directory: "./public" } } }));

        expect(records.at(-1)?.["error"]).toMatch(/assets binding is named STATIC, but Lunora Cloud binds static assets as ASSETS/u);
    }, 30_000);

    it("refuses an asset that is a symlink out of the repository", async () => {
        expect.assertions(1);

        const records = await build(
            await tarball("assets-escape", { symlinks: { "public/passwd": "/etc/passwd" }, wrangler: { ...WORKER_CONFIG, assets: { directory: "./public" } } }),
        );

        expect(records.at(-1)?.["error"]).toBe("the asset public/passwd is a symlink that leads outside the repository and was refused");
    }, 30_000);

    it("refuses a bundle split into several modules", async () => {
        expect.assertions(1);

        const records = await build(await tarball("chunks", { files: { "fixture/extra": "" }, wrangler: WORKER_CONFIG }));

        expect(records.at(-1)?.["error"]).toMatch(/^`wrangler deploy --dry-run` produced 2 modules \(chunk\.js, index\.js\)/u);
    }, 30_000);

    it("refuses a Vite-plugin Worker instead of shipping it without its frontend", async () => {
        expect.assertions(1);

        const records = await build(
            await tarball("vite", {
                files: { "package.json": JSON.stringify({ devDependencies: { "@cloudflare/vite-plugin": "1.0.0", wrangler: "4.0.0" }, name: "v" }) },
                wrangler: WORKER_CONFIG,
            }),
        );

        expect(records.at(-1)?.["error"]).toMatch(/builds with @cloudflare\/vite-plugin/u);
    }, 30_000);

    it("tells a Worker project built as Lunora to change its runtime setting", async () => {
        expect.assertions(1);

        const records = await build(await tarball("as-lunora", { wrangler: WORKER_CONFIG }), "runtime=lunora");

        expect(records.at(-1)?.["error"]).toMatch(
            /^node_modules\/\.bin\/lunora is missing after install, but the project has a wrangler\.json\. If this is a plain Cloudflare Worker, set the project's runtime to Cloudflare Worker/u,
        );
    }, 30_000);

    it("400s an unknown runtime before reading the source", async () => {
        expect.assertions(2);

        const response = await fetch(`${origin}/__lunora/build?runtime=python`, { body: new Uint8Array(0), method: "POST" });

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toStrictEqual({ error: 'runtime "python" is not one of lunora, worker and was refused' });
    });
});
