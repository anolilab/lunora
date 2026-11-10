import type { CallExpression, Node as TsNode, ObjectLiteralElementLike, ObjectLiteralExpression, Project, Symbol as TsSymbol } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { CLAIM_NAME, MAX_CLAIM_NAMES, RESERVED_CLAIMS, SENSITIVE_FIELDS } from "../../../../shared/identity-claims";
import { descendantsOfKind, listSecurityScanFiles, propertyInitializer } from "./ast";
import { propertyKeyName } from "./property-name";

/** The scalar types a claim can carry: the runtime forwards only JSON scalars. */
type AuthClaimType = "boolean" | "number" | "string";

/** One app-declared user column that reaches `ctx.auth` as a claim. */
interface AuthClaim {
    /** The column name, which is also the claim key. */
    name: string;
    /** `date` columns arrive as ISO strings, so they type as `string`. */
    type: AuthClaimType;

    /**
     * `input` is not `false`, so a user can set the column through sign-up or
     * update-user. Better-auth's default is writable; a writable claim is typed but
     * is not trusted by the undeclared-claim lint.
     */
    writable: boolean;
}

/** The claims one `.auth()` declaration yields, plus why any column was left out. */
interface AuthClaimDiscovery {
    claims: AuthClaim[];
    /** One line per column or config shape codegen could not read. Empty when everything resolved. */
    diagnostics: string[];
}

const NONE: AuthClaimDiscovery = { claims: [], diagnostics: [] };

/** An opaque config yields no claims and says why, rather than a guess. */
const opaque = (reason: string): AuthClaimDiscovery => {
    return { claims: [], diagnostics: [reason] };
};

/** Follows parentheses and `as` casts to the expression underneath. */
const unwrap = (node: TsNode): TsNode => (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) ? unwrap(node.getExpression()) : node);

/** A property that is present but has no expression codegen can read (a method or accessor). */
const UNREADABLE = "unreadable";

/**
 * The expression behind a named property: a `key: value` initializer, or the name of a
 * shorthand `{ key }`, which {@link objectLiteralOf} follows to the binding it names.
 * `undefined` when the key is absent; {@link UNREADABLE} when it is present but is a
 * method or accessor, so the caller can say so instead of treating it as absent.
 */
const propertyValue = (object: ObjectLiteralExpression, name: string): TsNode | typeof UNREADABLE | undefined => {
    const property = object.getProperty(name);

    if (property === undefined) {
        return undefined;
    }

    if (Node.isPropertyAssignment(property)) {
        return property.getInitializer() ?? UNREADABLE;
    }

    return Node.isShorthandPropertyAssignment(property) ? property.getNameNode() : UNREADABLE;
};

/** Whether an object literal has a spread, which can hide any key. */
const hasSpread = (object: ObjectLiteralExpression): boolean => object.getProperties().some((property) => Node.isSpreadAssignment(property));

/** The expression a function body yields: the body itself for an arrow's expression form, or the expression of its only `return`. */
const yieldedExpression = (body: TsNode | undefined): TsNode | undefined => {
    if (body === undefined || !Node.isBlock(body)) {
        return body;
    }

    const returns = body.getStatements().filter((statement) => Node.isReturnStatement(statement));

    return returns.length === 1 ? returns[0]?.getExpression() : undefined;
};

/**
 * The object literal an expression resolves to: a literal, an identifier bound to
 * one (followed through an import), or a function that returns one. `undefined` when
 * the value is opaque, so the caller can say so instead of guessing.
 */
const objectLiteralOf = (node: TsNode, depth = 0): ObjectLiteralExpression | undefined => {
    if (depth > 4) {
        return undefined;
    }

    const expression = unwrap(node);

    if (Node.isObjectLiteralExpression(expression)) {
        return expression;
    }

    if (Node.isArrowFunction(expression) || Node.isFunctionExpression(expression)) {
        const yielded = yieldedExpression(expression.getBody());

        return yielded === undefined ? undefined : objectLiteralOf(yielded, depth + 1);
    }

    if (!Node.isIdentifier(expression)) {
        return undefined;
    }

    // The name of a shorthand `{ options }` resolves to the property; the value is the binding it names.
    const shorthand = expression.getParent();
    const symbol = Node.isShorthandPropertyAssignment(shorthand) ? shorthand.getValueSymbol() : expression.getSymbol();
    const resolved: TsSymbol | undefined = symbol?.isAlias() ? symbol.getAliasedSymbol() : symbol;
    const [declaration] = resolved?.getDeclarations() ?? [];

    if (Node.isVariableDeclaration(declaration)) {
        const initializer = declaration.getInitializer();

        return initializer === undefined ? undefined : objectLiteralOf(initializer, depth + 1);
    }

    if (Node.isFunctionDeclaration(declaration)) {
        const yielded = yieldedExpression(declaration.getBody());

        return yielded === undefined ? undefined : objectLiteralOf(yielded, depth + 1);
    }

    return undefined;
};

/** The claim type a better-auth `type` value maps to, or `undefined` when the type is not a flat scalar. */
const claimTypeOf = (typeNode: TsNode | undefined): AuthClaimType | undefined => {
    if (typeNode === undefined) {
        return undefined;
    }

    // An enum-like `type: ["a", "b"]` is a string at runtime.
    if (Node.isArrayLiteralExpression(typeNode)) {
        return "string";
    }

    if (!Node.isStringLiteral(typeNode)) {
        return undefined;
    }

    switch (typeNode.getLiteralValue()) {
        case "boolean": {
            return "boolean";
        }
        case "date":
        case "string": {
            return "string";
        }
        case "number": {
            return "number";
        }
        default: {
            return undefined;
        }
    }
};

/** Whether the column's `returned` is `false`: better-auth then keeps it out of the session, so it can never be a claim. */
const isNotReturned = (field: ObjectLiteralExpression): boolean => propertyInitializer(field, "returned")?.getKind() === SyntaxKind.FalseKeyword;

/** Reads one `additionalFields` entry, or the reason it cannot be a claim. */
const claimOf = (name: string, init: TsNode): { claim?: AuthClaim; reason?: string } => {
    if (!CLAIM_NAME.test(name)) {
        return { reason: `\`${name}\` is not an identifier of at most 64 characters` };
    }

    if (RESERVED_CLAIMS.has(name) || SENSITIVE_FIELDS.has(name)) {
        return { reason: `\`${name}\` is reserved or secret-bearing, so the session never forwards it` };
    }

    const field = objectLiteralOf(init);

    if (field === undefined || hasSpread(field)) {
        return { reason: `\`${name}\` is not a literal field definition` };
    }

    const type = claimTypeOf(propertyInitializer(field, "type"));

    if (type === undefined) {
        return { reason: `\`${name}\` is not a scalar (string, number, boolean or date) column` };
    }

    return { claim: { name, type, writable: propertyInitializer(field, "input")?.getKind() !== SyntaxKind.FalseKeyword } };
};

/** One `additionalFields` entry read as a claim, a reason it is left out, or nothing when the session does not return it. */
const entryClaim = (property: ObjectLiteralElementLike): { claim?: AuthClaim; reason?: string } | undefined => {
    if (Node.isSpreadAssignment(property)) {
        return undefined;
    }

    if (!Node.isPropertyAssignment(property) && !Node.isShorthandPropertyAssignment(property)) {
        return { reason: `\`${property.getName()}\` is a method or accessor, not a field definition` };
    }

    const name = Node.isPropertyAssignment(property) ? propertyKeyName(property) : property.getName();
    const init = Node.isPropertyAssignment(property) ? property.getInitializer() : property.getNameNode();
    const field = init === undefined ? undefined : objectLiteralOf(init);

    // Not returned by the session, so it is not a claim and needs no diagnostic.
    if (field !== undefined && isNotReturned(field)) {
        return undefined;
    }

    return init === undefined ? { reason: `\`${name}\` has no initializer` } : claimOf(name, init);
};

/** Each readable `additionalFields` entry as a claim, with a diagnostic for every one that is left out. */
const claimsFromFields = (fields: ObjectLiteralExpression): AuthClaimDiscovery => {
    const claims: AuthClaim[] = [];
    const diagnostics: string[] = [];

    for (const property of fields.getProperties()) {
        const entry = entryClaim(property);

        if (entry?.claim !== undefined) {
            claims.push(entry.claim);
        } else if (entry !== undefined) {
            diagnostics.push(`${entry.reason ?? "the entry cannot be a claim"}; it is not added to ctx.auth`);
        }
    }

    if (claims.length > MAX_CLAIM_NAMES) {
        diagnostics.push(`${claims.length.toString()} claims declared; the first ${MAX_CLAIM_NAMES.toString()} are forwarded, the rest are not`);
    }

    return { claims: claims.slice(0, MAX_CLAIM_NAMES), diagnostics };
};

/** Reads the `user.additionalFields` of a `user` object literal: none, opaque, or the claims it declares. */
const userClaims = (user: ObjectLiteralExpression): AuthClaimDiscovery => {
    if (hasSpread(user)) {
        return opaque("`user` has a spread, so the user columns cannot be read");
    }

    const fieldsNode = propertyValue(user, "additionalFields");

    if (fieldsNode === undefined) {
        return NONE;
    }

    const fields = fieldsNode === UNREADABLE ? undefined : objectLiteralOf(fieldsNode);

    return fields === undefined || hasSpread(fields)
        ? opaque("`user.additionalFields` is not an object literal, so the user columns cannot be read")
        : claimsFromFields(fields);
};

/** Reads `user.additionalFields` out of a resolved `options` object literal. */
const readAuthClaims = (options: ObjectLiteralExpression): AuthClaimDiscovery => {
    if (hasSpread(options)) {
        return opaque("the auth options contain a spread, so the user columns cannot be read");
    }

    const userNode = propertyValue(options, "user");

    if (userNode === undefined) {
        return NONE;
    }

    const user = userNode === UNREADABLE ? undefined : objectLiteralOf(userNode);

    return user === undefined ? opaque("`user` is not an object literal, so the user columns cannot be read") : userClaims(user);
};

/** The claims for one `.auth(...)` call, or `undefined` when the call is not an auth declaration. */
const authOptionsOf = (call: CallExpression): AuthClaimDiscovery | undefined => {
    const callee = call.getExpression();
    const [argument] = call.getArguments();

    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "auth" || argument === undefined) {
        return undefined;
    }

    if (!Node.isObjectLiteralExpression(argument)) {
        return opaque(".auth() is not called with an object literal, so its user columns cannot be read");
    }

    const optionsNode = propertyValue(argument, "options");

    if (optionsNode === undefined) {
        return undefined;
    }

    const options = optionsNode === UNREADABLE ? undefined : objectLiteralOf(optionsNode);

    return options === undefined
        ? opaque("`.auth({ options })` does not resolve to an object literal, so the user columns cannot be read")
        : readAuthClaims(options);
};

/**
 * The first `.auth({ options })` call in the worker entry or `lunora/`. Returns its
 * user-column claims, or an empty set with diagnostics when the options cannot be read
 * statically. An opaque config yields no claims, never a guess: the typed claims must
 * match what the runtime forwards.
 */
const discoverAuthClaims = (project: Project, lunoraDirectory: string): AuthClaimDiscovery => {
    for (const { filePath } of listSecurityScanFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        for (const call of descendantsOfKind(sourceFile, SyntaxKind.CallExpression)) {
            const found = authOptionsOf(call);

            if (found !== undefined) {
                return found;
            }
        }
    }

    return NONE;
};

export type { AuthClaim, AuthClaimDiscovery, AuthClaimType };
export default discoverAuthClaims;
