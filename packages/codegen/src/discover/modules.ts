import { basename } from "node:path";

import type { Expression, ObjectLiteralExpression, Project } from "ts-morph";
import { Node } from "ts-morph";

import { moduleOf } from "../../../../shared/architecture-manifest";
import { diagnosticAt } from "../diagnostics";
import type { ModuleIR, SchemaIR } from "../ir";
import sanitizeNamespace from "../paths";
import { defaultExportExpression, findObjectProperty, listLunoraSourceFiles, lunoraRelativePath, unwrapToCallExpression } from "./ast";

/** The marker file that makes its folder a module. */
const MODULE_FILENAME = "module.ts";

/** A static string literal's value, or a located diagnostic naming the property. */
const literalString = (expression: Expression, moduleName: string, property: string): string => {
    if (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) {
        return expression.getLiteralValue();
    }

    throw diagnosticAt(expression, `module "${moduleName}": \`${property}\` must be a static string literal — codegen reads it without running the file`);
};

/** A `[ "a", "b" ]` literal of static strings, or a located diagnostic. */
const literalStringArray = (expression: Expression, moduleName: string, property: string): string[] => {
    if (!Node.isArrayLiteralExpression(expression)) {
        throw diagnosticAt(expression, `module "${moduleName}": \`${property}\` must be an inline array of table names`);
    }

    return expression.getElements().map((element) => literalString(element, moduleName, property));
};

/**
 * The initializer of a `key: value` property, `undefined` when the key is absent.
 * A shorthand (`{ tables }`) or spread is rejected rather than skipped: skipping
 * it would silently drop the ownership the app declared.
 */
const propertyValue = (config: ObjectLiteralExpression, key: string, moduleName: string): Expression | undefined => {
    const property = findObjectProperty(config, key);

    if (property === undefined) {
        return undefined;
    }

    if (!Node.isPropertyAssignment(property)) {
        throw diagnosticAt(property, `module "${moduleName}": write \`${key}\` inline as \`${key}: …\` — codegen reads it without running the file`);
    }

    return property.getInitializerOrThrow();
};

/**
 * Lift one `module.ts` into {@link ModuleIR}, or `undefined` when its default
 * export is not a `defineModule(...)` call — a file that merely happens to be
 * called `module.ts` (holding ordinary queries, say) declares no module.
 */
const moduleFromFile = (project: Project, path: string, name: string): ModuleIR | undefined => {
    const source = project.getSourceFile(path) ?? project.addSourceFileAtPath(path);
    const call = unwrapToCallExpression(defaultExportExpression(source));
    const callee = call?.getExpression();

    if (!call || !callee || !Node.isIdentifier(callee) || callee.getText() !== "defineModule") {
        return undefined;
    }

    if (name === "") {
        throw diagnosticAt(
            call,
            "defineModule: lunora/module.ts would make the whole app one module — move it into the folder it describes (lunora/<module>/module.ts)",
        );
    }

    const config = call.getArguments()[0];
    const ir: ModuleIR = { name, tables: [] };

    if (config === undefined) {
        return ir;
    }

    if (!Node.isObjectLiteralExpression(config)) {
        throw diagnosticAt(config, `module "${name}": defineModule must be passed an inline object literal`);
    }

    const description = propertyValue(config, "description", name);

    if (description !== undefined) {
        ir.description = literalString(description, name, "description");
    }

    const tables = propertyValue(config, "tables", name);

    if (tables !== undefined) {
        ir.tables = literalStringArray(tables, name, "tables");
    }

    return ir;
};

/**
 * Discover every declared module: a folder under `lunora/` whose `module.ts`
 * default-exports `defineModule(...)`. The module's name is its folder path
 * relative to `lunora/` (`billing`, or `domains/billing` for a nested folder).
 * Validation happens in {@link resolveModules}, once installed components join.
 */
const discoverModules = (project: Project, lunoraDirectory: string): ModuleIR[] => {
    const modules: ModuleIR[] = [];

    for (const path of listLunoraSourceFiles(lunoraDirectory)) {
        if (basename(path) !== MODULE_FILENAME) {
            continue;
        }

        const relative = lunoraRelativePath(lunoraDirectory, path);
        const discovered = moduleFromFile(project, path, relative === "module" ? "" : relative.slice(0, -"/module".length));

        if (discovered) {
            modules.push(discovered);
        }
    }

    return modules.toSorted((a, b) => a.name.localeCompare(b.name));
};

/**
 * The declared modules with each installed component merged in. Precedence, so
 * every table and folder has one owner: a declared module of the component's
 * name absorbs the component's tables; a table a declared module lists stays
 * with it; otherwise the component owns its prefixed tables (`voting_*`), plus
 * the `lunora/<key>/` folder when it is a registry copy-in. A package
 * component's code is in `node_modules`, so an app folder of its name stays the
 * app's.
 */
const mergeInstalledComponents = (declared: ReadonlyArray<ModuleIR>, schema: SchemaIR): ModuleIR[] => {
    const names = new Set(declared.map((entry) => entry.name));
    const claimed = new Set(declared.flatMap((entry) => entry.tables));
    const unclaimed = schema.tables.filter((table) => table.extensionKey !== undefined && !claimed.has(table.name));
    const components = Map.groupBy(unclaimed, (table) => String(table.extensionKey));

    const merged = declared.map((entry) => {
        const absorbed = components.get(entry.name);

        return absorbed === undefined ? entry : { ...entry, tables: [...entry.tables, ...absorbed.map((table) => table.name)] };
    });
    const installed = [...components]
        .filter(([key]) => !names.has(key))
        .map(([key, tables]): ModuleIR => {
            const fromPackage = tables.every((table) => table.extensionFromPackage === true);

            return { installed: true, name: key, ...(fromPackage ? { ownsFolder: false as const } : {}), tables: tables.map((table) => table.name) };
        });

    return [...merged, ...installed].toSorted((a, b) => a.name.localeCompare(b.name));
};

/** Reject a module nested inside another (a component counts): a file belongs to one module. */
const assertNoNesting = (modules: ReadonlyArray<ModuleIR>): void => {
    for (const outer of modules) {
        const inner = modules.find((candidate) => candidate.name.startsWith(`${outer.name}/`));

        if (inner) {
            throw new Error(
                `@lunora/codegen: module "${inner.name}" is nested inside ${outer.installed === true ? "installed component" : "module"} "${outer.name}" — a file can belong to one module only, so move one of the two`,
            );
        }
    }
};

/** Reject a table two modules claim, or one the schema does not define. */
const assertTableClaims = (modules: ReadonlyArray<ModuleIR>, schema: SchemaIR): void => {
    const known = new Set(schema.tables.map((table) => table.name));
    const owners = new Map<string, string>();

    for (const entry of modules) {
        for (const table of entry.tables) {
            if (!known.has(table)) {
                throw new Error(`@lunora/codegen: module "${entry.name}" declares table "${table}", which lunora/schema.ts does not define`);
            }

            const prior = owners.get(table);

            if (prior !== undefined) {
                throw new Error(`@lunora/codegen: table "${table}" is claimed by both module "${prior}" and module "${entry.name}" — a table has one owner`);
            }

            owners.set(table, entry.name);
        }
    }
};

/**
 * Reject a file outside a module whose api namespace equals that module's name
 * (`lunora/billing.ts` beside `lunora/billing/`). Only once the app declares a
 * module do the specs tag by module, so only then would the two share a tag.
 */
const assertNoTagCollision = (declared: ReadonlyArray<ModuleIR>, modules: ReadonlyArray<ModuleIR>, sourceFiles: ReadonlyArray<string>): void => {
    if (declared.length === 0) {
        return;
    }

    const tagged = new Set(modules.map((entry) => entry.name));

    for (const file of sourceFiles) {
        const namespace = sanitizeNamespace(file);

        if (moduleOf(modules, file) === undefined && tagged.has(namespace)) {
            throw new Error(
                `@lunora/codegen: lunora/${file}.ts sits beside module "${namespace}" and shares its name — move it into lunora/${namespace}/ or rename one of them`,
            );
        }
    }
};

/**
 * Every module the app has — the declared ones plus one per installed component
 * (see {@link mergeInstalledComponents}) — validated together before any
 * consumer reads them, so ownership is never ambiguous downstream.
 */
const resolveModules = (declared: ReadonlyArray<ModuleIR>, schema: SchemaIR, sourceFiles: ReadonlyArray<string>): ModuleIR[] => {
    const modules = mergeInstalledComponents(declared, schema);

    assertNoNesting(modules);
    assertTableClaims(modules, schema);
    assertNoTagCollision(declared, modules, sourceFiles);

    return modules;
};

/**
 * The OpenAPI / OpenRPC tag for an operation declared in `filePath`: its module,
 * or its file namespace outside every module ({@link resolveModules} keeps the
 * two from colliding).
 */
const moduleTagOf = (modules: ReadonlyArray<ModuleIR>, filePath: string): string => moduleOf(modules, filePath) ?? sanitizeNamespace(filePath);

export { discoverModules, MODULE_FILENAME, moduleTagOf, resolveModules };
