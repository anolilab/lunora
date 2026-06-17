// @ts-check
import config from "@anolilab/prettier-config";

/**
 * The shared @anolilab preset carries no Svelte support, so `.svelte` files
 * (the SvelteKit template) have no parser. Add `prettier-plugin-svelte` and a
 * `*.svelte` override so Prettier can format them.
 *
 * @type {import('prettier').Config}
 */
export default {
    ...config,
    plugins: [...(config.plugins ?? []), "prettier-plugin-svelte"],
    overrides: [...(config.overrides ?? []), { files: "*.svelte", options: { parser: "svelte" } }],
};
