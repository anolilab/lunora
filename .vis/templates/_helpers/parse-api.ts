/**
 * Reader for a generated `lunora/_generated/api.ts`: enumerate each function's
 * namespace, kind (query/mutation/action), and argument names. The
 * `lunora-collections` generator uses this to verify a table's `list` query
 * exists and to emit a correct `toArgs` from its insert mutation's real args.
 */
import type { PropertySignature, TypeLiteralNode, TypeReferenceNode } from "ts-morph";
import { Project, SyntaxKind } from "ts-morph";

export interface ApiFunction {
    args: string[];
    kind: string;
    name: string;
}

export interface ApiNamespace {
    functions: ApiFunction[];
    name: string;
}

/** Parse the `ApiTypes` interface out of a generated `api.ts` source string. */
export const parseApiNamespaces = (source: string): ApiNamespace[] => {
    const project = new Project({ compilerOptions: { allowJs: true }, useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("api.ts", source, { overwrite: true });
    const apiInterface = sourceFile.getInterface("ApiTypes");

    if (!apiInterface) {
        return [];
    }

    const namespaces: ApiNamespace[] = [];

    for (const namespaceProperty of apiInterface.getProperties()) {
        const namespaceType = namespaceProperty.getTypeNode();

        if (namespaceType?.getKind() !== SyntaxKind.TypeLiteral) {
            continue;
        }

        const functions: ApiFunction[] = [];

        for (const member of (namespaceType as TypeLiteralNode).getMembers()) {
            if (member.getKind() !== SyntaxKind.PropertySignature) {
                continue;
            }

            const functionType = (member as PropertySignature).getTypeNode();

            if (functionType?.getKind() !== SyntaxKind.TypeReference) {
                continue;
            }

            const typeArguments = (functionType as TypeReferenceNode).getTypeArguments();
            const kind = typeArguments[0]?.getText().replaceAll(/["']/g, "") ?? "";
            const argumentsNode = typeArguments[1];
            const args: string[] = [];

            if (argumentsNode?.getKind() === SyntaxKind.TypeLiteral) {
                for (const argument of (argumentsNode as TypeLiteralNode).getMembers()) {
                    if (argument.getKind() === SyntaxKind.PropertySignature) {
                        args.push((argument as PropertySignature).getName().replaceAll(/["']/g, ""));
                    }
                }
            }

            functions.push({ args, kind, name: (member as PropertySignature).getName() });
        }

        namespaces.push({ functions, name: namespaceProperty.getName() });
    }

    return namespaces;
};
