import { existsSync } from "node:fs";
import { join } from "node:path";

import { containerBindingName, containerClassName, normalizeContainerImage } from "@lunora/container";
import type {
    CallExpression,
    Expression,
    Identifier,
    ObjectLiteralElementLike,
    ObjectLiteralExpression,
    Project,
    SourceFile,
    SpreadAssignment,
    Symbol as TsSymbol,
    Type,
} from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { diagnosticAt } from "../diagnostics";
import type { ContainerIR } from "../ir";
import { findObjectProperty, propertyKeyName, stringPropertyFor, symbolConstInitializer } from "./ast";

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
        const registry = findObjectProperty(expression, "registry");

        if (registry && Node.isPropertyAssignment(registry)) {
            const initializer = registry.getInitializerOrThrow();

            return normalizeContainerImage({ registry: stringProperty(initializer, exportName, "image.registry") });
        }

        const build = findObjectProperty(expression, "build");

        if (build && Node.isPropertyAssignment(build)) {
            const initializer = build.getInitializerOrThrow();

            return normalizeContainerImage({ build: stringProperty(initializer, exportName, "image.build") });
        }
    }

    throw diagnosticAt(expression, `container "${exportName}": \`image\` must be a static string path, { registry: "…" }, or { build: "…" } literal`);
};

/**
 * Keys codegen writes into wrangler.jsonc (`image`, `name`, `max_instances`,
 * `instance_type`, `image_vars`, `rollout_*`). Unlike the runtime-only fields
 * the generated class reads off the imported definition, these exist only if
 * codegen can read them — so one it cannot read is an error, never a skip.
 */
const WRANGLER_KEYS = new Set(["buildArgs", "image", "instanceType", "maxInstances", "name", "rollout"]);

/** The `rollout` keys codegen lifts into wrangler.jsonc. */
const ROLLOUT_KEYS = new Set(["gracePeriodSeconds", "stepPercentage"]);

/** `x as const`, `x satisfies T`, `<T>x` and `(x)` read as `x` — none changes the value wrangler would get. */
const unwrapTypeOnly = (expression: Expression): Expression => {
    let current = expression;

    while (Node.isAsExpression(current) || Node.isSatisfiesExpression(current) || Node.isTypeAssertion(current) || Node.isParenthesizedExpression(current)) {
        current = current.getExpression();
    }

    return current;
};

/**
 * Whether `identifier`'s binding is written through anywhere in its file:
 * `base.key = …` (any assignment operator), `base.key++`, `delete base.key`,
 * or `Object.assign(base, …)`. A `const` object literal written that way has
 * a runtime value its initializer does not show, so reading the initializer
 * would put a different number in wrangler.jsonc than the one the app runs.
 */
const isWrittenThrough = (symbol: TsSymbol, sourceFile: SourceFile): boolean => {
    const rootOf = (target: Node): Node | undefined => {
        let current: Node = target;

        while (Node.isPropertyAccessExpression(current) || Node.isElementAccessExpression(current) || Node.isParenthesizedExpression(current)) {
            current = current.getExpression();
        }

        return current === target ? undefined : current;
    };
    const namesBinding = (node: Node | undefined): boolean => node !== undefined && Node.isIdentifier(node) && node.getSymbol() === symbol;

    return sourceFile.getDescendants().some((node) => {
        if (Node.isBinaryExpression(node)) {
            const operator = node.getOperatorToken().getKind();

            return operator >= SyntaxKind.FirstAssignment && operator <= SyntaxKind.LastAssignment && namesBinding(rootOf(node.getLeft()));
        }

        if (Node.isPrefixUnaryExpression(node) || Node.isPostfixUnaryExpression(node)) {
            const operator = node.getOperatorToken();

            return (operator === SyntaxKind.PlusPlusToken || operator === SyntaxKind.MinusMinusToken) && namesBinding(rootOf(node.getOperand()));
        }

        if (Node.isDeleteExpression(node)) {
            return namesBinding(rootOf(node.getExpression()));
        }

        return Node.isCallExpression(node) && node.getExpression().getText() === "Object.assign" && namesBinding(node.getArguments()[0]);
    });
};

/** How many `const a = b; const b = c; …` hops {@link resolveBinding} follows before giving up. */
const MAX_ALIAS_HOPS = 16;

/**
 * The value a module-scope `const` binding holds, followed through
 * `const a = b` aliases and type-only wrappers until it is not a const
 * identifier; `undefined` when `symbol` is not a module-scope `const`. A const
 * object that is written through elsewhere in its file is refused — its
 * initializer is not the value the container runs with. `at` locates that
 * error; `name` is the binding's spelling for it.
 */
const resolveBinding = (symbol: TsSymbol | undefined, at: Node, name: string, what: string): Expression | undefined => {
    let current: { name: string; symbol: TsSymbol | undefined } = { name, symbol };
    let value: Expression | undefined;

    for (let hop = 0; hop < MAX_ALIAS_HOPS; hop += 1) {
        const initializer = symbolConstInitializer(current.symbol);

        if (initializer === undefined || !Node.isExpression(initializer)) {
            return value;
        }

        value = unwrapTypeOnly(initializer);

        if (Node.isObjectLiteralExpression(value) && current.symbol !== undefined && isWrittenThrough(current.symbol, at.getSourceFile())) {
            throw diagnosticAt(
                at,
                `${what}: \`${current.name}\` is a const object that is written to elsewhere in this file, so its initializer is not the value the container runs with. Declare the settings where they are final.`,
            );
        }

        if (!Node.isIdentifier(value)) {
            return value;
        }

        current = { name: value.getText(), symbol: value.getSymbol() };
    }

    return value;
};

/**
 * An identifier naming a module-scope `const` reads as that const's value
 * (see {@link resolveBinding}); anything else as itself, type-only wrappers
 * unwrapped.
 */
const resolveConstant = (expression: Expression, what: string): Expression => {
    const bare = unwrapTypeOnly(expression);

    return Node.isIdentifier(bare) ? (resolveBinding(bare.getSymbol(), bare, bare.getText(), what) ?? bare) : bare;
};

/** Every property a type can carry: `T | undefined` reads as `T`, a union as all of its members' keys. */
const typePropertyNames = (type: Type): string[] => {
    const nonNullable = type.getNonNullableType();
    const members = nonNullable.isUnion() ? nonNullable.getUnionTypes() : [nonNullable];

    return members.flatMap((member) =>
        member
            .getApparentType()
            .getProperties()
            .map((symbol) => symbol.getName()),
    );
};

/**
 * The `[key, value]` entries an object literal statically declares, in source
 * order (a later entry overrides an earlier one, as at runtime).
 *
 * `{ maxInstances }` and `{ ...base }` are ordinary ways to write an options
 * object, and this reader used to skip both — so a container declared with a
 * shorthand `maxInstances` deployed with no `max_instances` and no error. A
 * shorthand or spread now resolves through a module-scope `const`; one that
 * does not resolve is a located diagnostic when it can carry a key in `guarded`
 * (a spread's keys come from its type), and is left to the runtime otherwise.
 */
/** Which keys an unreadable member may not hide: a fixed set, or every key (`buildArgs`, where each one is an `image_vars` entry). */
type GuardedKeys = ReadonlySet<string> | "every";

/**
 * Throw when a spread `staticEntries` could not resolve may set a guarded key.
 * Its keys come from its type; a record-typed spread names none, so under
 * `"every"` it is refused outright rather than read through an empty key list.
 */
const assertOpaqueSpreadSafe = (property: SpreadAssignment, guarded: GuardedKeys, what: string): void => {
    const type = property.getExpression().getType();
    // `any` / `unknown` name no keys, and neither says it cannot carry one — so
    // they are refused outright, like a record-typed spread under "every".
    const hidden =
        guarded === "every" || type.isAny() || type.isUnknown()
            ? ["its keys"]
            : [...new Set(typePropertyNames(type))].filter((key) => guarded.has(key)).map((key) => `\`${key}\``);

    if (hidden.length > 0) {
        throw diagnosticAt(
            property,
            `${what}: this spread can set ${hidden.join(", ")}, which codegen writes into wrangler.jsonc and so must read statically. Spread a module-scope \`const\` object literal, or write the keys inline.`,
        );
    }
};

/**
 * The entry a shorthand / method / accessor member contributes: a shorthand
 * naming a module-scope `const` reads as its initializer; anything else is
 * `undefined`, and an error when its key is guarded.
 */
const unreadableMemberEntry = (
    property: Exclude<ObjectLiteralElementLike, SpreadAssignment>,
    guarded: GuardedKeys,
    what: string,
): [string, Expression] | undefined => {
    const key = propertyKeyName(property);
    // The same resolution an explicit `{ key: name }` gets, so `{ maxInstances }`
    // over `const maxInstances = LIMIT` reads LIMIT's value, not the identifier.
    const value = Node.isShorthandPropertyAssignment(property) ? resolveBinding(property.getValueSymbol(), property, key, what) : undefined;

    if (value !== undefined) {
        return [key, value];
    }

    if (guarded === "every" || guarded.has(key)) {
        throw diagnosticAt(
            property,
            `${what}: \`${key}\` is deploy configuration codegen writes into wrangler.jsonc, so it must be a static literal — inline it, or name a module-scope \`const\` initialized with one.`,
        );
    }

    return undefined;
};

const staticEntries = (
    object: ObjectLiteralExpression,
    guarded: GuardedKeys,
    what: string,
    visiting: ReadonlySet<ObjectLiteralExpression> = new Set(),
): [string, Expression][] => {
    const entries: [string, Expression][] = [];
    const path = new Set(visiting).add(object);

    for (const property of object.getProperties()) {
        if (Node.isPropertyAssignment(property)) {
            entries.push([propertyKeyName(property), resolveConstant(property.getInitializerOrThrow(), what)]);
        } else if (Node.isSpreadAssignment(property)) {
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion: a spread of a const object literal re-enters staticEntries
            entries.push(...spreadEntries(property, guarded, what, path));
        } else {
            const entry = unreadableMemberEntry(property, guarded, what);

            if (entry !== undefined) {
                entries.push(entry);
            }
        }
    }

    return entries;
};

/**
 * The entries a spread contributes: those of the module-scope `const` object
 * literal it names, or none from an opaque spread that cannot carry a guarded
 * key (see {@link assertOpaqueSpreadSafe}). `path` holds the literals already
 * being read, so a spread cycle is an error rather than a stack overflow.
 */
const spreadEntries = (property: SpreadAssignment, guarded: GuardedKeys, what: string, path: ReadonlySet<ObjectLiteralExpression>): [string, Expression][] => {
    const spread = resolveConstant(property.getExpression(), what);

    if (!Node.isObjectLiteralExpression(spread)) {
        assertOpaqueSpreadSafe(property, guarded, what);

        return [];
    }

    if (path.has(spread)) {
        // `const a = { ...b }; const b = { ...a }` — only typeable through `any`,
        // and it has no value at runtime (one initializer reads the other
        // before it exists).
        throw diagnosticAt(property, `${what}: this spread refers back to an object it is part of, so it has no static value.`);
    }

    return staticEntries(spread, guarded, what, path);
};

/** Lift `buildArgs` — an object of static string values, each becoming a wrangler `image_vars` entry. */
const stringRecordLiteral = (expression: Expression, exportName: string): Record<string, string> | undefined => {
    if (!Node.isObjectLiteralExpression(expression)) {
        throw diagnosticAt(
            expression,
            `container "${exportName}": \`buildArgs\` must be a static object literal — it is deploy configuration codegen writes into wrangler.jsonc`,
        );
    }

    const record: Record<string, string> = {};

    for (const [key, value] of staticEntries(expression, "every", `container "${exportName}" buildArgs`)) {
        record[key] = stringProperty(value, exportName, `buildArgs.${key}`);
    }

    return Object.keys(record).length > 0 ? record : undefined;
};

/** Lift the `rollout` object's `gracePeriodSeconds` / `stepPercentage` (static numbers; other keys are runtime-only). */
const rolloutLiteral = (expression: Expression, exportName: string): ContainerIR["rollout"] => {
    if (!Node.isObjectLiteralExpression(expression)) {
        throw diagnosticAt(
            expression,
            `container "${exportName}": \`rollout\` must be a static object literal — it is deploy configuration codegen writes into wrangler.jsonc`,
        );
    }

    const rollout: { gracePeriodSeconds?: number; stepPercentage?: number } = {};

    for (const [key, value] of staticEntries(expression, ROLLOUT_KEYS, `container "${exportName}" rollout`)) {
        if (key === "gracePeriodSeconds" || key === "stepPercentage") {
            rollout[key] = numberProperty(value, exportName, `rollout.${key}`);
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

            const key = propertyKeyName(property);

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

    for (const [key, initializer] of staticEntries(argument, WRANGLER_KEYS, `container "${exportName}"`)) {
        switch (key) {
            case "buildArgs": {
                ir.buildArgs = stringRecordLiteral(initializer, exportName);

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
                ir.rollout = rolloutLiteral(initializer, exportName);

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
    // `containerBindingName` upper-snakes the export name, so `imageResizer` and
    // `image_resizer` both become CONTAINER_IMAGE_RESIZER — two Durable Object
    // bindings under one name in wrangler.jsonc, one silently shadowing the other.
    const exportByBinding = new Map<string, string>();

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

        const container = containerFromCall(call, nameNode.getText());
        const clash = exportByBinding.get(container.bindingName);

        if (clash !== undefined) {
            throw diagnosticAt(
                nameNode,
                `containers "${clash}" and "${container.exportName}" both map to the binding ${container.bindingName} — rename one so each container gets its own Durable Object binding`,
            );
        }

        exportByBinding.set(container.bindingName, container.exportName);
        containers.push(container);
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
