/**
 * The Lunora Astro **integration** — an `AstroIntegration` object
 * (`{ name, hooks }`) added to `astro.config.*`'s `integrations` array.
 *
 * Astro is multi-framework at the UI layer, so this integration is **not** a new
 * reactive runtime. Its job is the *composition* seam (PLAN4 class-B): make the
 * Worker `@astrojs/cloudflare` emits mount Lunora realtime under `/_lunora/*`
 * via `withLunora`, and surface the framework-neutral server helpers
 * (`@lunora/astro/server`) to Astro server endpoints / `.astro` frontmatter.
 *
 * Reactivity itself comes from whichever island adapter the app hydrates with —
 * `@lunora/react`, `@lunora/solid`, `@lunora/svelte`, or `@lunora/vue` — each of
 * which ships its own `hydratePreloaded(preloaded)` for the SSR-seed → live
 * handoff. This package owns the server/composition half only.
 *
 * The integration is declarative-only: it does not write or modify the
 * project's `serverEntry` file (no injection). The `withLunora` wiring at the
 * server-entry boundary is a step the project author performs by hand; the
 * `astro:config:done` hook below only checks that they did, and warns (mirrors
 * `@lunora/nuxt`'s missing-`worker.ts` check) rather than failing the build.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Structural subset of Astro's `AstroIntegration`. Declared locally (rather than
 * importing `astro`'s type) so `@lunora/astro`'s public surface stays decoupled
 * from a specific Astro major and type-checks even when `astro` is not installed
 * — `astro` is an *optional* peer here (only the host Astro app pulls it in).
 * The shape is assignable to/from Astro's real `AstroIntegration`, so adding the
 * returned object to `integrations` type-checks in a real Astro project.
 */
interface AstroIntegrationLike {
    readonly hooks: {
        readonly [hook: string]: ((...arguments_: never[]) => unknown) | undefined;
    };
    readonly name: string;
}

/**
 * Structural subset of the `astro:config:done` hook payload this integration
 * reads: `config.root` (to resolve `serverEntry` to an absolute path) and
 * `logger` (Astro's per-integration scoped logger). Declared locally for the
 * same decoupling reason as {@link AstroIntegrationLike} — real Astro always
 * passes both, but every field is optional here so a caller invoking the hook
 * directly (tests, or a future Astro major that reshapes the payload) degrades
 * to a no-op check rather than throwing.
 */
interface ConfigDoneContext {
    readonly config?: {
        readonly root?: URL;
    };
    readonly logger?: {
        readonly warn: (message: string) => void;
    };
}

/** Copy/paste wiring snippet shown when `serverEntry` composes nothing. */
const WITH_LUNORA_SNIPPET = [
    "// src/server.ts",
    'import { handle } from "@astrojs/cloudflare/handler";',
    'import { withLunora } from "@lunora/astro";',
    "",
    "// `shardDO` lives on `env` (per request), so pass an `(env) => options` factory.",
    "export default withLunora(",
    "  (req, env, ctx) => handle(req, env, ctx),",
    "  (env) => ({ shardDO: env.SHARD /* , … */ }),",
    ");",
].join("\n");

/**
 * Matches an actual composition CALL in the server entry — either spelling of the
 * same seam:
 *
 * `withLunora(astroWorker, …)` is the standalone helper (an alias of
 * `withFrameworkWorker`), and is what {@link WITH_LUNORA_SNIPPET} shows.
 * `.buildFrameworkWorker(host)` is the generated `defineApp` builder's terminal,
 * and is what the scaffolded template and every other class-B template use. It
 * was missing here, so a fresh `astro build` warned "subscriptions will silently
 * 404" about a worker that was correctly composed.
 *
 * Deliberately does NOT match `import { withLunora } from "@lunora/astro";`: that
 * specifier is followed by `}`/whitespace/`from`, never directly by `(`, so a file
 * that imports the helper but forgets to invoke it is correctly reported as
 * missing the wiring instead of passing on the import alone.
 *
 * Run against {@link codeOnly}, never the raw file: a name inside a comment or a
 * string is not a call, and matching one suppressed the warning for an entry
 * that composed nothing.
 */
const WITH_LUNORA_CALL_PATTERN = /\b(?:withLunora|withFrameworkWorker|buildFrameworkWorker)\s*\(/u;

/** `/* … *\/`, non-greedy so it ends at the FIRST `*\/`. */
const BLOCK_COMMENT = String.raw`\/\*[\s\S]*?\*\/`;
/** `// …` to end of line. */
const LINE_COMMENT = String.raw`\/\/[^\n]*`;
/** `"…"`, honouring backslash escapes and never crossing a newline. */
const DOUBLE_QUOTED = String.raw`"(?:[^"\\\n]|\\.)*"`;
/** `'…'`, the same rules as {@link DOUBLE_QUOTED}. */
const SINGLE_QUOTED = String.raw`'(?:[^'\\\n]|\\.)*'`;

/**
 * A template literal with NO `${…}` in it (that is what the `\$(?!\{)` guard
 * costs). One that interpolates is deliberately left alone: its interpolations
 * are real code, and blanking the whole literal would hide a composition call
 * written inside one.
 *
 * The delimiter is written `\x60` rather than an escaped backtick because
 * `String.raw` would keep that backslash, and `\`` is not a legal escape in a
 * unicode-mode pattern.
 */
const PLAIN_TEMPLATE = String.raw`\x60(?:[^\x60\\$]|\\.|\$(?!\{))*\x60`;

/**
 * Comments and string literals, matched left to right in ONE alternation so
 * whichever construct OPENS first wins: a quote inside a comment is part of that
 * comment, and a `//` inside a string is part of that string. That ordering is
 * the whole trick — it is what a hand-rolled mode machine buys you, without the
 * machine. Assembled from the named parts above rather than written as one
 * literal, because as a literal it is unreadable.
 */
const SKIPPABLE_RE = new RegExp([BLOCK_COMMENT, LINE_COMMENT, DOUBLE_QUOTED, SINGLE_QUOTED, PLAIN_TEMPLATE].join("|"), "gu");

/** Every character except a newline — line structure survives when a span is blanked. */
const NON_NEWLINE_RE = /[^\n]/gu;

/**
 * The source with its comments and string literals blanked out, so the call
 * probe above sees code and only code.
 *
 * A scan rather than a parser: this package has no parser dependency and would
 * not add one for a build-time warning, and the check only has to answer "is
 * this identifier followed by `(` somewhere that executes".
 *
 * Spans are replaced with spaces rather than deleted, so nothing that was
 * separated becomes adjacent.
 *
 * Known ceiling: a template literal that BOTH interpolates and mentions one of
 * the names in its string part still reads as a call. Narrowing that needs real
 * parsing, and this check only drives a warning.
 */
const codeOnly = (source: string): string => source.replaceAll(SKIPPABLE_RE, (span) => span.replaceAll(NON_NEWLINE_RE, " "));

/** Options for the `lunora` integration. */
interface LunoraIntegrationOptions {
    /**
     * Path (or specifier) of the module that composes the Lunora plane with the
     * Astro handler and is the composed worker's `export default`. Documented for
     * the wiring story; when omitted the integration assumes the conventional
     * `src/server.ts` — deliberately NOT `src/worker.ts`, which `lunora deploy`
     * treats as a SvelteKit-shaped entry to pass to wrangler positionally, and
     * which the `@astrojs/cloudflare` redirect's `no_bundle: true` then uploads
     * untranspiled.
     */
    readonly serverEntry?: string;
}

/**
 * The Lunora Astro integration. Add it to `astro.config.*`:
 *
 * ```ts
 * import cloudflare from "@astrojs/cloudflare";
 * import { defineConfig } from "astro/config";
 * import { lunora } from "@lunora/astro";
 *
 * export default defineConfig({
 *   output: "server",
 *   adapter: cloudflare(),
 *   integrations: [lunora()],
 * });
 * ```
 *
 * What it does:
 *
 * - Documents the `serverEntry` (default `src/server.ts`) where the
 *   `withLunora(astroWorker, { shardDO: env.SHARD, … })` composition — or the
 *   generated builder's `.buildFrameworkWorker(host)` — lives.
 * - Checks, at `astro:config:done`, that `serverEntry` exists and contains an
 *   actual composition CALL (not merely an import of it) — and warns
 *   (does not fail the build) when it doesn't, so a missing wrapper is caught
 *   at build time instead of shipping a worker where `/_lunora/*` is unrouted
 *   and realtime silently 404s.
 *
 * This integration does NOT wrap the server entry itself — no file is written
 * or modified. The load-bearing composition is the `withLunora` call the
 * project author writes at the server-entry boundary (see `withLunora` for the
 * `@astrojs/cloudflare` injection point); this object exists so the wiring is
 * declared in `astro.config` the idiomatic Astro way, checked once at build
 * time, and has a home for future build-time hooks (binding reconcile, dev
 * middleware) without changing the public surface.
 */
const lunora = (options: LunoraIntegrationOptions = {}): AstroIntegrationLike => {
    const serverEntry = (options.serverEntry ?? "src/server.ts").trim();

    return {
        hooks: {
            "astro:config:done": (context: ConfigDoneContext = {}) => {
                if (serverEntry.length === 0) {
                    throw new TypeError("@lunora/astro: `serverEntry` must be a non-empty path.");
                }

                const root = context.config?.root;

                // Without a resolvable project root (e.g. a caller invoking this
                // hook directly outside a real Astro build) there is nothing to
                // check the entry file against — stay side-effect-free rather
                // than guessing a root.
                if (root === undefined) {
                    return;
                }

                // Not `context.logger?.warn ?? fallback`: that extracts the method as a
                // detached function reference, and Astro's real `Logger.warn` reads `this`
                // internally — called detached, it throws `Cannot read properties of
                // undefined (reading 'options')`. Wrapping in a closure keeps the call a
                // proper `context.logger.warn(...)` method call.
                const warn = (message: string): void => {
                    if (context.logger?.warn) {
                        context.logger.warn(message);
                    } else {
                        // eslint-disable-next-line no-console -- no `logger` was supplied on this call; fall back so the warning is never silently dropped
                        console.warn(message);
                    }
                };
                const entryPath = fileURLToPath(new URL(serverEntry, root));

                if (!existsSync(entryPath)) {
                    warn(
                        `@lunora/astro: server entry "${serverEntry}" not found — add it (or point \`lunora({ serverEntry })\` at the right path) and wrap the Astro worker with \`withLunora\`, or \`/_lunora/*\` (Lunora realtime) will be unrouted:\n\n${WITH_LUNORA_SNIPPET}`,
                    );

                    return;
                }

                let source: string;

                try {
                    source = readFileSync(entryPath, "utf8");
                } catch (error) {
                    // `existsSync` passing doesn't guarantee a readable regular file
                    // (it could be a directory, permission-denied, a broken symlink
                    // loop, …) — this hook warns rather than fails the build, so a
                    // read failure must degrade to a warning too, not an uncaught
                    // throw out of `astro:config:done`.
                    const reason = error instanceof Error ? error.message : String(error);

                    warn(`@lunora/astro: could not read server entry "${serverEntry}" (${reason}) — skipping the \`withLunora\` check.`);

                    return;
                }

                if (!WITH_LUNORA_CALL_PATTERN.test(codeOnly(source))) {
                    warn(
                        `@lunora/astro: couldn't find a \`withLunora(...)\` or \`.buildFrameworkWorker(...)\` call in the server entry "${serverEntry}" — \`/_lunora/*\` (Lunora realtime) will be unrouted and subscriptions will silently 404. Compose the Astro worker:\n\n${WITH_LUNORA_SNIPPET}`,
                    );
                }
            },
        },
        name: "@lunora/astro",
    };
};

export type { AstroIntegrationLike, LunoraIntegrationOptions };
export { lunora };
