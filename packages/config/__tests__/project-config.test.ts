import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { platformMatrixIds } from "@lunora/codegen";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_DEPLOY_TARGET, deployTargetIds, resolveDeployDriver } from "../src/driver-registry";
import { interpretRemote, LUNORA_CONFIG_FILE, readProjectRemotePreference, readProjectTarget, resolveProjectTarget } from "../src/project-config";

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

describe("deploy-target resolution", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "lunora-project-config-"));
    });

    afterEach(() => {
        rmSync(root, { force: true, recursive: true });
    });

    const writeConfig = (config: unknown): void => {
        writeFileSync(join(root, LUNORA_CONFIG_FILE), JSON.stringify(config), "utf8");
    };

    it("falls back to the registry default with no flag and no config", () => {
        expect.assertions(2);

        expect(readProjectTarget(root)).toBeUndefined();
        expect(resolveProjectTarget(root)).toBe(DEFAULT_DEPLOY_TARGET);
    });

    it("reads the target from lunora.json", () => {
        expect.assertions(2);

        writeConfig({ remote: true, target: "aws" });

        expect(readProjectTarget(root)).toBe("aws");
        expect(resolveProjectTarget(root)).toBe("aws");
    });

    it("lets an explicit target win over the config", () => {
        expect.assertions(1);

        writeConfig({ target: "aws" });

        // `--target` is the per-invocation override; a project that normally
        // ships to one provider must be able to build for another without
        // editing the committed config.
        expect(resolveProjectTarget(root, "cloudflare")).toBe("cloudflare");
    });

    it("ignores a non-string target", () => {
        expect.assertions(2);

        // A shape error is not a name the user meant, so it collapses to "no
        // preference" — unlike a misspelled string, which must reach the
        // registry and throw.
        writeConfig({ target: 42 });

        expect(readProjectTarget(root)).toBeUndefined();
        expect(resolveProjectTarget(root)).toBe(DEFAULT_DEPLOY_TARGET);
    });

    it("degrades to the default on a malformed config rather than throwing", () => {
        expect.assertions(1);

        writeFileSync(join(root, LUNORA_CONFIG_FILE), "{ not json", "utf8");

        expect(resolveProjectTarget(root)).toBe(DEFAULT_DEPLOY_TARGET);
    });

    it("carries a misspelled target through to a throwing driver lookup", () => {
        expect.assertions(2);

        writeConfig({ target: "clouflare" });

        // The whole point of the resolution order: a typo must NOT be swallowed
        // into the default. Quietly deploying to Cloudflare because the name
        // was unrecognized ships an app to the wrong provider.
        expect(resolveProjectTarget(root)).toBe("clouflare");
        expect(() => resolveDeployDriver(resolveProjectTarget(root))).toThrow(/unknown deploy target "clouflare"/);
    });
});

describe("target registries", () => {
    it("keeps the driver registry and codegen's capability matrices in agreement", () => {
        expect.assertions(1);

        // Two id spaces for one concept. A target with a driver but no matrix
        // passes `resolveTargetOrThrow` and then emits an un-gated surface —
        // reintroducing the silent fallback with the guard fully in place. One
        // with a matrix but no driver gates a surface nothing can deploy.
        // They agree today only because both hold exactly `cloudflare`; this is
        // what makes the next target's omission a failing test instead of a
        // production surprise.
        expect(deployTargetIds()).toStrictEqual(platformMatrixIds());
    });
});
