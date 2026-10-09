import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAP_COMMENT, WRANGLER_BUNDLE, WRANGLER_MAP } from "./_helpers/build-scan-fixture";

/**
 * The build box's bundle scan (`containers/build/scan.mjs`) — the attribution
 * half: which findings the tenant can act on, and where they are.
 *
 * The bundle holds every dependency, so the scan's value depends on dropping
 * what is not the tenant's code. The first fixture is real `wrangler deploy
 * --dry-run --outdir out` output (wrangler 4.147) for a Worker with a Durable
 * Object whose alarm always re-arms and a dependency with an exitless loop; the
 * rest use a sourcemap built here, so each attribution rule is pinned alone.
 */

interface Advisory {
    cacheKey: string;
    detail: string;
    file: string;
    level: string;
    line: number;
    location: "bundle" | "source";
    name: string;
    remediation: string;
    title: string;
}

interface ScanModule {
    decodeMappings: (mappings: string, wanted: Set<number>, check: () => void) => Map<number, number[][]>;
    scanBundle: (input: {
        bundle: Buffer;
        bundlePath: string;
        heapAvailable?: () => number;
        limits?: Record<string, number>;
        manifest?: unknown;
        now?: () => number;
        project: string;
        repo: string;
    }) => Promise<{ advisories: Advisory[]; omitted: number }>;
    scanFailure: (error: unknown) => string;
}

const { decodeMappings, scanBundle, scanFailure } = (await import(new URL("../containers/build/scan.mjs", import.meta.url).href)) as ScanModule;

// eslint-disable-next-line no-secrets/no-secrets -- the base64 alphabet, not a credential
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** One VLQ field: sign in the lowest bit, then five bits per digit, continuation flagged by 32. */
const vlq = (value: number): string => {
    let rest = value < 0 ? -value * 2 + 1 : value * 2;
    let out = "";

    do {
        const digit = rest % 32;

        rest = Math.floor(rest / 32);
        out += BASE64[rest > 0 ? digit + 32 : digit];
    } while (rest > 0);

    return out;
};

/**
 * A `mappings` string mapping each generated line (index + 1) that has an entry
 * to `[source, originalLine]` (1-based line), at column 0.
 */
const encodeMappings = (lines: ReadonlyArray<readonly [number, number] | undefined>): string => {
    let source = 0;
    let originalLine = 0;

    return lines
        .map((entry) => {
            if (entry === undefined) {
                return "";
            }

            const [entrySource, entryLine] = entry;
            const segment = vlq(0) + vlq(entrySource - source) + vlq(entryLine - 1 - originalLine) + vlq(0);

            source = entrySource;
            originalLine = entryLine - 1;

            return segment;
        })
        .join(";");
};

let sandbox: string;

const write = async (path: string, content: string): Promise<void> => {
    await mkdir(dirname(join(sandbox, path)), { recursive: true });
    await writeFile(join(sandbox, path), content);
};

/** Scan the module at `bundlePath` in the sandbox repo, with `project` (repo-relative) as the directory `lunora build` ran in. */
const scan = async (
    bundlePath: string,
    code: string,
    options: { heapAvailable?: () => number; limits?: Record<string, number>; now?: () => number; project?: string } = {},
): Promise<{ advisories: Advisory[]; omitted: number }> =>
    scanBundle({
        bundle: Buffer.from(code),
        bundlePath: join(sandbox, bundlePath),
        ...(options.heapAvailable === undefined ? {} : { heapAvailable: options.heapAvailable }),
        ...(options.limits === undefined ? {} : { limits: options.limits }),
        ...(options.now === undefined ? {} : { now: options.now }),
        project: join(sandbox, options.project ?? ""),
        repo: sandbox,
    });

describe("scanBundle attribution", () => {
    beforeEach(async () => {
        sandbox = await realpath(await mkdtemp(join(tmpdir(), "build-scan-")));
    });

    afterEach(async () => {
        await rm(sandbox, { force: true, recursive: true });
    });

    it("maps real wrangler output to the original file and drops the dependency's loop", async () => {
        expect.assertions(1);

        await write("out/index.js", WRANGLER_BUNDLE);
        await write("out/index.js.map", JSON.stringify(WRANGLER_MAP));

        const { advisories, omitted } = await scan("out/index.js", WRANGLER_BUNDLE);

        expect({ advisories, omitted }).toStrictEqual({
            advisories: [
                {
                    cacheKey: "alarm_always_rearms:src/index.ts:7",
                    detail: expect.stringContaining("src/index.ts:7"),
                    file: "src/index.ts",
                    level: "WARN",
                    line: 7,
                    location: "source",
                    name: "alarm_always_rearms",
                    remediation: expect.stringContaining("deleteAlarm"),
                    title: "Alarm always re-arms itself",
                },
            ],
            omitted: 0,
        });
    });

    it("falls back to esbuild's region comments without a sourcemap, still dropping dependency code", async () => {
        expect.assertions(1);

        await write("out/index.js", WRANGLER_BUNDLE);

        const { advisories } = await scan("out/index.js", WRANGLER_BUNDLE);

        // The bundle's own line, against the file its region names.
        expect(
            advisories.map(({ file, line, location, name }) => {
                return { file, line, location, name };
            }),
        ).toStrictEqual([{ file: "src/index.ts", line: 22, location: "bundle", name: "alarm_always_rearms" }]);
    });

    it("keeps a finding with no attribution at all against the bundle, under the tighter cap", async () => {
        expect.assertions(2);

        const code = Array.from({ length: 4 }, (_, index) => `export function spin${String(index)}() { while (true) {} }`).join("\n");

        await write(".lunora/build/index.js", code);

        const { advisories, omitted } = await scan(".lunora/build/index.js", code, { limits: { maxBundleFindings: 3 } });

        expect(advisories.map(({ file, location }) => `${location}:${file}`)).toStrictEqual(Array.from({ length: 3 }).fill("bundle:.lunora/build/index.js"));
        expect(omitted).toBe(1);
    });

    it("keeps the repo's own workspace packages and drops dependencies, generated code and anything outside the repo", async () => {
        expect.assertions(1);

        // A monorepo app at apps/web, built into apps/web/.lunora/build.
        const code = [
            "export function a() { while (true) {} }",
            "export function b() { while (true) {} }",
            "export function c() { while (true) {} }",
            "export function d() { while (true) {} }",
            "export function e() { while (true) {} }",
            "export function f() { while (true) {} }",
            "export function g() { while (true) {} }",
        ].join("\n");
        const sources = [
            "../../src/app.ts",
            "../../../../packages/shared/src/loop.ts",
            "../../../../node_modules/.pnpm/dep@1.0.0/node_modules/dep/index.js",
            "../../.wrangler/tmp/bundle/middleware.ts",
            "../../../../../outside/evil.ts",
            "https://example.com/remote.ts",
        ];

        await write("apps/web/.lunora/build/index.js", code);
        await write(
            "apps/web/.lunora/build/index.js.map",
            JSON.stringify({
                // Line 7 has no mapping at all.
                mappings: encodeMappings([[0, 3], [1, 9], [2, 1], [3, 1], [4, 1], [5, 1], undefined]),
                sources,
                version: 3,
            }),
        );

        const { advisories } = await scan("apps/web/.lunora/build/index.js", code, { project: "apps/web" });

        expect(advisories.map(({ file, line, location }) => `${location}:${file}:${String(line)}`)).toStrictEqual([
            "source:apps/web/src/app.ts:3",
            "source:packages/shared/src/loop.ts:9",
        ]);
    });

    it("resolves sources against the out-dir as the bundler was given it, even through a symlink", async () => {
        expect.assertions(1);

        const code = "export function spin() { while (true) {} }";

        // The real out-dir is two levels deep; the bundler was handed a one-level symlink to it.
        await write("build/out/index.js", code);
        await write("build/out/index.js.map", JSON.stringify({ mappings: encodeMappings([[0, 2]]), sources: ["../src/app.ts"], version: 3 }));
        await symlink(join(sandbox, "build", "out"), join(sandbox, "link"));

        const { advisories } = await scan("link/index.js", code);

        expect(advisories.map(({ file, line, location }) => `${location}:${file}:${String(line)}`)).toStrictEqual(["source:src/app.ts:2"]);
    });

    it("never follows a sourceMappingURL out of the bundle's own directory", async () => {
        expect.assertions(1);

        const code = `export function spin() { while (true) {} }\n${MAP_COMMENT}../../elsewhere.map\n`;

        await write("app/.lunora/build/index.js", code);
        // A map that WOULD place the loop in the tenant's code, were it read.
        await write("app/elsewhere.map", JSON.stringify({ mappings: encodeMappings([[0, 1]]), sources: ["src/real.ts"], version: 3 }));

        const { advisories } = await scan("app/.lunora/build/index.js", code, { project: "app" });

        expect(advisories.map(({ file, location }) => `${location}:${file}`)).toStrictEqual(["bundle:app/.lunora/build/index.js"]);
    });

    it("caps the findings it reports and says how many it held back", async () => {
        expect.assertions(2);

        const code = Array.from({ length: 5 }, (_, index) => `export function spin${String(index)}() { while (true) {} }`).join("\n");

        await write("out/index.js", code);
        await write(
            "out/index.js.map",
            JSON.stringify({
                mappings: encodeMappings([
                    [0, 1],
                    [0, 2],
                    [0, 3],
                    [0, 4],
                    [0, 5],
                ]),
                sources: ["../src/loops.ts"],
                version: 3,
            }),
        );

        const { advisories, omitted } = await scan("out/index.js", code, { limits: { maxFindings: 2 } });

        expect(advisories.map((advisory) => advisory.line)).toStrictEqual([1, 2]);
        expect(omitted).toBe(3);
    });

    it("gives two findings on one line distinct cache keys", async () => {
        expect.assertions(1);

        const code = "export function spin() { while (true) {} while (true) {} }";

        await write("out/index.js", code);
        await write("out/index.js.map", JSON.stringify({ mappings: encodeMappings([[0, 4]]), sources: ["../src/twice.ts"], version: 3 }));

        const { advisories } = await scan("out/index.js", code);

        expect(advisories.map((advisory) => advisory.cacheKey)).toStrictEqual(["unbounded_loop:src/twice.ts:4", "unbounded_loop:src/twice.ts:4:2"]);
    });
});

describe("scanBundle limits and failures", () => {
    beforeEach(async () => {
        sandbox = await realpath(await mkdtemp(join(tmpdir(), "build-scan-")));
    });

    afterEach(async () => {
        await rm(sandbox, { force: true, recursive: true });
    });

    it("refuses a bundle over the size cap before parsing it", async () => {
        expect.assertions(1);

        await write("out/index.js", "x");

        await expect(scan("out/index.js", "export const big = 1;".repeat(10), { limits: { maxBundleBytes: 100 } })).rejects.toThrow(
            /^the bundle is 0\.0 MiB, over the 0\.0000\d+ MiB the scan reads$/u,
        );
    });

    it("skips, rather than attempts, a scan the free heap cannot hold", async () => {
        expect.assertions(1);

        const code = "export function spin() { while (true) {} }";

        await write("out/index.js", code);

        // 42 bytes at 48 heap bytes each is 2016 bytes; 2000 are free.
        await expect(scan("out/index.js", code, { heapAvailable: () => 2000 })).rejects.toThrow(
            /^scanning a 0\.0 MiB bundle needs about 1 MiB of memory and 0 MiB is free$/u,
        );
    });

    it("refuses a sourcemap over its cap", async () => {
        expect.assertions(1);

        await write("out/index.js", "export const a = 1;");
        await write("out/index.js.map", JSON.stringify({ mappings: "AAAA", padding: "x".repeat(500), sources: ["../a.ts"], version: 3 }));

        await expect(scan("out/index.js", "export const a = 1;", { limits: { maxMapBytes: 100 } })).rejects.toThrow(/sourcemap is .* over the/u);
    });

    it("stops mid-walk once the time budget runs out", async () => {
        expect.assertions(2);

        // Thousands of nodes, so the deadline is checked inside a walk. The
        // clock reads 0 for the deadline and the up-front checks, then jumps
        // past the budget: only a check made DURING a walk can see that.
        const code = Array.from({ length: 3000 }, (_, index) => `export const v${String(index)} = ${String(index)} + 1;`).join("\n");
        let reading = 0;

        await write("out/index.js", code);

        await expect(
            scan("out/index.js", code, {
                now: () => {
                    reading += 1;

                    return reading <= 3 ? 0 : 60_000;
                },
            }),
        ).rejects.toThrow(/^the scan ran past 10 s$/u);
        expect(reading).toBeGreaterThan(3);
    });

    it("reports a scan failure's own reason, and generalises anything else", () => {
        expect.assertions(3);

        const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

        expect(scanFailure(new Error("ENOENT: /workspace/build-abc/secret"))).toBe("the scanner failed unexpectedly; the platform operator has the details");
        // The operator's copy goes to the container's own stderr — checked before restoring the spy.
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining("ENOENT"));

        stderr.mockRestore();

        expect(() => decodeMappings("A!", new Set([1]), () => {})).toThrow(/malformed mappings/u);
    });

    it("decodes the mappings it keeps and only those", () => {
        expect.assertions(1);

        const decoded = decodeMappings(encodeMappings([[0, 5], undefined, [1, 2]]), new Set([3]), () => {});

        expect([...decoded.entries()]).toStrictEqual([[3, [[0, 1, 1]]]]);
    });
});
