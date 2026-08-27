import { existsSync } from "node:fs";
import { join } from "node:path";

import { containerBindingName, containerClassName, normalizeContainerImage } from "@lunora/container";
import type { CallExpression, Expression, Identifier, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "./diagnostics";
import { stringPropertyFor } from "./discover-ast";
import type { ContainerIR } from "./ir";

/** The only file containers may be declared in — mirrors `lunora/crons.ts`. */
const CONTAINERS_FILENAME = "containers.ts";

/**
 * Decide whether a callee identifier refers to `defineContainer` from
 * `@lunora/container`. Mirrors `isCronJobsFactory`: trust the import
 * declaration when the checker has a symbol (so aliasing survives), and fall
 * back to the surface text when no symbol is available.
 */
const isDefineContainer = (identifier: Identifier): boolean => {
    const symbol = identifier.getSymbol();

    if (!symbol) {
        return identifier.getText() === "defineContainer";
    }

    for (const declaration of symbol.getDeclarations()) {
        if (!Node.isImportSpecifier(declaration)) {
            continue;
        }

        if (declaration.getImportDeclaration().getModuleSpecifierValue() !== "@lunora/container") {
            return false;
        }

        return declaration.getNameNode().getText() === "defineContainer";
    }

    return false;
};

/** Read a property's string-literal value, or throw a located diagnostic. */
const stringProperty = stringPropertyFor("container");

/** Read a property's numeric-literal value, or throw a located diagnostic. */
const numberProperty = (expression: Expression, exportName: string, property: string): number => {
    if (Node.isNumericLiteral(expression)) {
        return expression.getLiteralValue();
    }

    throw diagnosticAt(
        expression,
        `container "${exportName}": \`${property}\` must be a static number literal — it is deploy configuration codegen writes into wrangler.jsonc`,
    );
};

/** Lift the `image` property into the normalized IR shape. */
const imageFromExpression = (expression: Expression, exportName: string): ContainerIR["image"] => {
    if (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) {
        return normalizeContainerImage(expression.getLiteralValue());
    }

    if (Node.isObjectLiteralExpression(expression)) {
        const registry = expression.getProperty("registry");

        if (registry && Node.isPropertyAssignment(registry)) {
            const initializer = registry.getInitializerOrThrow();

            return normalizeContainerImage({ registry: stringProperty(initializer, exportName, "image.registry") });
        }

        const build = expression.getProperty("build");

        if (build && Node.isPropertyAssignment(build)) {
            const initializer = build.getInitializerOrThrow();

            return normalizeContainerImage({ build: stringProperty(initializer, exportName, "image.build") });
        }
    }

    throw diagnosticAt(expression, `container "${exportName}": \`image\` must be a static string path, { registry: "…" }, or { build: "…" } literal`);
};

/** Lift an object literal of string-literal values (e.g. `buildArgs`), skipping non-literal entries. */
const stringRecordLiteral = (expression: Expression): Record<string, string> | undefined => {
    if (!Node.isObjectLiteralExpression(expression)) {
        return undefined;
    }

    const record: Record<string, string> = {};

    for (const property of expression.getProperties()) {
        if (!Node.isPropertyAssignment(property)) {
            continue;
        }

        const value = property.getInitializerOrThrow();

        if (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value)) {
            record[property.getName()] = value.getLiteralValue();
        }
    }

    return Object.keys(record).length > 0 ? record : undefined;
};

/** Lift the `rollout` object's numeric-literal fields. */
const rolloutLiteral = (expression: Expression): ContainerIR["rollout"] => {
    if (!Node.isObjectLiteralExpression(expression)) {
        return undefined;
    }

    const rollout: { gracePeriodSeconds?: number; stepPercentage?: number } = {};

    for (const property of expression.getProperties()) {
        if (!Node.isPropertyAssignment(property)) {
            continue;
        }

        const key = property.getName();
        const value = property.getInitializerOrThrow();

        if (Node.isNumericLiteral(value) && (key === "gracePeriodSeconds" || key === "stepPercentage")) {
            rollout[key] = value.getLiteralValue();
        }
    }

    return rollout.gracePeriodSeconds === undefined && rollout.stepPercentage === undefined ? undefined : rollout;
};

/** Read a boolean-literal property value, or `undefined` when it isn't a literal. */
const booleanLiteral = (expression: Expression): boolean | undefined => {
    if (Node.isTrueLiteral(expression)) {
        return true;
    }

    if (Node.isFalseLiteral(expression)) {
        return false;
    }

    return undefined;
};

/** Read a string-or-number literal, or `undefined` when it isn't one. Lifts `sleepAfter` for the advisor. */
// eslint-disable-next-line sonarjs/function-return-type -- sleepAfter IS a string-or-number union, mirroring the platform field
const stringOrNumberLiteral = (expression: Expression): number | string | undefined => {
    if (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) {
        return expression.getLiteralValue();
    }

    if (Node.isNumericLiteral(expression)) {
        return expression.getLiteralValue();
    }

    return undefined;
};

/** Lift the `instanceType` property (named string or custom object literal). */
// eslint-disable-next-line sonarjs/function-return-type -- `instanceType` IS a string-or-object union, mirroring wrangler's field
const instanceTypeFromExpression = (expression: Expression, exportName: string): ContainerIR["instanceType"] => {
    if (Node.isStringLiteral(expression)) {
        return expression.getLiteralValue();
    }

    if (Node.isObjectLiteralExpression(expression)) {
        const custom: { diskMb?: number; memoryMib?: number; vcpu?: number } = {};

        for (const property of expression.getProperties()) {
            if (!Node.isPropertyAssignment(property)) {
                throw diagnosticAt(property, `container "${exportName}": \`instanceType\` must be an object of static number literals`);
            }

            const key = property.getName();

            if (key !== "diskMb" && key !== "memoryMib" && key !== "vcpu") {
                throw diagnosticAt(property, `container "${exportName}": unknown \`instanceType\` field "${key}" — expected vcpu, memoryMib, or diskMb`);
            }

            custom[key] = numberProperty(property.getInitializerOrThrow(), exportName, `instanceType.${key}`);
        }

        return custom;
    }

    throw diagnosticAt(expression, `container "${exportName}": \`instanceType\` must be a static string or { vcpu, memoryMib, diskMb } literal`);
};

/** Lift one exported `defineContainer({...})` declaration into {@link ContainerIR}. */
const containerFromCall = (call: CallExpression, exportName: string): ContainerIR => {
    const argument = call.getArguments()[0];

    if (!argument || !Node.isObjectLiteralExpression(argument)) {
        throw diagnosticAt(call, `container "${exportName}": defineContainer must be passed an inline object literal`);
    }

    const ir: ContainerIR = {
        bindingName: containerBindingName(exportName),
        className: containerClassName(exportName),
        exportName,
        image: { buildContext: ".", dockerfilePath: "./Dockerfile", kind: "dockerfile" },
    };

    let sawImage = false;

    for (const property of argument.getProperties()) {
        if (!Node.isPropertyAssignment(property)) {
            // Shorthand/spread for runtime-only fields is fine — the generated
            // class imports the definition object, so codegen doesn't need to
            // evaluate them. Only the wrangler-relevant fields below must be
            // static, and those are property assignments by construction here.
            continue;
        }

        const key = property.getName();
        const initializer = property.getInitializerOrThrow();

        switch (key) {
            case "buildArgs": {
                ir.buildArgs = stringRecordLiteral(initializer);

                break;
            }
            case "enableInternet": {
                // Lifted (when literal) for the advisor; the generated class
                // still reads the live value off the imported definition.
                ir.enableInternet = booleanLiteral(initializer);

                break;
            }
            case "image": {
                ir.image = imageFromExpression(initializer, exportName);
                sawImage = true;

                break;
            }
            case "instanceType": {
                ir.instanceType = instanceTypeFromExpression(initializer, exportName);

                break;
            }
            case "maxInstances": {
                ir.maxInstances = numberProperty(initializer, exportName, "maxInstances");

                break;
            }
            case "name": {
                ir.name = stringProperty(initializer, exportName, "name");

                break;
            }
            case "rollout": {
                ir.rollout = rolloutLiteral(initializer);

                break;
            }
            case "sleepAfter": {
                ir.sleepAfter = stringOrNumberLiteral(initializer);

                break;
            }
            default: {
                // Other runtime-only fields (defaultPort, env, secrets, …) are
                // evaluated by the generated class at runtime, not by codegen.
                break;
            }
        }
    }

    if (!sawImage) {
        throw diagnosticAt(argument, `container "${exportName}": defineContainer requires a static \`image\` property`);
    }

    return ir;
};

/** Collect exported `defineContainer` declarations from one source file. */
const containersFromSource = (source: SourceFile): ContainerIR[] => {
    const containers: ContainerIR[] = [];

    for (const declaration of source.getVariableDeclarations()) {
        if (!declaration.isExported()) {
            continue;
        }

        const initializer = declaration.getInitializer();

        if (initializer?.getKind() !== SyntaxKind.CallExpression) {
            continue;
        }

        const call = initializer as CallExpression;
        const callee = call.getExpression();

        if (!Node.isIdentifier(callee) || !isDefineContainer(callee)) {
            continue;
        }

        const nameNode = declaration.getNameNode();

        if (!Node.isIdentifier(nameNode)) {
            throw diagnosticAt(nameNode, "defineContainer exports must be plain named exports (no destructuring)");
        }

        containers.push(containerFromCall(call, nameNode.getText()));
    }

    return containers;
};

/**
 * Discover every container the project declares: exported `defineContainer()`
 * calls in `lunora/containers.ts`. Returns `[]` when the file doesn't exist.
 * Wrangler-relevant fields (`image`, `instanceType`, `maxInstances`, `name`)
 * must be static literals; runtime-only fields (`env`, `sleepAfter`, …) may be
 * any expression since the generated class imports the definition object.
 */
const discoverContainers = (project: Project, lunoraDirectory: string): ContainerIR[] => {
    const containersPath = join(lunoraDirectory, CONTAINERS_FILENAME);

    if (!existsSync(containersPath)) {
        return [];
    }

    const source = project.getSourceFile(containersPath) ?? project.addSourceFileAtPath(containersPath);
    const containers = containersFromSource(source);

    containers.sort((a, b) => a.exportName.localeCompare(b.exportName));

    return containers;
};

export { CONTAINERS_FILENAME, discoverContainers };
