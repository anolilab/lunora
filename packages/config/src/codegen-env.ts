/**
 * The environment switch that turns the codegen watch off.
 *
 * `lunora dev --no-codegen` disables the CLI's own watcher directly, but on the
 * Vite flavors the watcher lives in `@lunora/vite`, inside the framework dev
 * server the CLI spawns as a separate process — a process that re-parses argv
 * of its own and never sees the flag. So the flag travels to it as this env var
 * instead, and the plugin honours it.
 *
 * Without that hop the flag looked accepted and did nothing: `_generated/**`
 * kept being rewritten on every source save, with nothing logged, silently
 * discarding anything that post-processed the generated output.
 *
 * Settable by hand too, for a project that runs its framework dev script
 * directly rather than through `lunora dev`.
 */

/** Env var that turns codegen off when it spells `0` / `false`. Unset means on. */
const CODEGEN_ENV = "LUNORA_CODEGEN";

/** Whether {@link CODEGEN_ENV} explicitly disables codegen in `env` (`process.env` by default). */
const isCodegenDisabled = (env: Readonly<Record<string, string | undefined>> = process.env): boolean => {
    const normalized = env[CODEGEN_ENV]?.trim().toLowerCase();

    return normalized === "0" || normalized === "false";
};

export { CODEGEN_ENV, isCodegenDisabled };
