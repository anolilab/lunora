import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { codeOnly, withoutComments } from "../../../shared/code-only";

/**
 * Wrapper snippet shown in every `worker.ts` warning — kept as one constant so
 * the messages below stay byte-identical.
 *
 * It COMPOSES Nitro's handler rather than re-exporting its `default`. Nitro's
 * handler does export `scheduled` / `queue` / `email`, but each only fires the
 * matching `cloudflare:*` Nitro hook, which nothing here listens on — so a
 * re-export produces a worker where Cloudflare finds those entrypoints, calls
 * them successfully, and Lunora's own never run.
 */
// All three event entrypoints, not just `scheduled`. Nitro exports `scheduled`,
// `queue` and `email`, and each only fires an empty `cloudflare:*` hook, so a
// bare `export { default } from` swallows every one of them. Handing the user a
// snippet that fixes one and warns about the other two invites exactly the
// silent loss the warning describes — a queue consumer that returns without
// throwing ACKS its batch. Mirrors `templates/nuxt/worker.ts`.
const WORKER_TS_SNIPPET =
    'import nitro from "./.output/server/index.mjs"; import app, { ShardDO } from "./lunora/server"; export { ShardDO }; export default { ...nitro, email: (m, e, x) => app.email?.(m, e, x), queue: (b, e, x) => app.queue?.(b, e, x), scheduled: (c, e, x) => app.scheduled(c, e, x) };';

/** Whether the source has an `export` keyword anywhere at all. */
const EXPORT_KEYWORD_PATTERN = /\bexport\b/u;

/** Whether the source mentions the `ShardDO` identifier anywhere at all. */
const SHARD_DO_IDENTIFIER_PATTERN = /\bShardDO\b/u;

/** `export * from` a specifier containing "lunora" — re-exports everything (including `ShardDO`) from a barrel without naming it, the common case being `export * from "./lunora/server"`. Global: every match is checked for being real code, not just the first. */
const LUNORA_STAR_EXPORT_PATTERN = /\bexport\s*\*\s*from\s*["'][^"']*lunora[^"']*["']/gu;

/**
 * Whether the entry really re-exports a lunora barrel wholesale.
 *
 * The probe has to read a SPECIFIER, so it runs over {@link withoutComments},
 * which keeps string literals — and a string literal that happens to CONTAIN
 * `export * from "@lunora/server"` (a docs snippet, a scaffolder template) would
 * otherwise satisfy it and silence the warning for a worker that exports no
 * `ShardDO` at all. {@link codeOnly} blanks in place, so offsets line up across
 * both transforms and the raw source: a match whose first character survives
 * `codeOnly` unchanged started outside any string.
 */
const starExportsLunoraBarrel = (source: string): boolean => {
    const code = codeOnly(source);

    return [...withoutComments(source).matchAll(LUNORA_STAR_EXPORT_PATTERN)].some(({ index }) => code[index] === source[index]);
};

/** Whether the entry mentions `scheduled` at all — the cron entrypoint a Nitro re-export silently swallows. */
const SCHEDULED_IDENTIFIER_PATTERN = /\bscheduled\b/u;

/**
 * Whether `source` looks like it exports `ShardDO` — the file has an `export`
 * keyword AND either mentions the `ShardDO` identifier somewhere (covers
 * `export { ShardDO } from "./lunora/server"`, a local `export { ShardDO }`,
 * `export { X as ShardDO }` — a binding named `ShardDO` is what wrangler
 * resolves the Durable Object class by, whether it's the bare name or the
 * right side of `as`) or re-exports a lunora barrel wholesale via
 * {@link LUNORA_STAR_EXPORT_PATTERN}.
 *
 * Deliberately two independent, simple keyword/identifier checks rather than
 * one combined regex trying to prove `ShardDO` sits INSIDE a specific `export`
 * statement — not a real TS parse (mirrors `@lunora/astro`'s
 * `WITH_LUNORA_CALL_PATTERN`: a documented regex is judged proportionate to a
 * build-time warning hook; ts-morph would be heavier than this hook warrants).
 *
 * Probed against blanked source, never the raw file, which is the same reason
 * `@lunora/astro` runs its probe through `codeOnly`. This entry's whole job is
 * `ShardDO` and `scheduled`, so it is the file most likely to carry a comment
 * explaining that both lines are load-bearing — the template this module ships
 * with does, at length — and matching the comment left the warning silent for a
 * worker that had dropped the export. The star-export probe reads a SPECIFIER,
 * so it needs string literals to survive — see {@link starExportsLunoraBarrel},
 * which keeps them and then rejects a match that sits inside one.
 *
 * Remaining imprecision: false-POSITIVE on `export { ShardDO as Other }`
 * (renames `ShardDO` away, so the binding wrangler needs is actually named
 * `Other`), or in principle on `export`ing something else entirely while
 * `ShardDO` is merely imported. Both are accepted trade-offs for a two-line
 * worker entry file.
 */
const looksLikeShardDoExport = (source: string): boolean => {
    const code = codeOnly(source);

    if (!EXPORT_KEYWORD_PATTERN.test(code)) {
        return false;
    }

    return SHARD_DO_IDENTIFIER_PATTERN.test(code) || starExportsLunoraBarrel(source);
};

/** Whether the source installs `@lunora/vue`'s provider (`app.use(createLunora(client))`). */
const CREATE_LUNORA_PATTERN = /\bcreateLunora\b/u;

/** Read `path` and report whether it mentions `createLunora`; an unreadable file simply doesn't count as a provider. */
const providesLunoraClient = (path: string): boolean => {
    try {
        return CREATE_LUNORA_PATTERN.test(codeOnly(readFileSync(path, "utf8")));
    } catch {
        return false;
    }
};

/**
 * Check that `worker.ts` at the project root actually re-exports `ShardDO` —
 * not just that the file exists. Extracted from `setup()` so it is testable
 * without booting Nuxt (`defineNuxtModule`'s `setup` needs full Nuxt Kit
 * scaffolding to invoke; this plain function does not).
 *
 * All three outcomes — missing file, unreadable file, present-but-no-`ShardDO`-
 * export — WARN and return; none of them throws. Matches the module's existing
 * stance ("we can't write the user's file, so warn... rather than fail an
 * otherwise-valid build") and the `@lunora/astro` precedent this mirrors.
 */
export const checkWorkerEntry = (rootDirectory: string, warn: (message: string) => void): void => {
    const workerPath = join(rootDirectory, "worker.ts");

    if (!existsSync(workerPath)) {
        warn(
            `missing worker.ts at the project root — add a wrapper that re-exports Nitro's handler and \`ShardDO\` (\`${WORKER_TS_SNIPPET}\`) and point wrangler's \`main\` at it, so the SHARD Durable Object is exported from the deployed worker.`,
        );

        return;
    }

    let source: string;

    try {
        source = readFileSync(workerPath, "utf8");
    } catch (error) {
        // `existsSync` passing doesn't guarantee a readable regular file (it
        // could be a directory, permission-denied, a broken symlink loop, …) —
        // this hook warns rather than fails the build, so a read failure must
        // degrade to a warning too, not an uncaught throw out of `setup()`.
        const reason = error instanceof Error ? error.message : String(error);

        warn(`could not read worker.ts at the project root (${reason}) — skipping the \`ShardDO\` export check.`);

        return;
    }

    if (!looksLikeShardDoExport(source)) {
        warn(
            `worker.ts at the project root does not appear to export \`ShardDO\` — add \`export { ShardDO } from "./lunora/server";\` (e.g. \`${WORKER_TS_SNIPPET}\`) and point wrangler's \`main\` at it, so the SHARD Durable Object is exported from the deployed worker.`,
        );
    }

    // The silent half of the same wiring. `export { default } from` Nitro's
    // output ships a worker whose `scheduled` / `queue` / `email` only fire an
    // empty `cloudflare:*` Nitro hook, so Lunora's never run — while
    // `lunora deploy` writes the matching `triggers.crons` (and queue consumer)
    // from the same codegen discovery. The trigger exists, Cloudflare fires it,
    // the invocation succeeds, and the cron does nothing. Nothing else in the
    // build says a word about it, which is why it is worth a warning.
    if (!SCHEDULED_IDENTIFIER_PATTERN.test(codeOnly(source))) {
        warn(
            `worker.ts at the project root does not forward \`scheduled\` — re-exporting Nitro's \`default\` gives Cloudflare a \`scheduled\` entrypoint that only fires an empty \`cloudflare:scheduled\` hook, so a cron declared in \`lunora/crons.ts\` is provisioned and then runs nothing. Compose the two instead (\`${WORKER_TS_SNIPPET}\`), which forwards \`queue\` and \`email\` too — Nitro's exports for those fire empty hooks the same way, and a queue consumer that returns without throwing ACKS its batch.`,
        );
    }
};

/**
 * One entry of Nuxt's resolved plugin list (`app.plugins` at `app:resolve`):
 * an absolute `src` plus the `mode` Nuxt derived for it. Declared structurally
 * for the same reason as `LunoraNuxtModule` in `module.ts` — `@nuxt/schema`, which owns
 * `NuxtPlugin`, is not a resolvable dependency here — and `NuxtPlugin[]`
 * satisfies it.
 */
export interface ResolvedNuxtPlugin {
    mode?: "all" | "client" | "server";
    src: string;
}

/**
 * Warn when the project's ONLY `LunoraClient` provider is a client-only plugin.
 *
 * `@lunora/vue`'s composables call `useLunora()` unconditionally — ahead of
 * their own browser guard — and it throws when nothing is injected. A
 * `plugins/lunora.client.ts` by definition never runs on the server, so the
 * first server-rendered page touching Lunora answers 500 with
 * `useLunora(): no LunoraClient provided`. The fix is dropping `.client` from
 * the filename plus a universal way to read the origin, which the warning says.
 *
 * Takes Nuxt's own resolved plugin list (`app.plugins`, from the `app:resolve`
 * hook) rather than scanning `plugins/` itself. That is the whole point: Nuxt
 * loads plugins with a two-pattern, ONE-level glob — top-level entries plus a
 * subdirectory's `index` file — over every layer's configured plugins dir, so
 * a filesystem scan of its own has to mirror the glob, the extension list,
 * `dir.plugins` and every layer — and gets the answer WRONG in both directions
 * when it doesn't. A recursive scan counts `plugins/lib/make-client.ts` (an
 * ordinary colocated helper Nuxt never loads) as a universal provider and goes
 * silent on a genuinely broken app. Reading `mode` off the resolved entry also
 * drops the `.client` filename rule, since that is what Nuxt derived it from.
 *
 * Detection of the provider itself is the same shape as
 * {@link looksLikeShardDoExport}: a documented keyword test, not a TS parse,
 * because the outcome is a build-time warning. Its imprecision is a
 * `createLunora` mention inside a comment, whose only cost is a warning
 * pointing at a file that is already about the client.
 *
 * Silence requires a provider Nuxt loads on the server — `mode` `"all"` or
 * `"server"` — not merely a working app: an app that confines every Lunora
 * usage to `<ClientOnly>` is correct with a client-only provider and still
 * warns, which is why the message names that case as a reason to ignore it.
 */
export const checkClientOnlyProvider = (plugins: ReadonlyArray<ResolvedNuxtPlugin>, warn: (message: string) => void): void => {
    const providers = plugins.filter((plugin) => providesLunoraClient(plugin.src));

    if (providers.length === 0 || providers.some((plugin) => plugin.mode !== "client")) {
        return;
    }

    warn(
        `the only plugin providing a \`LunoraClient\` is client-only (${providers.map((plugin) => plugin.src).join(", ")}) — ` +
            `\`@lunora/vue\`'s composables resolve the client during SSR too and throw \`useLunora(): no LunoraClient provided\` without one, ` +
            `so the first server-rendered page that touches Lunora answers 500. Drop the \`.client\` from the filename to make the plugin ` +
            `universal, and read the origin with \`useRequestURL().origin\`, which resolves from the incoming request on the server and from ` +
            `\`window.location\` in the browser. Ignore this if every Lunora usage is confined to \`<ClientOnly>\`, which never renders on the server.`,
    );
};
