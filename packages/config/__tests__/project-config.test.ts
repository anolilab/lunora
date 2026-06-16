import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { interpretRemote, LUNORA_CONFIG_FILE, readProjectRemotePreference } from "../src/project-config";

describe("interpretRemote", () => {
    it("passes a boolean through unchanged", () => {
        expect.assertions(2);

        expect(interpretRemote(true)).toBe(true);
        expect(interpretRemote(false)).toBe(false);
    });

    it("treats the (reserved) object form as enabled", () => {
        expect.assertions(1);

        // The scoping object form isn't honored yet, but its presence still opts in.
        expect(interpretRemote({ kinds: ["d1"] })).toBe(true);
    });

    it("treats null and non-object scalars as no preference", () => {
        expect.assertions(4);

        expect(interpretRemote(null)).toBeUndefined();
        expect(interpretRemote(undefined)).toBeUndefined();
        expect(interpretRemote("true")).toBeUndefined();
        expect(interpretRemote(1)).toBeUndefined();
    });
});

describe("readProjectRemotePreference", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-project-config-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    it("returns undefined when lunora.json is absent", () => {
        expect.assertions(1);

        expect(readProjectRemotePreference(root)).toBeUndefined();
    });

    it("reads `remote: true`", () => {
        expect.assertions(1);

        writeFileSync(join(root, LUNORA_CONFIG_FILE), `{ "remote": true }`, "utf8");

        expect(readProjectRemotePreference(root)).toBe(true);
    });

    it("reads `remote: false`", () => {
        expect.assertions(1);

        writeFileSync(join(root, LUNORA_CONFIG_FILE), `{ "remote": false }`, "utf8");

        expect(readProjectRemotePreference(root)).toBe(false);
    });

    it("tolerates JSONC comments + trailing commas", () => {
        expect.assertions(1);

        writeFileSync(join(root, LUNORA_CONFIG_FILE), `{\n  // project default\n  "remote": true,\n}`, "utf8");

        expect(readProjectRemotePreference(root)).toBe(true);
    });

    it("returns undefined for malformed JSONC rather than throwing", () => {
        expect.assertions(1);

        writeFileSync(join(root, LUNORA_CONFIG_FILE), `{ not valid `, "utf8");

        expect(readProjectRemotePreference(root)).toBeUndefined();
    });

    it("returns undefined when the file has no remote key", () => {
        expect.assertions(1);

        writeFileSync(join(root, LUNORA_CONFIG_FILE), `{ "name": "app" }`, "utf8");

        expect(readProjectRemotePreference(root)).toBeUndefined();
    });
});
