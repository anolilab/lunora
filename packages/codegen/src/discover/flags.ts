import { existsSync } from "node:fs";
import { join } from "node:path";

import type { CallExpression, Identifier, Node as TsNode, ObjectLiteralExpression, Project, PropertyAccessExpression } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { defaultExportExpression, isContextIdentifier, propertyInitializer } from "./discover-ast";
import { listLunoraSourceFiles } from "./discover-functions";
import type { FlagsIR } from "./ir";

/** The only file a feature-flag provider may be declared in — mirrors `lunora/queues.ts`. */
const FLAGS_FILENAME = "flags.ts";

/** The four typed flag reads `ctx.flags.<type>(…)` / `ctx.flags.details.<type>(…)` expose. */
const FLAG_TYPES = new Set(["boolean", "number", "object", "string"]);

/** One statically-discovered flag read: the key plus the value type its `ctx.flags.<type>` call implies. */
interface FlagKey {
    /** The flag key — the first (string-literal) argument of the `ctx.flags.<type>(…)` read. */
    key: string;
    /** The value type, derived from which `ctx.flags.<type>` method read it. */
    type: "boolean" | "number" | "object" | "string";
}

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

/**
 * Decide whether `access` is a `ctx.flags.<type>` or `ctx.flags.details.<type>`
 * property access and, if so, return the value type. Anchored on a literal `ctx`
 * identifier (the destructured `const { flags } = ctx` form isn't matched — like
 * the studio nav probe, a bare `flags.boolean(...)` is too ambiguous to claim).
 */
const flagTypeFromAccess = (access: PropertyAccessExpression): FlagKey["type"] | undefined => {
    const name = access.getName();

    if (!FLAG_TYPES.has(name)) {
        return undefined;
    }

    const receiver = access.getExpression();

    if (!Node.isPropertyAccessExpression(receiver)) {
        return undefined;
    }

    // `ctx.flags.<type>(...)`
    if (receiver.getName() === "flags" && isContextIdentifier(receiver.getExpression())) {
        return name as FlagKey["type"];
    }

    // `ctx.flags.details.<type>(...)`
    const inner = receiver.getExpression();

    if (
        receiver.getName() === "details" &&
        Node.isPropertyAccessExpression(inner) &&
        inner.getName() === "flags" &&
        isContextIdentifier(inner.getExpression())
    ) {
        return name as FlagKey["type"];
    }

    return undefined;
};

/**
 * Statically discover every feature flag the app's `lunora/` handlers read, by
 * scanning for `ctx.flags.<type>("key", …)` (and `ctx.flags.details.<type>(…)`)
 * calls whose first argument is a string literal. Powers the studio's read-only
 * Flags page (`__lunora_admin__:listFlags`) and the generated `evaluateFlags`
 * override, which evaluates each discovered key through the configured provider.
 *
 * Best-effort: only literal keys behind a literal `ctx` receiver are captured (a
 * dynamic key or a destructured `flags` binding is skipped — the page simply
 * won't list it). Keys are de-duplicated (first read wins on a type clash) and
 * returned sorted by key for deterministic codegen output.
 */
/** Extract the `{ key, type }` of a single `ctx.flags.<type>("key", …)` read, or `undefined` when the call isn't one. */
const flagKeyFromCall = (call: CallExpression): FlagKey | undefined => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee)) {
        return undefined;
    }

    const type = flagTypeFromAccess(callee);

    if (type === undefined) {
        return undefined;
    }

    const argument = call.getArguments()[0];

    if (!argument || !(Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument))) {
        return undefined;
    }

    const key = argument.getLiteralValue();

    return key.length > 0 ? { key, type } : undefined;
};

const discoverFlagKeys = (project: Project, lunoraDirectory: string): FlagKey[] => {
    const found = new Map<string, FlagKey["type"]>();

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
            const candidate = flagKeyFromCall(call);

            if (candidate && !found.has(candidate.key)) {
                found.set(candidate.key, candidate.type);
            }
        }
    }

    return [...found.entries()]
        .map(([key, type]) => {
            return { key, type };
        })
        .toSorted((a, b) => a.key.localeCompare(b.key));
};

export { discoverFlagKeys, discoverFlags, FLAGS_FILENAME };
export type { FlagKey };
