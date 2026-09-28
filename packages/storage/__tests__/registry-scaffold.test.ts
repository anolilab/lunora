import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { transformSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

import { buildSignedUrl, verifySignedUrl } from "../src/signed-url";

/**
 * The `storage` registry item's scaffolded config, exercised against the signer
 * it configures.
 *
 * `lunora registry add storage` writes `STORAGE_PUBLIC_BASE_URL` into `.dev.vars`
 * and the copied module hands it straight to `createStorage`. Nothing else in the
 * repo runs that value through `buildSignedUrl`, which is how it shipped carrying
 * a path (`http://localhost:8787/storage`) that the signer rejects outright — so
 * `generateUploadUrl` / `getDownloadUrl` threw on the first call of a fresh
 * install and the item's documented round-trip could not pass.
 */

const here = dirname(fileURLToPath(import.meta.url));
// __tests__ → packages/storage → packages → repo root → registry/storage
const registryDirectory = resolve(here, "..", "..", "..", "registry", "storage");
const manifestPath = join(registryDirectory, "registry.json");
const itemPath = join(registryDirectory, "storage.ts");
const scratch = mkdtempSync(join(tmpdir(), "lunora-storage-item-"));

/**
 * `requireEnv` as the shipped item defines it, compiled and imported as a real
 * module. `env` (from `cloudflare:workers`) is its only free binding, so the
 * wrapper takes it as a parameter.
 *
 * Lifting the item's own expression rather than re-typing it is the point: a
 * copy here would keep passing after the item dropped the length floor, which is
 * the state it shipped in.
 */
const itemRequireEnv = async (env: Record<string, unknown>): Promise<(name: string, minLength?: number) => string> => {
    const source = readFileSync(itemPath, "utf8");
    const start = source.indexOf("const requireEnv = ");

    if (start === -1) {
        throw new Error("could not locate `requireEnv` in registry/storage/storage.ts");
    }

    const end = source.indexOf("\n};", start);
    const expression = source.slice(start + "const requireEnv = ".length, end + "\n}".length);
    const compiled = transformSync(`export const build = (env) => (${expression});`, { loader: "ts" }).code;
    const file = join(scratch, `require-env-${randomUUID()}.mjs`);

    writeFileSync(file, compiled);

    const loaded = (await import(pathToFileURL(file).href)) as { build: (env: Record<string, unknown>) => (name: string, minLength?: number) => string };

    return loaded.build(env);
};

const scaffoldedBaseUrlEntry = ((): { secret?: boolean; value?: string } => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { envVars: { name: string; secret?: boolean; value?: string }[] };
    const entry = manifest.envVars.find((variable) => variable.name === "STORAGE_PUBLIC_BASE_URL");

    if (entry === undefined) {
        throw new Error("registry/storage/registry.json no longer scaffolds STORAGE_PUBLIC_BASE_URL");
    }

    return entry;
})();

/** An app origin as a developer would set it — the Vite dev server here. */
const appOrigin = "http://localhost:5173";

/** The shape the item's `requireOwner` produces: `storage/<userId>/<key>`. */
const scaffoldedKey = "storage/u_42/avatar.png";

describe("storage registry item scaffold", () => {
    afterAll(() => {
        rmSync(scratch, { force: true, recursive: true });
    });

    it("rejects a signing secret below the documented 32-character floor", async () => {
        expect.assertions(2);

        const requireEnv = await itemRequireEnv({ STORAGE_SIGNING_SECRET: "s".repeat(31) });

        // HMAC signs happily with a one-character key, so "min 32 chars" is only
        // advice unless the item enforces it where it reads the secret.
        expect(() => requireEnv("STORAGE_SIGNING_SECRET", 32)).toThrow(/at least 32/u);

        const ok = await itemRequireEnv({ STORAGE_SIGNING_SECRET: "s".repeat(32) });

        expect(ok("STORAGE_SIGNING_SECRET", 32)).toBe("s".repeat(32));
    });

    it("scaffolds the public base URL empty, so an unset one fails loudly instead of signing for a port nothing serves", async () => {
        expect.assertions(3);

        // The host and port are part of the signed canonical, so a guessed dev
        // origin (`:8787` while Vite serves `:5173`) mints URLs that 404 and cannot
        // be fixed by rewriting the port. Only the developer knows the origin.
        expect(scaffoldedBaseUrlEntry.value ?? "").toBe("");
        expect(scaffoldedBaseUrlEntry.secret).toBe(false);

        const requireEnv = await itemRequireEnv({ STORAGE_PUBLIC_BASE_URL: "" });

        expect(() => requireEnv("STORAGE_PUBLIC_BASE_URL")).toThrow(/missing env var `STORAGE_PUBLIC_BASE_URL`/u);
    });

    it("mints and verifies a signed URL from a bare app origin", async () => {
        expect.assertions(3);

        const url = await buildSignedUrl({
            baseUrl: appOrigin,
            bucketName: "default",
            contentType: "image/png",
            key: scaffoldedKey,
            method: "PUT",
            secret: "s".repeat(32),
        });

        const verdict = await verifySignedUrl(url, "s".repeat(32));

        expect(verdict.valid).toBe(true);
        expect(verdict.key).toBe(scaffoldedKey);

        // The item's README and skill both document a `/storage/*` Worker route.
        // The key is verified from the WHOLE pathname, so the prefix has to come
        // from the key rather than from a base path the signer refuses.
        expect(new URL(url).pathname.startsWith("/storage/")).toBe(true);
    });
});
