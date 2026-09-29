import type { CodegenOptions } from "@lunora/codegen";

/**
 * Options for the `lunoraRspack()` plugin factory.
 *
 * Deliberately a subset of `@lunora/vite`'s. Everything absent here is
 * Vite-dev-server machinery with no Rspack counterpart (`overlay`,
 * `cloudflare`, `shard`) — see the package README for which of those the
 * wrangler side of the stack covers instead. `studio` lives on the Rsbuild
 * options, since it needs a dev server to mount on.
 */
interface LunoraRspackOptions {
    /**
     * Which machine-readable API spec(s) codegen emits into `_generated/`.
     * `"openapi"` (default) writes `openapi.json` (OpenAPI 3.1; RPC + REST),
     * `"openrpc"` writes `openrpc.json` (OpenRPC 1.x; RPC-only), `"both"` writes
     * both, and `"none"` writes neither. Forwarded to `runCodegen({ apiSpec })`;
     * the value set is derived from `CodegenOptions` so it can't drift.
     */
    apiSpec?: CodegenOptions["apiSpec"];

    /** Project root containing the `lunora/` directory. Defaults to `process.cwd()`. */
    projectRoot?: string;

    /** Directory name (relative to `projectRoot`) containing `schema.ts` and function files. Defaults to `"lunora"`. */
    schemaDir?: string;

    /**
     * Deploy target the emitted `ctx.*` surface is tailored to. Defaults to
     * `"target"` in `lunora.config.*`, then `"cloudflare"`.
     *
     * Set it here only to override the project config for one build — keeping
     * this and `lunora deploy` on the same target is what the shared resolution
     * in `@lunora/config` exists to guarantee.
     */
    target?: string;

    /** Validate that `wrangler.jsonc` declares the bindings the schema implies. Defaults to `true`. */
    validateWrangler?: boolean;
}

/** Resolved options after merging defaults. */
interface ResolvedLunoraRspackOptions {
    apiSpec: NonNullable<CodegenOptions["apiSpec"]>;
    projectRoot: string;
    schemaDir: string;
    target: string;
    validateWrangler: boolean;
}

export type { LunoraRspackOptions, ResolvedLunoraRspackOptions };
