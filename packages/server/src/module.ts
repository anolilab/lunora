/**
 * Module authoring API — `defineModule` marks a folder under `lunora/` as a
 * module, the unit the Studio's module catalog and architecture diagram group
 * by. A folder is a module when it holds a `module.ts` whose default export is
 * a `defineModule(...)` call; every source file beneath it belongs to that
 * module. The module name is the folder name.
 *
 * Metadata only: modules change no `api.*` path, no dispatch path and nothing
 * at runtime — the whole app still deploys as one Worker. `@lunora/codegen`
 * reads the literals statically, so `description` and `tables` must be written
 * inline.
 */

/** The config passed to {@link defineModule}. */
interface ModuleConfig {
    /** One line shown in the Studio module catalog. */
    description?: string;

    /**
     * Tables this module owns. A function in another module writing one of
     * them is reported by the `cross_module_table_write` advisor lint. Omit to
     * declare no ownership (the lint then stays silent for this module).
     */
    tables?: ReadonlyArray<string>;
}

/** The branded result of {@link defineModule}, discovered by codegen. */
interface ModuleDefinition extends ModuleConfig {
    /** Runtime brand identifying a `defineModule` result. */
    readonly isLunoraModule: true;
}

/**
 * Declare the module a `lunora/<folder>/module.ts` file stands for:
 *
 * ```ts
 * // lunora/billing/module.ts
 * import { defineModule } from "@lunora/server";
 *
 * export default defineModule({ description: "Invoices and payments", tables: ["invoices", "payments"] });
 * ```
 */
const defineModule = (config: ModuleConfig = {}): ModuleDefinition => {
    if (config.description !== undefined && typeof config.description !== "string") {
        throw new TypeError("defineModule: `description` must be a string when provided");
    }

    if (config.tables !== undefined && (!Array.isArray(config.tables) || config.tables.some((table) => typeof table !== "string" || table.length === 0))) {
        throw new TypeError("defineModule: `tables` must be an array of non-empty table names when provided");
    }

    return { ...config, isLunoraModule: true };
};

export type { ModuleConfig, ModuleDefinition };
export { defineModule };
