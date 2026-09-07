/**
 * Assert that a scaffolded template's deployed worker entry forwards every
 * handler the app actually declares.
 *
 * A cron, queue or inbound-email binding is provisioned by `lunora deploy`
 * whether or not the entry exports a handler for it, so an entry that drops one
 * fails at runtime and nowhere else: Cloudflare fires the trigger into a module
 * with no `scheduled`, and a queue consumer that returns without throwing
 * IMPLICITLY ACKS the batch. Both are silent.
 *
 * This replaces an in-script check that passed vacuously in three separate ways,
 * each of which is now a hard failure rather than a silent skip:
 *
 * 1. It looked for `.onEmail(` under `lunora/` only, but the builder call lives
 *    in the WORKER ENTRY — so the email arm could never fire for any template.
 * 2. It decided an app had crons by testing whether `lunora/crons.ts` exists,
 *    while codegen discovers `cronJobs()` by identifier in any `lunora/**` file.
 * 3. It walked for a hand-built `export default {…}`, so the entries it could not
 *    read as one — a `virtual:` specifier resolved by the Vite plugin, or a
 *    `export { default } from "…"` re-export — were skipped rather than reported.
 *
 * Usage: node scripts/assert-entry-forwards-handlers.mjs <scaffold-dir>
 * Exits 1 with an explanation when an entry drops a declared handler, or when
 * the entry's handler set cannot be read at all.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** This repo's root, resolved from the script rather than the scaffold under test. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The suite that proves the generated class-A entry forwards its handlers.
 *
 * A `virtual:` main has no file to read here, and this check runs on the source
 * before the install, so there is no built worker either. The entry is emitted by
 * our own Vite plugin, and that emitter IS covered end to end — the suite below
 * writes the real emitted entry to disk and invokes `scheduled`/`queue`/`email`.
 * So rather than pretend to prove it here or wave it through, this asserts the
 * proof still holds: delete that suite, empty it, or skip it, and this gate
 * fails.
 */
const CLASS_A_ENTRY_SUITE = "packages/vite/__tests__/class-a-worker-entry.test.ts";

const SKIP_DIRS = new Set(["node_modules", "_generated", "dist", "build", ".git", ".svelte-kit", ".output", ".nuxt", ".vinxi"]);

/** Every source file in the scaffold, minus build output and generated code. */
/**
 * @param {string} dir
 * @param {string[]} out
 * @returns {string[]}
 */
const sourceFiles = (dir, out = []) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) {
            continue;
        }

        const full = join(dir, entry.name);

        if (entry.isDirectory()) {
            sourceFiles(full, out);
        } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
            out.push(full);
        }
    }

    return out;
};

/**
 * Comments stripped, so a handler named only in prose cannot satisfy a text
 * match — but string literals blanked FIRST, because a `//` inside one is not a
 * comment. Cutting the line at the first `//` ate the rest of any line carrying
 * a URL, so `const docs = "https://…"; const crons = cronJobs();` lost its
 * declaration and this gate passed vacuously. That is precisely the class of
 * defect it was rewritten to remove, reintroduced by its own comment stripper.
 *
 * Quoted strings only: a template literal can hold real code in `${…}`.
 */
/** @param {string} file @returns {string} */
const codeOf = (file) => stripToCode(readFileSync(file, "utf8"));

/**
 * Source with comments removed, so a handler named only in prose cannot satisfy
 * a text match — with STRINGS BLANKED FIRST, because neither comment form means
 * anything inside one.
 *
 * Order is the whole correctness argument here, and getting it wrong has made
 * this gate pass vacuously twice:
 *
 * - stripping line comments first cut every line at its first `//`, so
 *   `const docs = "https://…"; const crons = cronJobs();` lost its declaration;
 * - stripping block comments first let `const a = "/*"` open a comment that ran
 *   through the next `*` + `/` in a later string, swallowing everything between.
 *
 * Blanking quoted strings first removes both openings. Quoted strings only: a
 * template literal can hold real code in a `${…}` substitution.
 */
/** @param {string} source @returns {string} */
const stripToCode = (source) =>
    source
        .replaceAll(/"(?:[^"\\\n]|\\.)*"/g, '""')
        .replaceAll(/'(?:[^'\\\n]|\\.)*'/g, "''")
        .replaceAll(/\/\*[\S\s]*?\*\//g, "")
        .replaceAll(/\/\/.*$/gm, "");

/** `wrangler.jsonc`'s `main` — the module Cloudflare actually loads. */
/** @param {string} root @returns {string | undefined} */
const declaredMain = (root) => {
    const config = join(root, "wrangler.jsonc");

    if (!existsSync(config)) {
        return undefined;
    }

    return /"main"\s*:\s*"([^"]+)"/u.exec(readFileSync(config, "utf8"))?.[1];
};

/**
 * The CLI. Exported and invoked only when this file is the entry point, so the
 * module can be imported to pin {@link stripToCode} — the ordering below has
 * been wrong twice and is the whole correctness argument for this gate.
 */
/** @param {string} root @returns {void} */
const main = (root) => {
    const files = sourceFiles(root);
    const allCode = files.map((file) => codeOf(file)).join("\n");

    // What this app declares, discovered the way codegen discovers it — by the
    // builder call, anywhere in the scaffold — rather than by a filename convention.
    const declared = [];

    if (/\bcronJobs\s*\(/u.test(allCode)) {
        declared.push("scheduled");
    }

    if (/\bdefineQueue\s*\(/u.test(allCode)) {
        declared.push("queue");
    }

    if (/\.onEmail\s*\(/u.test(allCode)) {
        declared.push("email");
    }

    if (declared.length === 0) {
        process.exit(0);
    }

    const main = declaredMain(root);
    const offences = [];

    // A `virtual:` main is emitted by the Vite plugin at build time, and a bare
    // re-export forwards whatever the other module happens to export. Neither can be
    // read here, so neither may pass silently: an app that declares a handler and
    // cannot be shown to forward it is exactly the case this gate exists for.
    if (main !== undefined && main.startsWith("virtual:")) {
        // Existence alone was too weak a proxy: emptying the file, renaming its
        // describe, or `.skip`ping it would all keep this green while proving
        // nothing. Require the suite to still invoke each handler this app declares,
        // and to not be skipped wholesale.
        const suitePath = join(REPO_ROOT, CLASS_A_ENTRY_SUITE);
        const suite = existsSync(suitePath) ? codeOf(suitePath) : undefined;
        const unproven = suite === undefined ? declared : declared.filter((name) => !new RegExp(String.raw`\.${name}\s*\(`, "u").test(suite));

        if (suite !== undefined && /\b(?:describe|it|test)\.skip\s*\(/u.test(suite)) {
            offences.push(`${CLASS_A_ENTRY_SUITE} is skipped, so the generated entry's ${declared.join("/")} is proven nowhere.`);
        } else if (unproven.length > 0) {
            offences.push(
                `wrangler main is "${main}", emitted by the Vite plugin, so its handler set cannot be read from the ` +
                    `scaffold — and ${CLASS_A_ENTRY_SUITE}, the suite that invokes the emitted entry, ` +
                    `${suite === undefined ? "is gone" : `no longer invokes ${unproven.join("/")}`}. ` +
                    `Restore it, or this template's forwarding is proven nowhere.`,
            );
        }
    } else {
        const entryFile = main === undefined ? undefined : join(root, main);
        const candidates = entryFile !== undefined && existsSync(entryFile) ? [entryFile] : files;

        for (const file of candidates) {
            const source = codeOf(file);

            if (/export\s*\{\s*default\s*\}\s*from/u.test(source)) {
                offences.push(
                    `${relative(root, file)} re-exports another module's default, so it cannot be shown to forward ` +
                        `${declared.join(", ")} — the re-exported handler set is opaque here.`,
                );
                continue;
            }

            // Only a hand-built default export delegates; `export default app` forwards
            // everything already. The delegate's name is whatever the entry chose, so
            // take it from the `<name>.fetch(` call rather than assuming `app`. A
            // hand-built object can also be bound first and exported by name, which is
            // the same defect in different syntax.
            const exportedName = /export default (\w+)\s*;/u.exec(source);
            const bindsObjectLiteral =
                exportedName !== null && new RegExp(String.raw`(?:const|let|var)\s+${exportedName[1]}\s*(?::[^=]+)?=\s*\{`, "u").test(source);

            if (!source.includes("export default {") && !bindsObjectLiteral) {
                continue;
            }

            const delegate = /(\w+)\.fetch\s*\(/u.exec(source);

            if (!delegate) {
                continue;
            }

            const binding = delegate[1];
            const missing = declared.filter((name) => !source.includes(`${binding}.${name}`));

            if (missing.length > 0) {
                offences.push(`${relative(root, file)} → ${binding} drops ${missing.join(", ")}`);
            }
        }
    }

    if (offences.length > 0) {
        console.log(`declares ${declared.join(", ")} — but:`);
        console.log(offences.join("\n"));
        process.exit(1);
    }
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const target = process.argv[2];

    if (target === undefined) {
        console.error("usage: assert-entry-forwards-handlers.mjs <scaffold-dir>");
        process.exit(2);
    }

    main(target);
}

export { stripToCode };
