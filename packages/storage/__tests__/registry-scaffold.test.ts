import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build, transformSync } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

import { buildSignedUrl, verifySignedUrl } from "../src/signed-url";

/**
 * The `storage` registry item's scaffolded config, exercised against the signer
 * it configures.
 *
 * `lunora registry add storage` writes an empty `STORAGE_PUBLIC_BASE_URL` into
 * `.dev.vars`, and the copied module signs against the request origin
 * (`ctx.origin`) unless that override is set. Nothing else in the repo runs the
 * item's base through `buildSignedUrl`, which is how it once shipped carrying a
 * path (`http://localhost:8787/storage`) that the signer rejects outright — so
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

/** The Worker env the bundled item reads through its `cloudflare:workers` stub. */
const itemEnv: Record<string, unknown> = {};

/** The handler shape the stub builders hand back: the item's own function. */
type ItemHandler = (invocation: { args: Record<string, unknown>; ctx: Record<string, unknown> }) => Promise<{ key: string; url: string }>;

/** The two URL-minting handlers the item exports. */
interface ItemHandlers {
    generateUploadUrl: ItemHandler;
    getDownloadUrl: ItemHandler;
}

/**
 * The shipped item, bundled and imported as a real module, so its handlers run
 * against the real signer in `../src` instead of a copy of their logic.
 *
 * Its imports that only exist in a user's project are stubbed: the Workers
 * `env` (backed by {@link itemEnv}), the generated builders (identity, so
 * `action.input(…).use(…).action(handler)` is `handler`), and the rate limiter
 * (middleware the stub builders never run).
 */
const loadItem = async (): Promise<ItemHandlers> => {
    const stubs: Record<string, string> = {
        "#lunora/_generated/server.js": [
            "const builder = () => ({ action: (h) => h, input: () => builder(), mutation: (h) => h, query: (h) => h, use: () => builder() });",
            "const validator = () => { const self = { max: () => self }; return self; };",
            "export const action = builder(); export const mutation = builder(); export const query = builder();",
            "export const v = { number: validator, optional: validator, string: validator };",
        ].join("\n"),
        "@lunora/ratelimit": "export class RateLimiter {} export const createMemoryStore = () => ({}); export const rateLimit = () => ({});",
        "cloudflare:workers": "export const env = globalThis.lunoraStorageItemEnv;",
    };

    // Aliased to files rather than resolved by a plugin: an esbuild plugin
    // filter is a Go regular expression, which rejects the `u` flag.
    const alias: Record<string, string> = {};

    for (const [specifier, contents] of Object.entries(stubs)) {
        const file = join(scratch, `stub-${randomUUID()}.mjs`);

        writeFileSync(file, contents);
        alias[specifier] = file;
    }

    alias["@lunora/storage"] = resolve(here, "..", "src", "index.ts");

    // `nodePaths`: the item lives outside any package, so its real imports
    // (`@lunora/errors`) resolve through this package's dependencies.
    const result = await build({
        alias,
        bundle: true,
        entryPoints: [itemPath],
        format: "esm",
        nodePaths: [resolve(here, "..", "node_modules")],
        platform: "node",
        write: false,
    });

    (globalThis as { lunoraStorageItemEnv?: Record<string, unknown> }).lunoraStorageItemEnv = itemEnv;

    const file = join(scratch, `item-${randomUUID()}.mjs`);

    writeFileSync(file, result.outputFiles[0]?.text ?? "");

    return (await import(pathToFileURL(file).href)) as ItemHandlers;
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

    it("scaffolds the public base URL empty, so the request origin is used rather than a guessed port", () => {
        expect.assertions(2);

        // The host and port are part of the signed canonical, so a guessed dev
        // origin (`:8787` while Vite serves `:5173`) mints URLs that 404 and cannot
        // be fixed by rewriting the port. The request origin is never a guess.
        expect(scaffoldedBaseUrlEntry.value ?? "").toBe("");
        expect(scaffoldedBaseUrlEntry.secret).toBe(false);
    });

    describe("signing base", () => {
        const secret = "s".repeat(32);
        const owner = { userId: "u_42" };

        const resetEnv = (overrides: Record<string, unknown>): void => {
            Object.assign(itemEnv, { STORAGE_PUBLIC_BASE_URL: "", STORAGE_SIGNING_SECRET: secret, UPLOADS: {} }, overrides);
        };

        it("signs an action's upload URL against the request origin when no base URL is set", async () => {
            expect.assertions(3);

            resetEnv({});
            const { generateUploadUrl } = await loadItem();

            const minted = await generateUploadUrl({ args: { contentType: "image/png", key: "avatar.png" }, ctx: { auth: owner, origin: appOrigin } });

            expect(new URL(minted.url).origin).toBe(appOrigin);

            const verdict = await verifySignedUrl(minted.url, secret);

            expect(verdict.valid).toBe(true);
            expect(verdict.key).toBe(scaffoldedKey);
        });

        it("lets STORAGE_PUBLIC_BASE_URL override the request origin", async () => {
            expect.assertions(1);

            resetEnv({ STORAGE_PUBLIC_BASE_URL: "https://files.example.com" });
            const { getDownloadUrl } = await loadItem();

            const minted = await getDownloadUrl({ args: { key: "avatar.png" }, ctx: { auth: owner, origin: appOrigin } });

            expect(new URL(minted.url).origin).toBe("https://files.example.com");
        });

        // A query ctx carries no `origin` (a live query re-runs with no request
        // behind it), and neither does a scheduled run. Signing there must say
        // what to configure rather than fail inside the signer.
        it("fails loudly without a base URL where no request origin exists, such as a query", async () => {
            expect.assertions(1);

            resetEnv({});
            const { getDownloadUrl } = await loadItem();

            await expect(getDownloadUrl({ args: { key: "avatar.png" }, ctx: { auth: owner } })).rejects.toThrow(
                /no base URL to sign against[\s\S]*a query[\s\S]*STORAGE_PUBLIC_BASE_URL/u,
            );
        });
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
