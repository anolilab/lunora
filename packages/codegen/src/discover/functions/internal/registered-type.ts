import type { SourceFile, Type } from "ts-morph";
import { Node } from "ts-morph";

const PROCEDURE_KINDS = new Set(["action", "mutation", "query", "stream"]);

/** The string literal a property of `type` is declared as, or `undefined` when it is absent or not one literal. */
const literalProperty = (type: Type, name: string, at: Node): string | undefined => {
    const propertyType = type.getProperty(name)?.getTypeAtLocation(at);

    if (propertyType === undefined) {
        return undefined;
    }

    const members = propertyType.isUnion() ? propertyType.getUnionTypes().filter((member) => !member.isUndefined()) : [propertyType];
    const value = members.length === 1 ? members[0]?.getLiteralValue() : undefined;

    return typeof value === "string" ? value : undefined;
};

/** The procedure kind of a registered-function type, or `undefined` when `type` is not one. */
const registeredKindOf = (type: Type, at: Node): string | undefined => {
    const kind = literalProperty(type, "kind", at);

    return kind !== undefined && PROCEDURE_KINDS.has(kind) && type.getProperty("handler") !== undefined ? kind : undefined;
};

/** Whether `reference` reads its value's `functions`: `x.functions`, `x["functions"]`, or `const { functions } = x`. */
const readsFunctions = (reference: Node): boolean => {
    const parent = reference.getParent();

    if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === reference) {
        return parent.getName() === "functions";
    }

    if (Node.isElementAccessExpression(parent) && parent.getExpression() === reference) {
        const argument = parent.getArgumentExpression();

        return argument !== undefined && Node.isStringLiteral(argument) && argument.getLiteralValue() === "functions";
    }

    // A reference whose parent is a declaration and is not its name is that declaration's initializer.
    const pattern = Node.isVariableDeclaration(parent) && parent.getNameNode() !== reference ? parent.getNameNode() : undefined;

    return (
        pattern !== undefined &&
        Node.isObjectBindingPattern(pattern) &&
        pattern.getElements().some((element) => (element.getPropertyNameNode()?.getText() ?? element.getName()) === "functions")
    );
};

/**
 * Warn about an exported component whose `functions` are never read anywhere in
 * the project: `export const presence = definePresence()` with no
 * `presence.functions` re-export registers nothing, and the generated `api`
 * silently lacks every function it ships.
 *
 * A warning, not automatic registration: the export is needed for
 * `.extend(presence.extension)` alone, and an app that wraps the functions (a
 * rate limit) re-exports the wrapper, so exposing the raw ones would bypass it.
 */
const warnUnwiredComponents = (sources: ReadonlyArray<SourceFile>, relativePathOf: (source: SourceFile) => string): void => {
    for (const source of sources) {
        for (const declaration of source.getVariableDeclarations()) {
            const nameNode = declaration.getNameNode();

            if (!declaration.isExported() || !Node.isIdentifier(nameNode)) {
                continue;
            }

            const functionsType = declaration.getType().getProperty("functions")?.getTypeAtLocation(declaration);
            const shipped = (functionsType?.getProperties() ?? []).filter(
                (property) => registeredKindOf(property.getTypeAtLocation(declaration), declaration) !== undefined,
            );

            if (shipped.length === 0) {
                continue;
            }

            const read = nameNode.findReferencesAsNodes().some((reference) => readsFunctions(reference));

            if (read) {
                continue;
            }

            const name = declaration.getName();
            const names = shipped.map((property) => property.getName()).join(", ");

            // eslint-disable-next-line no-console -- codegen surfaces a clear, actionable warning when a component's functions go unregistered.
            console.warn(
                `@lunora/codegen: ${relativePathOf(source)}:${name} ships functions (${names}) that nothing re-exports, so none is in the generated api. ` +
                    `Add \`export const { ${names} } = ${name}.functions;\` (or export your own wrappers of them).`,
            );
        }
    }
};

export { literalProperty, registeredKindOf, warnUnwiredComponents };
