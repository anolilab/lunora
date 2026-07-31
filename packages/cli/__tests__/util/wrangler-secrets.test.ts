import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listRemoteSecrets, parseSecretNames } from "../../src/util/wrangler-secrets";

describe("parseSecretNames", () => {
    it("parses a valid `wrangler secret list --format json` payload into sorted names", () => {
        expect.assertions(1);

        const stdout = JSON.stringify([
            { name: "STRIPE_KEY", type: "secret_text" },
            { name: "AUTH_SECRET", type: "secret_text" },
        ]);

        expect(parseSecretNames(stdout)).toStrictEqual(["AUTH_SECRET", "STRIPE_KEY"]);
    });

    it("returns undefined for malformed JSON", () => {
        expect.assertions(1);

        expect(parseSecretNames("not json")).toBeUndefined();
    });

    it("returns undefined when the payload is not an array", () => {
        expect.assertions(1);

        expect(parseSecretNames(JSON.stringify({ name: "AUTH_SECRET" }))).toBeUndefined();
    });

    it("returns undefined for null input JSON", () => {
        expect.assertions(1);

        expect(parseSecretNames("null")).toBeUndefined();
    });

    it("filters out entries with a missing or non-string name", () => {
        expect.assertions(1);

        const stdout = JSON.stringify([{ name: "AUTH_SECRET" }, { type: "secret_text" }, { name: 42 }, { name: "" }, null]);

        expect(parseSecretNames(stdout)).toStrictEqual(["AUTH_SECRET"]);
    });

    it("returns an empty array (not undefined) for an empty array payload", () => {
        expect.assertions(1);

        expect(parseSecretNames("[]")).toStrictEqual([]);
    });
});

describe("listRemoteSecrets", () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-wrangler-secrets-"));
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("reports failure when the injected runner exits non-zero", async () => {
        expect.assertions(3);

        const result = await listRemoteSecrets({
            cwd: workdir,
            runner: () => Promise.resolve({ code: 1, stderr: "not authenticated", stdout: "" }),
        });

        expect(result.ok).toBe(false);
        expect(result.names).toStrictEqual([]);
        expect(result.error).toBe("not authenticated");
    });

    it("falls back to a generic error when a non-zero exit has no stderr", async () => {
        expect.assertions(1);

        const result = await listRemoteSecrets({
            cwd: workdir,
            runner: () => Promise.resolve({ code: 3, stderr: "", stdout: "" }),
        });

        expect(result.error).toBe("wrangler secret list exited 3");
    });

    it("reports failure when the runner's stdout can't be parsed as the expected JSON shape", async () => {
        expect.assertions(3);

        const result = await listRemoteSecrets({
            cwd: workdir,
            runner: () => Promise.resolve({ code: 0, stderr: "", stdout: "not json" }),
        });

        expect(result.ok).toBe(false);
        expect(result.names).toStrictEqual([]);
        expect(result.error).toBe("could not parse `wrangler secret list --format json` output");
    });

    it("returns sorted names on success", async () => {
        expect.assertions(2);

        const result = await listRemoteSecrets({
            cwd: workdir,
            runner: () => Promise.resolve({ code: 0, stderr: "", stdout: JSON.stringify([{ name: "B" }, { name: "A" }]) }),
        });

        expect(result.ok).toBe(true);
        expect(result.names).toStrictEqual(["A", "B"]);
    });

    it("passes the resolved command through to the runner (env + package-manager aware)", async () => {
        expect.assertions(1);

        let seenArgs: ReadonlyArray<string> | undefined;

        await listRemoteSecrets({
            cwd: workdir,
            env: "staging",
            runner: (_command, args) => {
                seenArgs = args;

                return Promise.resolve({ code: 0, stderr: "", stdout: "[]" });
            },
        });

        expect(seenArgs?.join(" ")).toContain("--env staging");
    });
});
