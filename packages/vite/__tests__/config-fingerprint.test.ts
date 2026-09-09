import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeConfigFingerprint, fingerprintJsonc, stripCodegenOwnedCrons } from "../src/config-fingerprint";

describe("config-fingerprint", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-vite-fingerprint-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("stripCodegenOwnedCrons", () => {
        it("drops an emptied triggers object so first-cron equals no-triggers", () => {
            expect.assertions(2);

            // A wrangler carrying ONLY codegen-owned crons must normalize to the
            // same shape as one with no triggers at all — otherwise adding the very
            // first cron would read as external drift.
            const withCrons = stripCodegenOwnedCrons({ name: "app", triggers: { crons: ["0 9 * * *"] } });
            const withoutTriggers = stripCodegenOwnedCrons({ name: "app" });

            expect(withCrons).toStrictEqual({ name: "app" });
            expect(JSON.stringify(withCrons)).toBe(JSON.stringify(withoutTriggers));
        });

        it("preserves user-authored triggers.* keys while stripping crons", () => {
            expect.assertions(1);

            const stripped = stripCodegenOwnedCrons({
                name: "app",
                // A hypothetical non-cron trigger key the user authored.
                triggers: { crons: ["0 9 * * *"], custom: true },
            });

            expect(stripped).toStrictEqual({ name: "app", triggers: { custom: true } });
        });

        it("leaves a config without triggers untouched", () => {
            expect.assertions(1);

            expect(stripCodegenOwnedCrons({ d1_databases: [{ binding: "DB" }], name: "app" })).toStrictEqual({
                d1_databases: [{ binding: "DB" }],
                name: "app",
            });
        });
    });

    describe("fingerprintJsonc", () => {
        it("ignores comment/whitespace-only edits (parses before stringifying)", () => {
            expect.assertions(1);

            const path = join(workdir, "wrangler.jsonc");

            writeFileSync(path, '{ "name": "app" }\n', "utf8");
            const first = fingerprintJsonc(path);

            writeFileSync(path, '{\n    // a comment\n    "name": "app"\n}\n', "utf8");
            const second = fingerprintJsonc(path);

            expect(second).toBe(first);
        });
    });

    describe("computeConfigFingerprint", () => {
        it("joins the config parts with a NUL and marks absent files", () => {
            expect.assertions(2);

            // The separator is a NUL. Derived via `String.fromCodePoint(0)` rather
            // than a literal so this test source stays plain text (an embedded NUL
            // makes the file read as binary to grep/gitleaks).
            const nul = String.fromCodePoint(0);
            const fingerprint = computeConfigFingerprint(workdir, "lunora");

            // Nothing in a fresh dir -> every part absent.
            expect(fingerprint).toContain(nul);
            expect(fingerprint).toBe(`absent${nul}absent${nul}absent`);
        });

        it("moves when lunora/app.ts changes, so the watcher is not inert", () => {
            expect.assertions(2);

            // The dev watcher watches this file, but `onConfigChange` returns early
            // when the fingerprint has not moved — so watching it without
            // fingerprinting it did nothing at all.
            mkdirSync(join(workdir, "lunora"), { recursive: true });

            const appConfigPath = join(workdir, "lunora", "app.ts");
            const absent = computeConfigFingerprint(workdir, "lunora");

            writeFileSync(appConfigPath, "export const configureApp = (app) => app;\n", "utf8");

            const present = computeConfigFingerprint(workdir, "lunora");

            expect(present).not.toBe(absent);

            writeFileSync(appConfigPath, "export const configureApp = (app) => app.global({ d1: (env) => env.DB });\n", "utf8");

            expect(computeConfigFingerprint(workdir, "lunora")).not.toBe(present);
        });

        it("adding the first cron does not change the fingerprint (anti-loop)", () => {
            expect.assertions(1);

            const wranglerPath = join(workdir, "wrangler.jsonc");

            writeFileSync(wranglerPath, '{ "name": "app", "d1_databases": [{ "binding": "DB" }] }\n', "utf8");
            const before = computeConfigFingerprint(workdir, "lunora");

            // Codegen adds triggers.crons — must be excluded from the fingerprint.
            writeFileSync(wranglerPath, '{ "name": "app", "d1_databases": [{ "binding": "DB" }], "triggers": { "crons": ["0 9 * * *"] } }\n', "utf8");
            const after = computeConfigFingerprint(workdir, "lunora");

            expect(after).toBe(before);
        });

        it("a real binding edit changes the fingerprint", () => {
            expect.assertions(1);

            const wranglerPath = join(workdir, "wrangler.jsonc");

            writeFileSync(wranglerPath, '{ "name": "app" }\n', "utf8");
            const before = computeConfigFingerprint(workdir, "lunora");

            writeFileSync(wranglerPath, '{ "name": "app", "kv_namespaces": [{ "binding": "KV" }] }\n', "utf8");
            const after = computeConfigFingerprint(workdir, "lunora");

            expect(after).not.toBe(before);
        });
    });
});
