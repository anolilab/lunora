import type { CallExpression, Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { enclosingExportName } from "./argument-taint";
import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { FlagSecurityDefaultIR } from "./ir";

/** True when `node` is the literal `ctx` identifier — the anchor a `ctx.flags.boolean(...)` read starts from. */
const isContextIdentifier = (node: TsNode): boolean => Node.isIdentifier(node) && node.getText() === "ctx";

/**
 * Whether `callee` is a `ctx.flags.boolean` property access — the boolean flag
 * read whose default a provider outage returns. Anchored on a literal `ctx.flags`
 * receiver (the same fail-closed, `import`-agnostic convention `discover-flags`
 * uses); deliberately does NOT match `ctx.flags.details.boolean` (a different
 * return shape), nor a destructured `flags` binding, nor the non-boolean typed
 * reads (`number`/`string`/`object`).
 */
const isFlagBooleanRead = (callee: TsNode): boolean => {
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "boolean") {
        return false;
    }

    const receiver = callee.getExpression();

    return Node.isPropertyAccessExpression(receiver) && receiver.getName() === "flags" && isContextIdentifier(receiver.getExpression());
};

/** The value of a `true`/`false` literal node, or `undefined` when it isn't a boolean literal (a variable, a call result, absent). */
const booleanLiteralValue = (node: TsNode | undefined): boolean | undefined => {
    if (node?.getKind() === SyntaxKind.TrueKeyword) {
        return true;
    }

    if (node?.getKind() === SyntaxKind.FalseKeyword) {
        return false;
    }

    return undefined;
};

/**
 * The IR row for a `ctx.flags.boolean("key", <boolean-literal>)` read, or
 * `undefined` when the callee isn't `ctx.flags.boolean`, the key isn't a string
 * literal, or the default isn't a boolean literal (the lint's security judgment
 * needs both statically).
 */
const flagSecurityDefaultInCall = (call: CallExpression, relativePath: string): FlagSecurityDefaultIR | undefined => {
    if (!isFlagBooleanRead(call.getExpression())) {
        return undefined;
    }

    const [keyArgument, defaultArgument] = call.getArguments();

    if (!keyArgument || !(Node.isStringLiteral(keyArgument) || Node.isNoSubstitutionTemplateLiteral(keyArgument))) {
        return undefined;
    }

    const key = keyArgument.getLiteralValue();
    const defaultValue = booleanLiteralValue(defaultArgument);

    if (key.length === 0 || defaultValue === undefined) {
        return undefined;
    }

    return { defaultValue, exportName: enclosingExportName(call), file: relativePath, key, line: call.getStartLineNumber() };
};

/** `ctx.flags.boolean(key, default)` reads with a literal key + boolean-literal default in one source file. */
const flagSecurityDefaultsInSourceFile = (sourceFile: SourceFile, relativePath: string): FlagSecurityDefaultIR[] => {
    const found: FlagSecurityDefaultIR[] = [];

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const flag = flagSecurityDefaultInCall(call, relativePath);

        if (flag) {
            found.push(flag);
        }
    }

    return found;
};

/**
 * Discover `ctx.flags.boolean(key, default)` reads in `lunora/` whose key and
 * default are both string/boolean literals — the
 * `flag_gates_security_with_unsafe_default` lint input. OpenFeature returns the
 * `default` when the provider errors, so a fail-open default on a
 * security-shaped key (an `enforce`/`rls`/`gate`/`lockdown` protection
 * defaulting `false`, or an `allow`/`permit`/`bypass` permission defaulting
 * `true`) silently opens access during an outage. The feeder stays factual —
 * every analyzable boolean flag read is recorded, and the lint owns the
 * security-shape + polarity judgment. `ctx.flags.details.boolean` and the
 * non-boolean typed reads are not sinks and are not recorded.
 */
const discoverFlagSecurityDefaults = (project: Project, lunoraDirectory: string): FlagSecurityDefaultIR[] => {
    const flags: FlagSecurityDefaultIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        flags.push(...flagSecurityDefaultsInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return flags;
};

export default discoverFlagSecurityDefaults;
