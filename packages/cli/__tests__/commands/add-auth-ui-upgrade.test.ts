/**
 * The upgrade half of `lunora add auth-ui`: re-running it must be a no-op, an
 * untouched file must upgrade cleanly, and a file the user has edited must never
 * be clobbered — they get a `.new` sidecar instead.
 *
 * `registry-reconcile.test.ts` already covers the engine against a synthetic
 * one-file item. This runs the same paths through the **real** auth-ui payload
 * (40-odd files across nested directories), because that is what users actually
 * upgrade and what the item README promises. The registry is copied to a temp
 * dir first so "upstream" can be changed between adds.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAddFeature } from "../../src/commands/add/handler";
import type { Logger } from "../../src/util/logger";

const silentLogger = (): Logger => {
    const noop = (): void => {};

    return { error: noop, info: noop, success: noop, warn: noop };
};

const testDirectory = dirname(fileURLToPath(import.meta.url));
const sourceRegistry = resolve(testDirectory, "..", "..", "..", "..", "registry");

let registryRoot: string;
let workdir: string;

/** The copied file every assertion below pokes at — small, and pure core logic. */
const COPIED = ["lunora", "auth-ui", "core", "validators.ts"];
const UPSTREAM = ["auth-ui-react", "core", "validators.ts"];

const addAuthUi = async (): Promise<ReadonlyArray<string>> => {
    const result = await runAddFeature({
        confirm: async () => true,
        cwd: workdir,
        feature: "auth-ui",
        from: registryRoot,
        logger: silentLogger(),
        // Injected rather than interactive: a re-add must never block on stdin.
        promptSelect: async () => "auth-ui-react",
        promptText: async () => "demo-db",
    });

    return result.items;
};

const copied = (): string => join(workdir, ...COPIED);
const upstream = (): string => join(registryRoot, ...UPSTREAM);

describe("lunora add auth-ui — upgrades", () => {
    beforeEach(() => {
        registryRoot = mkdtempSync(join(tmpdir(), "lunora-authui-reg-"));
        cpSync(sourceRegistry, registryRoot, { recursive: true });

        workdir = mkdtempSync(join(tmpdir(), "lunora-authui-proj-"));
        writeFileSync(
            join(workdir, "package.json"),
            JSON.stringify({ dependencies: { "@lunora/react": "1.0.0-alpha.30" }, name: "demo" }, undefined, 4),
            "utf8",
        );
        writeFileSync(join(workdir, "wrangler.jsonc"), '{\n    "name": "demo"\n}\n', "utf8");
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "lunora", "schema.ts"), "export const schema = {};\n", "utf8");
    });

    afterEach(() => {
        rmSync(registryRoot, { force: true, recursive: true });
        rmSync(workdir, { force: true, recursive: true });
    });

    it("records a lock covering the copied payload", async () => {
        expect.assertions(2);

        await addAuthUi();

        const lock = readFileSync(join(workdir, "lunora", ".lunora-registry.json"), "utf8");

        expect(existsSync(copied())).toBe(true);
        expect(lock).toContain("auth-ui");
    });

    it("re-running with nothing changed leaves the files alone", async () => {
        expect.assertions(2);

        await addAuthUi();

        const before = readFileSync(copied(), "utf8");

        await addAuthUi();

        expect(readFileSync(copied(), "utf8")).toBe(before);
        expect(existsSync(`${copied()}.new`)).toBe(false);
    });

    it("upgrades a file the user has not edited", async () => {
        expect.assertions(2);

        await addAuthUi();
        writeFileSync(upstream(), `${readFileSync(upstream(), "utf8")}\n// upstream change\n`, "utf8");
        await addAuthUi();

        expect(readFileSync(copied(), "utf8")).toContain("// upstream change");
        expect(existsSync(`${copied()}.new`)).toBe(false);
    });

    it("never clobbers a file the user edited — it writes a .new sidecar", async () => {
        expect.assertions(3);

        await addAuthUi();
        writeFileSync(copied(), "// mine, hands off\n", "utf8");
        writeFileSync(upstream(), `${readFileSync(upstream(), "utf8")}\n// upstream change\n`, "utf8");
        await addAuthUi();

        // The user's edit survives untouched…
        expect(readFileSync(copied(), "utf8")).toBe("// mine, hands off\n");
        // …and the upstream version lands beside it for them to merge.
        expect(existsSync(`${copied()}.new`)).toBe(true);
        expect(readFileSync(`${copied()}.new`, "utf8")).toContain("// upstream change");
    });

    it("leaves an edited file alone when upstream has not moved", async () => {
        expect.assertions(2);

        await addAuthUi();
        writeFileSync(copied(), "// mine, hands off\n", "utf8");
        await addAuthUi();

        expect(readFileSync(copied(), "utf8")).toBe("// mine, hands off\n");
        expect(existsSync(`${copied()}.new`)).toBe(false);
    });
});
