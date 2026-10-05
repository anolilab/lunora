import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The build box's release reader (`containers/build/release.mjs`): what it keeps
 * from the body `lunora cloud deploy --out` wrote, and the caps it holds that
 * body to, so an oversized project fails its build instead of its release.
 */

interface Limits {
    maxAssetFiles: number;
    maxAssetsBytes: number;
    maxBodyBytes: number;
}

interface ReleaseModule {
    DEFAULT_LIMITS: Limits;
    readRelease: (path: string, limits?: Limits) => Promise<Record<string, unknown>>;
    releaseFailure: (code: number, lines: ReadonlyArray<string>) => string;
}

// Loaded by URL: plain `.mjs` shipped into the image, with no declaration file.
const { DEFAULT_LIMITS, readRelease, releaseFailure } = (await import(new URL("../containers/build/release.mjs", import.meta.url).href)) as ReleaseModule;

let sandbox: string;

const written = async (body: unknown): Promise<string> => {
    const path = join(sandbox, "release.json");

    await writeFile(path, typeof body === "string" ? body : JSON.stringify(body));

    return path;
};

const MANIFEST = { bindings: [{ binding: "SHARD", className: "ShardDO", type: "durable_object" }] };

describe("build box release reader", () => {
    beforeEach(async () => {
        sandbox = await mkdtemp(join(tmpdir(), "build-release-"));
    });

    afterEach(async () => {
        await rm(sandbox, { force: true, recursive: true });
    });

    it("matches the control plane's caps", () => {
        expect.assertions(1);

        expect(DEFAULT_LIMITS).toStrictEqual({ maxAssetFiles: 20_000, maxAssetsBytes: 50 * 1024 * 1024, maxBodyBytes: 100 * 1024 * 1024 });
    });

    it("keeps the Worker's description and drops the routing a tenant must not steer", async () => {
        expect.assertions(1);

        const path = await written({
            assets: { files: [{ content: "aGk=", path: "/index.html" }] },
            branch: "main",
            bundle: "YnVuZGxl",
            cronSpecs: ["0 0 * * *"],
            kind: "production",
            manifest: MANIFEST,
            projectId: "prj_someone_else",
            scriptName: "app",
        });

        await expect(readRelease(path)).resolves.toStrictEqual({
            assets: { files: [{ content: "aGk=", path: "/index.html" }] },
            cronSpecs: ["0 0 * * *"],
            manifest: MANIFEST,
            scriptName: "app",
        });
    });

    it("omits what the body did not carry", async () => {
        expect.assertions(1);

        await expect(readRelease(await written({ bundle: "YnVuZGxl", manifest: MANIFEST }))).resolves.toStrictEqual({ manifest: MANIFEST });
    });

    it("refuses a body with no binding manifest", async () => {
        expect.assertions(1);

        await expect(readRelease(await written({ bundle: "YnVuZGxl" }))).rejects.toThrow(/no binding manifest/u);
    });

    it("refuses a file that is not JSON", async () => {
        expect.assertions(1);

        await expect(readRelease(await written("{not json"))).rejects.toThrow(/not JSON/u);
    });

    it("fails the build when the whole release is over the body cap", async () => {
        expect.assertions(1);

        const path = await written({ bundle: "A".repeat(4096), manifest: MANIFEST });

        await expect(readRelease(path, { ...DEFAULT_LIMITS, maxBodyBytes: 1024 })).rejects.toThrow(/accepts at most/u);
    });

    it("fails the build when there are too many asset files", async () => {
        expect.assertions(1);

        const files = Array.from({ length: 3 }, (_, index) => {
            return { content: "aGk=", path: `/${String(index)}.txt` };
        });
        const path = await written({ assets: { files }, bundle: "YnVuZGxl", manifest: MANIFEST });

        await expect(readRelease(path, { ...DEFAULT_LIMITS, maxAssetFiles: 2 })).rejects.toThrow(/has 3 static assets; Lunora Cloud deploys at most 2 files/u);
    });

    it("fails the build when the assets are over the size cap", async () => {
        expect.assertions(1);

        // 4 base64 chars decode to 3 bytes: 3 files × 3 bytes = 9 bytes, over an 8-byte cap.
        const files = Array.from({ length: 3 }, (_, index) => {
            return { content: "aGk/", path: `/${String(index)}.txt` };
        });
        const path = await written({ assets: { files }, bundle: "YnVuZGxl", manifest: MANIFEST });

        await expect(readRelease(path, { ...DEFAULT_LIMITS, maxAssetsBytes: 8 })).rejects.toThrow(/static assets total/u);
    });
});

describe("a failed `lunora cloud deploy --out`", () => {
    it.each([
        ["no project", "ERROR cloud deploy requires a project. Usage: lunora cloud deploy --project <id> --bundle <path>"],
        ["no API URL", "\u001B[31mcloud: no API URL — pass --url or set LUNORA_CLOUD_URL\u001B[39m"],
        ["no deploy key", "cloud: no deploy key — set LUNORA_DEPLOY_KEY (never passed as a flag)"],
    ])("names the upgrade when the project's CLI predates --out (it refused for %s)", (_reason, line) => {
        expect(releaseFailure(1, ["reading wrangler.jsonc", line])).toBe(
            "this project's @lunora/cli predates `lunora cloud deploy --out`, which deploying from git needs: upgrade @lunora/cli (or lunorash) to the next @lunora/cli release or later, then push again",
        );
    });

    it("reports any other failure by its exit code", () => {
        expect(releaseFailure(2, ["cloud deploy: wrangler `assets` has no `directory` — set it to your build output"])).toBe(
            "lunora cloud deploy --out failed with exit code 2",
        );
    });
});
