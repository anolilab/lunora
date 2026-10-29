import type { BindingElement, Node as AstNode } from "ts-morph";
import { Node, SyntaxKind, VariableDeclarationKind } from "ts-morph";

import { isServerSurfaceModule } from "../../../module-specifiers";
import { walkBuilderChain } from "../../builder-chain";

const FACTORIES = new Set(["action", "internalAction", "internalMutation", "internalQuery", "mutation", "query", "stream"]);

const surfaceImportName = (root: AstNode): string | undefined => {
    if (Node.isIdentifier(root)) {
        for (const declaration of root.getSymbol()?.getDeclarations() ?? []) {
            if (Node.isImportSpecifier(declaration) && isServerSurfaceModule(declaration.getImportDeclaration().getModuleSpecifierValue())) {
                return declaration.getName();
            }
        }
    }

    if (Node.isPropertyAccessExpression(root)) {
        const namespace = root.getExpression();

        if (Node.isIdentifier(namespace)) {
            const imported = namespace
                .getSymbol()
                ?.getDeclarations()
                .some(
                    (declaration) =>
                        Node.isNamespaceImport(declaration) &&
                        isServerSurfaceModule(declaration.getFirstAncestorByKindOrThrow(SyntaxKind.ImportDeclaration).getModuleSpecifierValue()),
                );

            return imported ? root.getName() : undefined;
        }
    }

    return undefined;
};

const destructuredFactory = (binding: BindingElement): string | undefined => {
    const pattern = binding.getParent();
    const declaration = pattern.getParent();
    const name = binding.getPropertyNameNode() ?? binding.getNameNode();

    if (
        !Node.isObjectBindingPattern(pattern) ||
        !Node.isVariableDeclaration(declaration) ||
        declaration.getVariableStatement()?.getDeclarationKind() !== VariableDeclarationKind.Const ||
        binding.getDotDotDotToken() ||
        binding.getInitializer() ||
        !Node.isIdentifier(name) ||
        !FACTORIES.has(name.getText()) ||
        // `initLunora.create()` returns query/action/mutation roots; stream is a query terminal.
        name.getText() === "stream"
    ) {
        return undefined;
    }

    const initializer = declaration.getInitializer();

    if (!initializer) {
        return undefined;
    }

    const { root, steps } = walkBuilderChain(initializer);

    // create() returns fresh roots; no user-defined wrapper or extra step may hide metadata.
    return root && surfaceImportName(root) === "initLunora" && steps.length === 2 && steps[0]?.name === "create" && steps[1]?.name === "dataModel"
        ? name.getText()
        : undefined;
};

const resolveStaticRoot = (root: AstNode): { factory?: string; initializer?: AstNode } => {
    const imported = surfaceImportName(root);

    if (imported) {
        return FACTORIES.has(imported) ? { factory: imported } : {};
    }

    if (!Node.isIdentifier(root)) {
        return {};
    }

    const symbol = root.getSymbol();
    const declaration = (symbol?.isAlias() ? symbol.getAliasedSymbol() : symbol)?.getValueDeclaration();

    if (declaration && Node.isBindingElement(declaration)) {
        return { factory: destructuredFactory(declaration) };
    }

    if (declaration && Node.isVariableDeclaration(declaration) && declaration.getVariableStatement()?.getDeclarationKind() === VariableDeclarationKind.Const) {
        return { initializer: declaration.getInitializer() };
    }

    return {};
};

/** Resolve immutable aliases without trusting a type assertion or an identifier's spelling. */
const staticBuilderChain = (receiver: AstNode): { factory?: string; steps: ReturnType<typeof walkBuilderChain>["steps"] } => {
    const steps: ReturnType<typeof walkBuilderChain>["steps"] = [];
    const visited = new Set<AstNode>();
    let current: AstNode | undefined = receiver;

    while (current !== undefined) {
        if (visited.has(current)) {
            break;
        }

        visited.add(current);
        const walked = walkBuilderChain(current);
        steps.push(...walked.steps);

        if (!walked.root) {
            break;
        }

        const { factory, initializer } = resolveStaticRoot(walked.root);

        if (factory) {
            return { factory, steps };
        }

        current = initializer;
    }

    return { steps };
};

export default staticBuilderChain;
