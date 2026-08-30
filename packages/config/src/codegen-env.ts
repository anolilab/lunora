/**
 * The environment switch that turns codegen off — the other spelling of
 * `lunora dev --no-codegen`.
 *
 * The flag alone could not reach the Vite flavors: there the codegen watch lives
 * in `@lunora/vite`, inside the framework dev server the CLI spawns as a separate
 * process, which re-parses its own argv and never sees it. So the flag travels as
 * this variable, and both the plugin and the CLI's own watcher read it — one
 * switch, one meaning, every flavor.
 *
 * It is a DEV switch. `vite build` ignores it deliberately: skipping generation
 * there would also skip the ERROR-level advisory gate that fails the build.
 *
 * One-directional, like `LUNORA_REMOTE`: it can turn codegen off, nothing turns
 * it back on. Settable by hand for a project that runs its framework dev script
 * directly rather than through `lunora dev`.
 */

/** Env var that turns codegen off when it spells `0` / `false`. Unset means on. */
const CODEGEN_ENV = "LUNORA_CODEGEN";

/**
 * Whether a {@link CODEGEN_ENV} value spells an explicit "off".
 *
 * Takes the VALUE, not the environment, mirroring `isRemoteEnvEnabled` in
 * `./cloudflare/remote-bindings` — the same package's existing answer to the same
 * question, with the opposite polarity.
 */
const isCodegenDisabled = (value: string | undefined): boolean => {
    const normalized = value?.trim().toLowerCase();

    return normalized === "0" || normalized === "false";
};

export { CODEGEN_ENV, isCodegenDisabled };
