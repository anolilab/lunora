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
const literalString = (expression: Expression, module: string, property: string): string => {
    if (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) {
        return expression.getLiteralValue();
    }

    throw diagnosticAt(expression, `module "${module}": \`${property}\` must be a static string literal — codegen reads it without running the file`);
};

/** A `[ "a", "b" ]` literal of static strings, or a located diagnostic. */
const literalStringArray = (expression: Expression, module: string, property: string): string[] => {
    if (!Node.isArrayLiteralExpression(expression)) {
        throw diagnosticAt(expression, `module "${module}": \`${property}\` must be an inline array of table names`);
    }

    return expression.getElements().map((element) => literalString(element, module, property));
};

/**
 * The initializer of a `key: value` property, `undefined` when the key is absent.
 * A shorthand (`{ tables }`) or spread is rejected rather than skipped: skipping
 * it would silently drop the ownership the app declared.
 */
const propertyValue = (config: ObjectLiteralExpression, key: string, module: string): Expression | undefined => {
    const property = findObjectProperty(config, key);

    if (property === undefined) {
        return undefined;
    }

    if (!Node.isPropertyAssignment(property)) {
        throw diagnosticAt(property, `module "${module}": write \`${key}\` inline as \`${key}: …\` — codegen reads it without running the file`);
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
 * Discover every module: a folder under `lunora/` whose `module.ts` default-
 * exports `defineModule(...)`. The module's name is its folder path relative to
 * `lunora/` (`billing`, or `domains/billing` for a nested folder). Modules do not
 * nest — a module folder inside another is an error, because a file would then
 * belong to two of them.
 */
const discoverModules = (project: Project, lunoraDirectory: string): ModuleIR[] => {
    const modules: ModuleIR[] = [];

    for (const path of listLunoraSourceFiles(lunoraDirectory)) {
        if (basename(path) !== MODULE_FILENAME) {
            continue;
        }

        const relative = lunoraRelativePath(lunoraDirectory, path);
        const module = moduleFromFile(project, path, relative === "module" ? "" : relative.slice(0, -"/module".length));

        if (module) {
            modules.push(module);
        }
    }

    modules.sort((a, b) => a.name.localeCompare(b.name));

    for (const outer of modules) {
        const inner = modules.find((candidate) => candidate.name.startsWith(`${outer.name}/`));

        if (inner) {
            throw new Error(
                `@lunora/codegen: module "${inner.name}" is nested inside module "${outer.name}" — a file can belong to one module only, so move one of the two module.ts files`,
            );
        }
    }

    return modules;
};

/**
 * The declared modules plus one implicit module per installed component — each
 * `defineSchemaExtension` key the schema merged — owning that component's tables
 * (`voting_*`) and the `lunora/<key>/` folder a registry item copies its code
 * into. A declared module of the same name absorbs the component instead, and a
 * table a declared module claims stays with that module.
 */
const withInstalledComponents = (modules: ReadonlyArray<ModuleIR>, schema: SchemaIR): ModuleIR[] => {
    const declared = new Map(modules.map((entry) => [entry.name, entry]));
    const claimed = new Set(modules.flatMap((entry) => entry.tables));
    const components = new Map<string, string[]>();

    for (const table of schema.tables) {
        if (table.extensionKey !== undefined && !claimed.has(table.name)) {
            components.set(table.extensionKey, [...(components.get(table.extensionKey) ?? []), table.name]);
        }
    }

    const merged = modules.map((entry) => {
        const absorbed = components.get(entry.name);

        return absorbed === undefined ? entry : { ...entry, tables: [...entry.tables, ...absorbed] };
    });
    const installed = [...components]
        .filter(([key]) => !declared.has(key))
        .map(([key, tables]): ModuleIR => {
            return { installed: true, name: key, tables };
        });

    return [...merged, ...installed].toSorted((a, b) => a.name.localeCompare(b.name));
};

/**
 * The OpenAPI / OpenRPC tag for an operation declared in `filePath`: its module,
 * or its file namespace outside every module.
 */
const moduleTagOf = (modules: ReadonlyArray<ModuleIR>, filePath: string): string => moduleOf(modules, filePath) ?? sanitizeNamespace(filePath);

export { discoverModules, MODULE_FILENAME, moduleTagOf, withInstalledComponents };
