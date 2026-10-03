import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The build box's path logic (`containers/build/workspace.mjs`): where in a
 * tenant's extracted repo it installs and builds. The repo is attacker-shaped
 * — any directory can be a symlink to anywhere — so containment is proven on
 * real paths, and the workspace-root walk must never leave the repo.
 */

interface WorkspaceModule {
    findWorkspaceRoot: (project: string, repo: string) => Promise<{ directory: string; manager: { command: string } }>;
    resolveLunoraBin: (project: string, workspaceRoot: string) => Promise<string>;
    resolveProjectDirectory: (repo: string, rootDirectory: string) => Promise<{ project: string; repo: string }>;
    validateRootDirectory: (value: string) => string;
}

// Loaded by URL: the module is plain `.mjs` shipped into the image, with no
// declaration file for the type checker to resolve.
const { findWorkspaceRoot, resolveLunoraBin, resolveProjectDirectory, validateRootDirectory } = (await import(
    new URL("../containers/build/workspace.mjs", import.meta.url).href
)) as WorkspaceModule;

let sandbox: string;
let repo: string;

/** Write `files` (path → content) under the repo, creating directories as needed. */
const layout = async (files: Record<string, string>): Promise<void> => {
    for (const [path, content] of Object.entries(files)) {
        const full = join(repo, path);

        // eslint-disable-next-line no-await-in-loop -- tiny fixture, order does not matter
        await mkdir(join(full, ".."), { recursive: true });
        // eslint-disable-next-line no-await-in-loop -- see above
        await writeFile(full, content);
    }
};

describe("build box workspace", () => {
    beforeEach(async () => {
        sandbox = await realpath(await mkdtemp(join(tmpdir(), "build-workspace-")));
        repo = join(sandbox, "repo");
        await mkdir(repo);
    });

    afterEach(async () => {
        await rm(sandbox, { force: true, recursive: true });
    });

    describe("validateRootDirectory", () => {
        it.each(["..", "../x", "apps/../..", "/etc", String.raw`apps\web`, "apps//web", "apps/\u0000"])("refuses %j", (value) => {
            expect(() => validateRootDirectory(value)).toThrow(/refused/u);
        });

        it("passes the repository root and a normalized path through", () => {
            expect(validateRootDirectory("")).toBe("");
            expect(validateRootDirectory("apps/web")).toBe("apps/web");
        });
    });

    describe("resolveProjectDirectory", () => {
        it("resolves an existing directory inside the repo", async () => {
            await layout({ "apps/web/package.json": "{}" });

            await expect(resolveProjectDirectory(repo, "apps/web")).resolves.toStrictEqual({ project: join(repo, "apps/web"), repo });
        });

        it("refuses a directory that is not in the tarball", async () => {
            await expect(resolveProjectDirectory(repo, "apps/missing")).rejects.toThrow(
                'root directory "apps/missing" does not exist in the repository at this commit',
            );
        });

        it("refuses a file", async () => {
            await layout({ "apps/web": "not a directory" });

            await expect(resolveProjectDirectory(repo, "apps/web")).rejects.toThrow(/is not a directory/u);
        });

        it("refuses a symlink that escapes the repo", async () => {
            await mkdir(join(sandbox, "outside"));
            await mkdir(join(repo, "apps"));
            await symlink(join(sandbox, "outside"), join(repo, "apps/web"));

            await expect(resolveProjectDirectory(repo, "apps/web")).rejects.toThrow(/resolves outside the repository/u);
        });

        it("refuses a sibling that merely shares the repo's name as a prefix", async () => {
            await mkdir(join(sandbox, "repo-evil"));
            await symlink(join(sandbox, "repo-evil"), join(repo, "web"));

            await expect(resolveProjectDirectory(repo, "web")).rejects.toThrow(/resolves outside the repository/u);
        });

        it("allows a symlink that stays inside the repo", async () => {
            await layout({ "packages/web/package.json": "{}" });
            await mkdir(join(repo, "apps"));
            await symlink(join(repo, "packages/web"), join(repo, "apps/web"));

            await expect(resolveProjectDirectory(repo, "apps/web")).resolves.toMatchObject({ project: join(repo, "packages/web") });
        });

        it("refuses traversal before touching the filesystem", async () => {
            await expect(resolveProjectDirectory(repo, "../")).rejects.toThrow(/refused/u);
        });
    });

    describe("findWorkspaceRoot", () => {
        it.each([
            ["pnpm", { "apps/web/package.json": "{}", "pnpm-lock.yaml": "", "pnpm-workspace.yaml": "packages: [apps/*]" }],
            ["npm", { "apps/web/package.json": "{}", "package-lock.json": "{}", "package.json": '{"workspaces":["apps/*"]}' }],
            ["yarn", { "apps/web/package.json": "{}", "package.json": '{"workspaces":["apps/*"]}', "yarn.lock": "" }],
        ])("finds a %s workspace's lockfile at the repo root", async (command, files) => {
            await layout(files);

            await expect(findWorkspaceRoot(join(repo, "apps/web"), repo)).resolves.toMatchObject({ directory: repo, manager: { command } });
        });

        it("prefers the nearest lockfile — a standalone app inside a larger repo", async () => {
            await layout({ "apps/web/package-lock.json": "{}", "pnpm-lock.yaml": "" });

            await expect(findWorkspaceRoot(join(repo, "apps/web"), repo)).resolves.toMatchObject({
                directory: join(repo, "apps/web"),
                manager: { command: "npm" },
            });
        });

        it("never walks above the repo", async () => {
            // A lockfile in the box's own directory above the extracted repo must not be picked up.
            await writeFile(join(sandbox, "pnpm-lock.yaml"), "");
            await layout({ "apps/web/package.json": "{}" });

            await expect(findWorkspaceRoot(join(repo, "apps/web"), repo)).rejects.toThrow(/no lockfile found/u);
        });
    });

    describe("resolveLunoraBin", () => {
        it("takes the app's own binary first, then the hoisted one", async () => {
            await layout({ "node_modules/.bin/lunora": "", "apps/web/package.json": "{}" });

            await expect(resolveLunoraBin(join(repo, "apps/web"), repo)).resolves.toBe(join(repo, "node_modules/.bin/lunora"));

            await layout({ "apps/web/node_modules/.bin/lunora": "" });

            await expect(resolveLunoraBin(join(repo, "apps/web"), repo)).resolves.toBe(join(repo, "apps/web/node_modules/.bin/lunora"));
        });

        it("says what is missing when neither exists", async () => {
            await layout({ "apps/web/package.json": "{}" });

            await expect(resolveLunoraBin(join(repo, "apps/web"), repo)).rejects.toThrow(/node_modules\/\.bin\/lunora is missing/u);
        });
    });
});
