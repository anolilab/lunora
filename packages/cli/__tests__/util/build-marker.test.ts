import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sourceFingerprint } from "../../src/util/build-marker";

/** The same project tree in two directories, as CI's build and deploy checkouts would hold it. */
const populate = (root: string): void => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "server.ts"), "export default {};\n", "utf8");
    writeFileSync(join(root, "wrangler.jsonc"), '{ "name": "app" }\n', "utf8");
};

let roots: string[];

const tempRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), "lunora-fingerprint-"));

    roots.push(root);

    return root;
};

describe("sourceFingerprint", () => {
    beforeEach(() => {
        roots = [];
    });

    afterEach(() => {
        for (const root of roots) {
            rmSync(root, { force: true, recursive: true });
        }
    });

    it("is the same for the same content in two different directories", () => {
        expect.assertions(1);

        const first = tempRoot();
        const second = tempRoot();

        populate(first);
        populate(second);

        expect(sourceFingerprint(first)).toBe(sourceFingerprint(second));
    });

    it("is the same whether the tree is listed by git or by the no-git walk", () => {
        expect.assertions(1);

        const repo = tempRoot();
        const plain = tempRoot();

        populate(repo);
        populate(plain);
        // eslint-disable-next-line sonarjs/no-os-command-from-path -- `git` must resolve from PATH; fixed args, no shell
        execFileSync("git", ["init", "-q"], { cwd: repo });
        // eslint-disable-next-line sonarjs/no-os-command-from-path -- `git` must resolve from PATH; fixed args, no shell
        execFileSync("git", ["add", "."], { cwd: repo });

        expect(sourceFingerprint(repo)).toBe(sourceFingerprint(plain));
    });

    it("changes when a source's content changes", () => {
        expect.assertions(1);

        const root = tempRoot();

        populate(root);

        const before = sourceFingerprint(root);

        writeFileSync(join(root, "src", "server.ts"), "export default { changed: true };\n", "utf8");

        expect(sourceFingerprint(root)).not.toBe(before);
    });

    it("changes when a source is deleted", () => {
        expect.assertions(1);

        const root = tempRoot();

        populate(root);

        const before = sourceFingerprint(root);

        rmSync(join(root, "src", "server.ts"));

        expect(sourceFingerprint(root)).not.toBe(before);
    });

    it("ignores build output and dependency directories", () => {
        expect.assertions(1);

        const root = tempRoot();

        populate(root);

        const before = sourceFingerprint(root);

        mkdirSync(join(root, "dist"), { recursive: true });
        writeFileSync(join(root, "dist", "index.js"), "built\n", "utf8");
        mkdirSync(join(root, ".lunora"), { recursive: true });
        writeFileSync(join(root, ".lunora", "build-marker.json"), "{}\n", "utf8");

        expect(sourceFingerprint(root)).toBe(before);
    });

    it("ignores the extra paths a build wrote, such as a custom --out-dir", () => {
        expect.assertions(1);

        const root = tempRoot();

        populate(root);

        const before = sourceFingerprint(root, ["dist-worker"]);

        mkdirSync(join(root, "dist-worker"), { recursive: true });
        writeFileSync(join(root, "dist-worker", "index.js"), "built\n", "utf8");

        expect(sourceFingerprint(root, ["dist-worker"])).toBe(before);
    });
});
