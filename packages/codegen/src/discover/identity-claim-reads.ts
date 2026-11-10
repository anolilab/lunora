import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ElementAccessExpression, Node as TsNode, ObjectLiteralExpression, Project, PropertyAccessExpression, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { IdentityClaimReadIR } from "../ir";
import { collectNodeRows, propertyKeyName } from "./ast";
import { callSiteScopeOf } from "./attribution";
import discoverAuthClaims from "./auth-claims";
import { calleeName } from "./callee";
import { isContextSurface } from "./context-root";
import { IDENTITY_FILENAME } from "./identity";
import { propertyNameText } from "./property-name";

/**
 * Receiver texts a `.identity` member access sits on in an RLS / mask POLICY
 * context, which is not a handler ctx: its destructured `auth` and its
 * `context.auth`. A handler's `ctx.auth` is resolved by symbol instead (a
 * renamed or destructured ctx included, see {@link identityBagAccess}).
 */
const POLICY_IDENTITY_RECEIVERS = new Set(["auth", "context.auth"]);

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
            keys.add(propertyKeyName(property));
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

    const receiver = node.getExpression();

    return POLICY_IDENTITY_RECEIVERS.has(receiver.getText()) || isContextSurface(receiver, ["auth"]) ? node : undefined;
};

/** Looks through parentheses and `await`, so `(await ctx.auth.getIdentity())` reads as the call itself. */
const throughAwait = (node: TsNode): TsNode =>
    Node.isAwaitExpression(node) || Node.isParenthesizedExpression(node) ? throughAwait(node.getExpression()) : node;

/** Whether `node` is `<auth>.getIdentity()` on an identity receiver, once `await` and parentheses are looked through. */
const identityResultOf = (node: TsNode | undefined): TsNode | undefined => {
    if (node === undefined) {
        return undefined;
    }

    const value = throughAwait(node);

    if (!Node.isCallExpression(value)) {
        return undefined;
    }

    const callee = value.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "getIdentity") {
        return undefined;
    }

    const receiver = callee.getExpression();

    return POLICY_IDENTITY_RECEIVERS.has(receiver.getText()) || isContextSurface(receiver, ["auth"]) ? value : undefined;
};

/** The key an access reads: a `.<key>` property name, or a `["<key>"]` string-literal index. `undefined` for any other index. */
const accessedKey = (node: PropertyAccessExpression | ElementAccessExpression): string | undefined => {
    if (Node.isPropertyAccessExpression(node)) {
        return node.getName();
    }

    const argument = node.getArgumentExpression();

    return argument && Node.isStringLiteral(argument) ? argument.getLiteralValue() : undefined;
};

/**
 * The claim key a node reads off the identity: a `.identity.<key>` read on the bag, or a
 * `<key>` read straight off the `getIdentity()` result (`(await ctx.auth.getIdentity())?.plan`).
 * `undefined` when the node is neither.
 */
const claimKeyRead = (node: TsNode): string | undefined => {
    if (!Node.isPropertyAccessExpression(node) && !Node.isElementAccessExpression(node)) {
        return undefined;
    }

    const receiver = node.getExpression();

    return identityBagAccess(receiver) !== undefined || identityResultOf(receiver) !== undefined ? accessedKey(node) : undefined;
};

/** One claim read at `node`, tagged with whether the key is in the declared allow-list. */
const readRow = (node: TsNode, key: string, file: string, declared: ReadonlySet<string>): IdentityClaimReadIR => {return {
    declared: key === ALWAYS_DECLARED_CLAIM || declared.has(key),
    file,
    key,
    line: node.getStartLineNumber(),
    scope: callSiteScopeOf(node),
}};

/** The claim read one access makes, or `undefined`. */
const claimReadOf = (node: TsNode, file: string, declared: ReadonlySet<string>): IdentityClaimReadIR | undefined => {
    const key = claimKeyRead(node);

    return key === undefined ? undefined : readRow(node, key, file, declared);
};

/**
 * The claim reads a `const x = await ctx.auth.getIdentity()` declaration makes: each
 * destructured key (`const { plan } = …`), and each property read on `x` (`x.plan`,
 * `x["plan"]`) found through the language service. A rest element reads the whole
 * object, so it is not a claim read.
 */
const resultBindingReads = (declaration: VariableDeclaration, file: string, declared: ReadonlySet<string>): IdentityClaimReadIR[] => {
    if (identityResultOf(declaration.getInitializer()) === undefined) {
        return [];
    }

    const name = declaration.getNameNode();

    if (Node.isObjectBindingPattern(name)) {
        return name
            .getElements()
            .filter((element) => element.getDotDotDotToken() === undefined)
            .map((element) => readRow(element, propertyNameText(element.getPropertyNameNode() ?? element.getNameNode()), file, declared));
    }

    if (!Node.isIdentifier(name)) {
        return [];
    }

    return name
        .findReferencesAsNodes()
        .filter((reference) => reference !== name)
        .flatMap((reference) => {
            const access = reference.getParent();

            if (!Node.isPropertyAccessExpression(access) && !Node.isElementAccessExpression(access)) {
                return [];
            }

            const key = access.getExpression() === reference ? accessedKey(access) : undefined;

            return key === undefined ? [] : [readRow(access, key, file, declared)];
        });
};

/**
 * Discover claim reads on the identity in `lunora/` — the `identity_undeclared_claim_trusted`
 * lint input. `defineIdentity` validates only its *declared* claims at the trust boundary and
 * forwards undeclared claims verbatim, so an authorization decision that reads a claim outside
 * the declared contract is trusting an unvalidated, forgeable value.
 *
 * Tracked shapes: `<receiver>.identity.<key>` and `["<key>"]`; a key read straight off a
 * `getIdentity()` result (`(await ctx.auth.getIdentity())?.<key>`); a destructuring of that
 * result; and the property reads on a variable bound to it. Other flows (passed to a helper,
 * spread, reassigned) are not followed, to keep the false-positive rate low.
 *
 * Runs only when the project declares a resolvable `defineIdentity({ ... })` contract in
 * `lunora/identity.ts` (the allow-list to diff against); without one — or when the allow-list
 * is opaque (a spread / non-object argument) — it returns `[]`, so a project with no typed
 * identity contract is never flagged. Each read is tagged `declared` (in the contract, in the
 * always-present `userId`, or a user column the user cannot write) so the lint flags only the
 * undeclared reads.
 */
const discoverIdentityClaimReads = (project: Project, lunoraDirectory: string): IdentityClaimReadIR[] => {
    const contract = resolveDeclaredClaims(project, lunoraDirectory);

    if (contract === undefined) {
        return [];
    }

    // A user column the user cannot write (`input: false`) is as trustworthy as a declared
    // claim. A writable one (better-auth's default) is set by the user at sign-up or update,
    // so reading it for authorization still fires the lint.
    const trusted = discoverAuthClaims(project, lunoraDirectory)
        .claims.filter((claim) => !claim.writable)
        .map((claim) => claim.name);
    const declared = new Set([...contract, ...trusted]);

    return [
        ...collectNodeRows(project, lunoraDirectory, SyntaxKind.PropertyAccessExpression, (node, file) => claimReadOf(node, file, declared)),
        ...collectNodeRows(project, lunoraDirectory, SyntaxKind.ElementAccessExpression, (node, file) => claimReadOf(node, file, declared)),
        ...collectNodeRows(project, lunoraDirectory, SyntaxKind.VariableDeclaration, (node, file) => resultBindingReads(node, file, declared)),
    ];
};

export default discoverIdentityClaimReads;
