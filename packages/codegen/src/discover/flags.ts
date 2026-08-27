import { existsSync } from "node:fs";
import { join } from "node:path";

import type { CallExpression, Identifier, Node as TsNode, ObjectLiteralExpression, Project } from "ts-morph";
import { Node } from "ts-morph";

import type { FlagsIR } from "../ir";
import { defaultExportExpression, propertyInitializer } from "./ast";

/** The only file a feature-flag provider may be declared in — mirrors `lunora/queues.ts`. */
const FLAGS_FILENAME = "flags.ts";

/** The `@lunora/flags` subpath exporting the first-class Flagship provider factory. */
const FLAGSHIP_PROVIDER_MODULE = "@lunora/flags/providers/flagship";

/**
 * Decide whether a callee identifier refers to `flagshipProvider` from
 * `@lunora/flags/providers/flagship`. Mirrors `isDefineQueue`: trust the import
 * declaration when the checker has a symbol (so aliasing survives), and fall
 * back to the surface text when no symbol is available (a bare in-memory
 * ts-morph project can't always resolve the workspace package).
 */
const isFlagshipProvider = (identifier: Identifier): boolean => {
    const symbol = identifier.getSymbol();

    if (!symbol) {
        return identifier.getText() === "flagshipProvider";
    }

    for (const declaration of symbol.getDeclarations()) {
        if (!Node.isImportSpecifier(declaration)) {
            continue;
        }

        if (declaration.getImportDeclaration().getModuleSpecifierValue() !== FLAGSHIP_PROVIDER_MODULE) {
            return false;
        }

        return declaration.getNameNode().getText() === "flagshipProvider";
    }

    return false;
};

/** Read a static string-literal property off an object literal, or `undefined` when absent / non-literal. */
const stringPropertyOrUndefined = (argument: ObjectLiteralExpression, property: string): string | undefined => {
    const node = argument.getProperty(property);

    if (!node || !Node.isPropertyAssignment(node)) {
        return undefined;
    }

    const initializer = node.getInitializerOrThrow();

    if (Node.isStringLiteral(initializer) || Node.isNoSubstitutionTemplateLiteral(initializer)) {
        return initializer.getLiteralValue();
    }

    return undefined;
};

/**
 * Lift a `flagshipProvider({...})` call into its {@link FlagsIR} provider facts.
 * A static `binding: "FLAGS"` literal means binding mode (a wrangler `flagship`
 * binding is needed); anything else (an `appId`/`endpoint` config, or a binding
 * name that isn't a static literal) is treated as HTTP mode — no binding to
 * reconcile.
 */
const flagshipIrFromCall = (call: CallExpression): FlagsIR => {
    const argument = call.getArguments()[0];

    if (argument && Node.isObjectLiteralExpression(argument)) {
        const bindingName = stringPropertyOrUndefined(argument, "binding");

        if (bindingName !== undefined && bindingName.length > 0) {
            return { bindingName, mode: "binding", provider: "flagship" };
        }
    }

    return { mode: "http", provider: "flagship" };
};

/** Unwrap the `provider:` initializer from a `defineFlags({...})` call's argument. */
const providerInitializer = (defineFlagsCall: CallExpression): TsNode | undefined => propertyInitializer(defineFlagsCall.getArguments()[0], "provider");

/**
 * Discover the feature-flag provider a project declares in `lunora/flags.ts`.
 * Returns `undefined` when the file doesn't exist (the app has no flags). The
 * read is metadata-only and lenient: codegen wires `ctx.flags` purely from the
 * file's *existence* (`run-codegen.ts`) and imports the real module for the
 * provider value — this IR exists solely so the config layer can reconcile the
 * wrangler `flagship` binding for the Flagship binding-mode provider. Anything
 * it can't read statically degrades to a `custom` provider (no binding), never
 * a thrown error.
 */
const discoverFlags = (project: Project, lunoraDirectory: string): FlagsIR | undefined => {
    const flagsPath = join(lunoraDirectory, FLAGS_FILENAME);

    if (!existsSync(flagsPath)) {
        return undefined;
    }

    const source = project.getSourceFile(flagsPath) ?? project.addSourceFileAtPath(flagsPath);
    const exported = defaultExportExpression(source);

    if (!exported || !Node.isCallExpression(exported)) {
        return { provider: "custom" };
    }

    const provider = providerInitializer(exported);

    if (provider && Node.isCallExpression(provider)) {
        const callee = provider.getExpression();

        if (Node.isIdentifier(callee) && isFlagshipProvider(callee)) {
            return flagshipIrFromCall(provider);
        }
    }

    return { provider: "custom" };
};

export { discoverFlags, FLAGS_FILENAME };
