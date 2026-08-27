import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Node as TsNode, ObjectLiteralExpression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { calleeName, enclosingExportName } from "./argument-taint";
import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import { IDENTITY_FILENAME } from "./discover-identity";
import type { IdentityClaimReadIR } from "./ir";

/**
 * Receiver texts a `.identity` member access must sit on to count as the
 * resolved-identity claim bag: the RLS/mask policy context's destructured
 * `auth`, or the full `ctx.auth`/`context.auth`. Matched by receiver text (the
 * same `import`-agnostic, fail-closed convention the other feeders use), so a
 * re-export or alias still resolves.
 */
const IDENTITY_RECEIVERS = new Set(["auth", "context.auth", "ctx.auth"]);

/** `userId` is a required, always-declared claim (`defineIdentity` mandates it), so a read of it is never an undeclared-claim finding. */
const ALWAYS_DECLARED_CLAIM = "userId";

/**
 * The declared claim keys of a `defineIdentity({ ... })` object literal, or
 * `undefined` when the allow-list can't be resolved statically — the argument
 * is not an object literal, or a spread (`{ ...base }`) makes the key set
 * opaque. An opaque allow-list must yield *no* findings (every read would look
 * undeclared), so the caller returns `[]` in that case.
 */
const declaredClaimKeys = (objectLiteral: ObjectLiteralExpression): Set<string> | undefined => {
    const keys = new Set<string>();

    for (const property of objectLiteral.getProperties()) {
        if (Node.isSpreadAssignment(property)) {
            return undefined;
        }

        if (Node.isPropertyAssignment(property) || Node.isShorthandPropertyAssignment(property) || Node.isMethodDeclaration(property)) {
            keys.add(property.getName());
        }
    }

    return keys;
};

/**
 * The declared claim allow-list from `lunora/identity.ts` — the key set of the
 * first `defineIdentity({ ... })` call's config object literal. `undefined` when
 * the file is absent, no `defineIdentity` call is found, or the allow-list is
 * not statically resolvable (a non-object-literal argument, or a spread). The
 * lint fires only against a resolved allow-list, so an unresolvable one produces
 * no findings rather than flagging every read.
 */
const resolveDeclaredClaims = (project: Project, lunoraDirectory: string): Set<string> | undefined => {
    const identityPath = join(lunoraDirectory, IDENTITY_FILENAME);

    if (!existsSync(identityPath)) {
        return undefined;
    }

    const source = project.getSourceFile(identityPath) ?? project.addSourceFileAtPath(identityPath);

    for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (calleeName(call.getExpression()) !== "defineIdentity") {
            continue;
        }

        const [argument] = call.getArguments();

        return argument && Node.isObjectLiteralExpression(argument) ? declaredClaimKeys(argument) : undefined;
    }

    return undefined;
};

/**
 * When `node` is a `.identity` property access sitting on an identity receiver
 * (`auth` / `ctx.auth` / `context.auth`), return it — the intermediate access a
 * claim read (`auth.identity.<key>`) or bracket read (`auth.identity["<key>"]`)
 * is built on. Otherwise `undefined`.
 */
const identityBagAccess = (node: TsNode | undefined): TsNode | undefined => {
    if (node === undefined || !Node.isPropertyAccessExpression(node) || node.getName() !== "identity") {
        return undefined;
    }

    return IDENTITY_RECEIVERS.has(node.getExpression().getText()) ? node : undefined;
};

/** The claim key a node reads off the identity bag — a `.identity.<key>` property name, or a `.identity["<key>"]` string-literal index. `undefined` when the node is neither. */
const claimKeyRead = (node: TsNode): string | undefined => {
    if (Node.isPropertyAccessExpression(node) && identityBagAccess(node.getExpression()) !== undefined) {
        return node.getName();
    }

    if (Node.isElementAccessExpression(node) && identityBagAccess(node.getExpression()) !== undefined) {
        const argument = node.getArgumentExpression();

        return argument && Node.isStringLiteral(argument) ? argument.getLiteralValue() : undefined;
    }

    return undefined;
};

/** Every `auth.identity.<key>` / `ctx.auth.identity.<key>` claim read in one source file, tagged with whether the key is in the declared allow-list. */
const claimReadsInSourceFile = (sourceFile: SourceFile, relativePath: string, declared: Set<string>): IdentityClaimReadIR[] => {
    const found: IdentityClaimReadIR[] = [];

    for (const node of sourceFile.getDescendants()) {
        const key = claimKeyRead(node);

        if (key === undefined) {
            continue;
        }

        found.push({
            declared: key === ALWAYS_DECLARED_CLAIM || declared.has(key),
            exportName: enclosingExportName(node),
            file: relativePath,
            key,
            line: node.getStartLineNumber(),
        });
    }

    return found;
};

/**
 * Discover `ctx.auth.identity.<key>` / `auth.identity.<key>` claim reads in
 * `lunora/` — the `identity_undeclared_claim_trusted` lint input. `defineIdentity`
 * validates only its *declared* claims at the trust boundary and forwards
 * undeclared claims verbatim, so an authorization decision that reads a claim
 * outside the declared contract is trusting an unvalidated, forgeable value.
 *
 * Runs only when the project declares a resolvable `defineIdentity({ ... })`
 * contract in `lunora/identity.ts` (the allow-list to diff against); without one
 * — or when the allow-list is opaque (a spread / non-object argument) — it
 * returns `[]`, so a project with no typed identity contract is never flagged.
 * Each read is tagged `declared` (in the contract, or the always-present
 * `userId`) so the lint flags only the undeclared reads. Deliberately narrow:
 * only the direct `<receiver>.identity.<key>` member/bracket chains are tracked
 * (not a `const bag = auth.identity; bag.x` hop or a `getIdentity()` result), to
 * keep the false-positive rate low.
 */
const discoverIdentityClaimReads = (project: Project, lunoraDirectory: string): IdentityClaimReadIR[] => {
    const declared = resolveDeclaredClaims(project, lunoraDirectory);

    if (declared === undefined) {
        return [];
    }

    const rows: IdentityClaimReadIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        rows.push(...claimReadsInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath), declared));
    }

    return rows;
};

export default discoverIdentityClaimReads;
