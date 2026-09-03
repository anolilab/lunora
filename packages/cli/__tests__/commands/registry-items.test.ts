/**
 * Coverage for the *real* shipped registry items under the repo's `registry/`
 * (ratelimit, presence, …) — distinct from `add.test.ts`, which exercises the
 * `add` command mechanics against minimal hermetic fixtures.
 *
 * Data-driven: every subdirectory of `registry/` that carries a `registry.json`
 * is discovered and run through the full `lunora add` flow into a throwaway
 * project. New registry items get this coverage automatically — no edit here.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseManifest, runAddCommand, runBuildIndexCommand } from "../../src/commands/registry/index";
import type { Logger } from "../../src/util/logger";

const silentLogger = (): Logger => {
    const noop = (): void => {};

    return { error: noop, info: noop, success: noop, warn: noop };
};

const testDirectory = dirname(fileURLToPath(import.meta.url));
// __tests__/commands → packages/cli → packages → repo root → registry
const registryRoot = resolve(testDirectory, "..", "..", "..", "..", "registry");

const BASE_SCHEMA = `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    messages: defineTable({ text: v.string() }),
});
`;

/** Every item directory under `registry/` that ships a manifest. */
const itemNames = readdirSync(registryRoot).filter((entry) => {
    const full = join(registryRoot, entry);

    return statSync(full).isDirectory() && existsSync(join(full, "registry.json"));
});

/** Every shipped item's parsed manifest — the source sweeps below all start here. */
const manifests = itemNames.map((name) => {
    return { manifest: parseManifest(JSON.parse(readFileSync(join(registryRoot, name, "registry.json"), "utf8")), name), name };
});

/** Every file an item ships, with its source — one flat list to sweep. */
const itemSources = manifests.flatMap(({ manifest, name }) =>
    manifest.files.map((file) => {
        return { from: file.from, name, source: readFileSync(join(registryRoot, name, file.from), "utf8") };
    }),
);

/**
 * Wrangler's own `config-schema.json` `required` lists, for the binding kinds
 * this registry scaffolds. A missing required field is not a warning: wrangler
 * refuses to load the config, so an item shipping one breaks validation for the
 * WHOLE Worker.
 */
const REQUIRED_BINDING_FIELDS: Record<string, ReadonlyArray<string>> = {
    ai: ["binding"],
    browser: ["binding"],
    d1_databases: ["binding"],
    hyperdrive: ["binding", "id"],
    r2_buckets: ["binding", "bucket_name"],
    send_email: ["name"],
};

/** Bindings whose scaffolded value omits something wrangler requires. */
const bindingsMissingRequiredFields = (): string[] => {
    const offenders: string[] = [];

    for (const { manifest, name } of manifests) {
        for (const binding of manifest.bindings ?? []) {
            const kind = binding.path[0] ?? "";
            const required = REQUIRED_BINDING_FIELDS[kind];

            if (required === undefined) {
                offenders.push(`${name}: unknown binding kind \`${kind}\` — add its wrangler-required fields to REQUIRED_BINDING_FIELDS`);

                continue;
            }

            const entries = (Array.isArray(binding.value) ? binding.value : [binding.value]) as Record<string, unknown>[];

            for (const entry of entries) {
                offenders.push(...required.filter((field) => entry[field] === undefined).map((field) => `${name}: ${kind} entry is missing \`${field}\``));
            }
        }
    }

    return offenders;
};

/**
 * UI frameworks an item deliberately does not declare: it is scaffolded INTO a
 * React/Vue/Solid app, so pinning that app's own framework would be wrong. A
 * package belongs here only when the consumer necessarily already has it.
 */
const CONSUMER_PROVIDED = new Set(["@angular/core", "react", "solid-js", "svelte", "vue"]);

/** Bare package specifiers an item imports without naming them in its `deps`. */
const undeclaredImports = (): string[] => {
    const undeclared: string[] = [];
    const declaredBy = new Map(manifests.map(({ manifest, name }) => [name, new Set(Object.keys(manifest.deps ?? {}))]));

    for (const { from, name, source } of itemSources.filter((entry) => /\.tsx?$/u.test(entry.from))) {
        // Bare specifiers only — a relative import or a `#lunora/…` subpath
        // resolves inside the user's own project.
        for (const match of source.matchAll(/from "((?:@[a-z\d-]+\/)?[a-z\d][a-z\d._-]*)(?:\/[^"]*)?"/gu)) {
            const packageName = match[1] as string;

            if (!declaredBy.get(name)?.has(packageName) && !CONSUMER_PROVIDED.has(packageName)) {
                undeclared.push(`${name} → ${packageName} (${from})`);
            }
        }
    }

    return undeclared;
};

/** Every `createMailerFromEnv(` call site in the registry, split by whether it guards `cloudflareSend`. */
const mailerCallSites = (): { guarded: string[]; unguarded: string[] } => {
    const guarded: string[] = [];
    const unguarded: string[] = [];

    for (const { from, name, source } of itemSources) {
        const calls = source.split("\n").filter((line) => line.includes("createMailerFromEnv(") && !line.trimStart().startsWith("*"));

        for (const line of calls) {
            (line.includes('["SEND_EMAIL"] === undefined') ? guarded : unguarded).push(`${name} → ${from}: ${line.trim()}`);
        }
    }

    return { guarded, unguarded };
};

/** The message shapes that mark a throw as an authorization refusal rather than a server fault. */
const AUTHORIZATION_MESSAGE = /requires an authenticated user|belongs to a different user|is not allowed/iu;

/** Authorization refusals thrown as a bare `Error`, which `toErrorBody` redacts to a 500. */
const uncodedAuthorizationThrows = (): string[] =>
    itemSources
        .filter(({ source }) =>
            [...source.matchAll(/throw new Error\((?<head>[^;]*)/gu)].some((match) => AUTHORIZATION_MESSAGE.test(match.groups?.["head"] ?? "")),
        )
        .map(({ from, name }) => `${name} → ${from}`);

let workdir: string;

const seedProject = (): void => {
    const lunoraDirectory = join(workdir, "lunora");

    mkdirSync(lunoraDirectory, { recursive: true });
    writeFileSync(join(workdir, "package.json"), JSON.stringify({ dependencies: {}, name: "demo" }, undefined, 4), "utf8");
    writeFileSync(join(workdir, "wrangler.jsonc"), '{\n    // demo\n    "name": "demo"\n}\n', "utf8");
    writeFileSync(join(lunoraDirectory, "schema.ts"), BASE_SCHEMA, "utf8");
};

describe("shipped registry items", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-registry-"));
        seedProject();
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    it("discovers at least the ratelimit and presence items", () => {
        expect.assertions(2);

        expect(itemNames).toContain("ratelimit");
        expect(itemNames).toContain("presence");
    });

    it("index.json catalog matches the item directories (no drift)", () => {
        expect.assertions(1);

        const index = JSON.parse(readFileSync(join(registryRoot, "index.json"), "utf8")) as { items: { name: string }[] };
        const indexed = index.items.map((entry) => entry.name).toSorted((a, b) => a.localeCompare(b));

        expect(indexed).toStrictEqual(itemNames.toSorted((a, b) => a.localeCompare(b)));
    });

    it("the committed index.json is current (registry build --check passes)", async () => {
        expect.assertions(1);

        const result = await runBuildIndexCommand({ check: true, from: registryRoot, logger: silentLogger(), names: [] });

        expect(result.code).toBe(0);
    });

    it("array bindings (r2_buckets) merge across items instead of overwriting", async () => {
        expect.assertions(2);

        // storage + backup each contribute an r2_buckets entry; adding both must
        // keep both bindings (the second must not clobber the first).
        await runAddCommand({ cwd: workdir, from: registryRoot, logger: silentLogger(), names: ["storage"], yes: true });
        await runAddCommand({ cwd: workdir, from: registryRoot, logger: silentLogger(), names: ["backup"], yes: true });

        const wrangler = readFileSync(join(workdir, "wrangler.jsonc"), "utf8");

        expect(wrangler).toContain("UPLOADS");
        expect(wrangler).toContain("BACKUP_BUCKET");
    });

    it("keeps a project's existing binding instead of adding a second under the same name", async () => {
        expect.assertions(4);

        // `auth` contributes a `d1_databases` entry bound to
        // DB with placeholder ids. Structural dedupe alone let that sit ALONGSIDE
        // a real DB entry, so wrangler saw two bindings named DB and the app
        // could deploy against `replace-me-db`.
        const wranglerPath = join(workdir, "wrangler.jsonc");
        // The fixture is real JSONC (comments), so it is edited structurally
        // rather than round-tripped through JSON.parse.
        const seeded = applyEdits(
            readFileSync(wranglerPath, "utf8"),
            modify(readFileSync(wranglerPath, "utf8"), ["d1_databases"], [{ binding: "DB", database_id: "real-id-0001", database_name: "production" }], {}),
        );

        writeFileSync(wranglerPath, seeded);

        const { logger, messages } = ((): { logger: Logger; messages: string[] } => {
            const captured: string[] = [];
            const record = (message: string): void => {
                captured.push(message);
            };

            return { logger: { error: record, info: record, success: record, warn: record }, messages: captured };
        })();

        await runAddCommand({ cwd: workdir, from: registryRoot, logger, names: ["auth"], yes: true });

        const databases = (parseJsonc(readFileSync(wranglerPath, "utf8")) as { d1_databases: { binding: string; database_id: string }[] }).d1_databases;

        expect(databases).toHaveLength(1);
        expect(databases[0]?.database_id).toBe("real-id-0001");
        expect(JSON.stringify(databases)).not.toContain("replace-me-db");
        // Silently keeping it would be its own trap — the skip is reported.
        expect(messages.some((message) => message.includes("binding DB already exists"))).toBe(true);
    });

    it("self-describing bindings (ai/browser/images) are single objects, not arrays", () => {
        expect.assertions(1);

        // Cloudflare's `ai`/`browser`/`images` bindings are single objects
        // (`{ "binding": "NAME" }`), unlike list bindings such as `r2_buckets`.
        // Wrapping one in an array writes a wrangler.jsonc wrangler rejects on
        // dev/deploy — guard every shipped item against that shape.
        const selfDescribing = new Set(["ai", "browser", "images"]);
        const offenders: string[] = [];

        for (const name of itemNames) {
            const manifest = parseManifest(JSON.parse(readFileSync(join(registryRoot, name, "registry.json"), "utf8")), name);

            for (const binding of manifest.bindings ?? []) {
                if (selfDescribing.has(binding.path[0] ?? "") && Array.isArray(binding.value)) {
                    offenders.push(`${name}:${binding.path.join(".")}`);
                }
            }
        }

        expect(offenders).toStrictEqual([]);
    });

    it("every scaffolded binding carries the fields wrangler requires", () => {
        expect.assertions(1);

        // `lunora registry add hyperdrive` left a `wrangler.jsonc` that failed
        // validation for the whole Worker: the hyperdrive entry was the one
        // shipped without a placeholder for its required `id`, while `auth`,
        // `mail` and `storage` all had one for theirs.
        expect(bindingsMissingRequiredFields()).toStrictEqual([]);
    });

    it("every package an item imports is declared in its `deps`", () => {
        expect.assertions(1);

        // `deps` is written verbatim into a USER's package.json by `lunora add`,
        // so a package an item imports but does not declare is simply absent from
        // the scaffolded project. `storage`, `payment` and `presence` each reached
        // for `@lunora/errors` without declaring it while their `ai`/`browser`
        // siblings did, and the Solid 2 port used `@solidjs/web` — its JSX import
        // source, a package that exists only on the 2.x line — in 15 files without
        // naming it anywhere.
        expect(undeclaredImports()).toStrictEqual([]);
    });

    it("no item hands `createMailerFromEnv` an unguarded `cloudflareSend`", () => {
        expect.assertions(2);

        // `createMailerFromEnv` prefers `cloudflareSend` over `RESEND_API_KEY`
        // whenever it is supplied (`packages/mail/src/from-env.ts`), so passing it
        // unconditionally makes the documented Resend path unreachable: a deploy
        // with no `SEND_EMAIL` binding throws inside the callback while
        // `RESEND_API_KEY` is set. The base `auth` item shipped exactly that while
        // its three siblings guarded the call.
        const { guarded, unguarded } = mailerCallSites();

        expect(unguarded).toStrictEqual([]);
        // Guard the guard: a renamed helper must not turn this into a vacuous pass.
        expect(guarded).toHaveLength(4);
    });

    it("authorization guards throw a coded error, not a bare `Error`", () => {
        expect.assertions(1);

        // `toErrorBody` maps a non-`LunoraError` to a redacted `INTERNAL` 500, so
        // an uncoded throw tells the caller "server fault" where it meant "sign in
        // first" / "not yours". Item authors keep rediscovering this — `ai` and
        // `browser` carry a comment about it — so it is checked here.
        expect(uncodedAuthorizationThrows()).toStrictEqual([]);
    });

    it("the `auth-emails` recipe passes only fields `sendAuthEmail` accepts", () => {
        expect.assertions(1);

        // The item's only documented integration is
        // `sendAuthEmail(env, { html, subject, text, to })`, and `renderEmail`
        // really does return `{ html, text }` — but the base `auth` item's
        // signature named only `{ subject, text, to }`, so the recipe did not
        // compile against the item it `requires`.
        const { docs } = JSON.parse(readFileSync(join(registryRoot, "auth-emails", "registry.json"), "utf8")) as { docs: string };
        const signature =
            /const sendAuthEmail = async \(env: AuthEnv, message: \{(?<fields>[^}]*)\}/u.exec(readFileSync(join(registryRoot, "auth", "index.ts"), "utf8"))
                ?.groups?.["fields"] ?? "";

        const passed = /sendAuthEmail\(env, \{(?<fields>[^}]*)\}/u
            .exec(docs)
            ?.groups?.["fields"]?.split(",")
            .map((field) => (field.split(":")[0] as string).trim())
            .filter((field) => field.length > 0);

        expect(passed?.filter((field) => !new RegExp(String.raw`\b${field}\??:`, "u").test(signature))).toStrictEqual([]);
    });

    it("`list` reads the catalog and reports every item", async () => {
        // eslint-disable-next-line vitest/prefer-expect-assertions -- one assertion per discovered item; data-driven, so not a literal
        expect.assertions(itemNames.length);

        const lines: string[] = [];
        const capturing: Logger = { error: (m) => lines.push(m), info: (m) => lines.push(m), success: (m) => lines.push(m), warn: (m) => lines.push(m) };

        await runAddCommand({ cwd: workdir, from: registryRoot, list: true, logger: capturing, names: [] });

        const output = lines.join("\n");

        for (const name of itemNames) {
            expect(output).toContain(name);
        }
    });

    describe.each(itemNames)("%s", (name) => {
        const manifestRaw = JSON.parse(readFileSync(join(registryRoot, name, "registry.json"), "utf8")) as unknown;
        const manifest = parseManifest(manifestRaw, name);

        it("manifest name matches its directory", () => {
            expect.assertions(1);

            expect(manifest.name).toBe(name);
        });

        it("ships a README", () => {
            expect.assertions(1);

            // The README is the only prose a copy-in item has once it lands in
            // someone's repo — `auth-emails` was the one item of 26 without one.
            expect(existsSync(join(registryRoot, name, "README.md"))).toBe(true);
        });

        it("every declared source file exists in the item directory", () => {
            // eslint-disable-next-line vitest/prefer-expect-assertions -- count is one-per-file plus the non-empty guard; data-driven, so not a literal
            expect.assertions(manifest.files.length + 1);

            // An item with no files would be degenerate — guard so the assertion count holds.
            expect(manifest.files.length).toBeGreaterThan(0);

            for (const file of manifest.files) {
                expect(existsSync(join(registryRoot, name, file.from))).toBe(true);
            }
        });

        it("add writes every destination file and merges any schema extension", async () => {
            // eslint-disable-next-line vitest/prefer-expect-assertions -- count is exit-code + schema-merge + one-per-file; data-driven, so not a literal
            expect.assertions(2 + manifest.files.length);

            const result = await runAddCommand({ cwd: workdir, from: registryRoot, logger: silentLogger(), names: [name], yes: true });

            expect(result.code).toBe(0);

            const schema = readFileSync(join(workdir, "lunora", "schema.ts"), "utf8");
            // Items shipping a schema-extension file must have wired themselves into schema.ts.
            const hasExtension = manifest.files.some((file) => file.merge === "schema-extension");

            expect(hasExtension ? schema.includes(`.extend(${name}.extension)`) : true).toBe(true);

            for (const file of manifest.files) {
                expect(existsSync(join(workdir, file.to))).toBe(true);
            }
        });

        it("is idempotent — a second add skips without duplicating the schema extension", async () => {
            expect.assertions(1);

            await runAddCommand({ cwd: workdir, from: registryRoot, logger: silentLogger(), names: [name], yes: true });
            await runAddCommand({ cwd: workdir, from: registryRoot, logger: silentLogger(), names: [name], yes: true });

            const schema = readFileSync(join(workdir, "lunora", "schema.ts"), "utf8");
            const extendCount = schema.split(`.extend(${name}.extension)`).length - 1;

            // 0 for items with no schema extension, exactly 1 for those that have one — never duplicated.
            expect(extendCount).toBeLessThanOrEqual(1);
        });
    });
});
