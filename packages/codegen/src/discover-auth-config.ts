import type { CallExpression, Node as TsNode, ObjectLiteralExpression, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { calleeName, enclosingExportName } from "./argument-taint";
import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { AuthConfigIR } from "./ir";

/**
 * The initializer of a named property on an object-literal `object`, when
 * `object` is itself a statically-readable object literal and the property is a
 * plain (non-spread, non-shorthand) `PropertyAssignment`. `undefined` in every
 * other case — a missing key, a spread-only/opaque parent, or a shorthand/method
 * property with no useful initializer to read.
 */
const propertyInitializer = (object: TsNode | undefined, name: string): TsNode | undefined => {
    if (!object || !Node.isObjectLiteralExpression(object)) {
        return undefined;
    }

    const property = object.getProperty(name);

    return property && Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
};

/** Whether `node` is the literal `true` keyword. */
const isTrueLiteral = (node: TsNode | undefined): boolean => node?.getKind() === SyntaxKind.TrueKeyword;

/** Whether `node` is the literal `false` keyword. */
const isFalseLiteral = (node: TsNode | undefined): boolean => node?.getKind() === SyntaxKind.FalseKeyword;

/** Whether `node` is the numeric literal `0`. */
const isZeroLiteral = (node: TsNode | undefined): boolean => node !== undefined && Node.isNumericLiteral(node) && node.getLiteralValue() === 0;

/** Adapters that cannot satisfy `@better-auth/scim`: single-table CRUD with no native transactions. */
const NON_TRANSACTIONAL_ADAPTERS = new Set(["lunoraAuthAdapter", "lunoraD1Adapter"]);

/** Whether a `plugins` array-literal initializer contains a `scim(...)` call. */
const hasScimPlugin = (node: TsNode | undefined): boolean => {
    if (!node || !Node.isArrayLiteralExpression(node)) {
        return false;
    }

    return node.getElements().some((element) => Node.isCallExpression(element) && calleeName(element.getExpression()) === "scim");
};

/** Whether a `database` initializer is one of the adapters with no native transactions. */
const isNonTransactionalAdapter = (node: TsNode | undefined): boolean =>
    node !== undefined && Node.isCallExpression(node) && NON_TRANSACTIONAL_ADAPTERS.has(calleeName(node.getExpression()) ?? "");

/** Whether a `trustedOrigins` array-literal initializer contains a `"*"` string element. */
const hasWildcardOrigin = (node: TsNode | undefined): boolean => {
    if (!node || !Node.isArrayLiteralExpression(node)) {
        return false;
    }

    return node.getElements().some((element) => Node.isStringLiteral(element) && element.getLiteralText() === "*");
};

/**
 * Read a `createAuth({...})` config object literal into the boolean facts the
 * five `auth_*` security lints check. Only reached once the argument is already
 * confirmed to be a statically-readable, spread-free object literal — see
 * {@link authConfigInCall}.
 */
const readAuthConfig = (config: ObjectLiteralExpression): Omit<AuthConfigIR, "exportName" | "file" | "line"> => {
    const advanced = propertyInitializer(config, "advanced");
    const emailAndPassword = propertyInitializer(config, "emailAndPassword");
    const session = propertyInitializer(config, "session");

    return {
        analyzable: true,
        disableCsrfCheck: isTrueLiteral(propertyInitializer(advanced, "disableCSRFCheck")),
        emailPasswordEnabled: isTrueLiteral(propertyInitializer(emailAndPassword, "enabled")),
        requireEmailVerification: isTrueLiteral(propertyInitializer(emailAndPassword, "requireEmailVerification")), // gitleaks:allow -- ts-morph property-name lookup, not a secret
        scimOnNonTransactionalAdapter:
            hasScimPlugin(propertyInitializer(config, "plugins")) && isNonTransactionalAdapter(propertyInitializer(config, "database")),
        secureCookiesDisabled: isFalseLiteral(propertyInitializer(advanced, "useSecureCookies")),
        sessionFreshAgeZero: isZeroLiteral(propertyInitializer(session, "freshAge")),
        trustedOriginsWildcard: hasWildcardOrigin(propertyInitializer(config, "trustedOrigins")),
    };
};

/**
 * The safe (not-flagged) fact set for a `createAuth(...)` call whose config
 * argument isn't statically analyzable — a top-level spread, or not an object
 * literal at all. An opaque config could set (or clear) any of these keys
 * elsewhere, so every lint must skip it rather than guess.
 */
const unanalyzableAuthConfig = (): Omit<AuthConfigIR, "exportName" | "file" | "line"> => {
    return {
        analyzable: false,
        disableCsrfCheck: false,
        emailPasswordEnabled: false,
        requireEmailVerification: false,
        scimOnNonTransactionalAdapter: false,
        secureCookiesDisabled: false,
        sessionFreshAgeZero: false,
        trustedOriginsWildcard: false,
    };
};

/** The IR row for a `createAuth({...})` call in this source file, or `undefined` when the callee doesn't match. */
const authConfigInCall = (call: CallExpression, relativePath: string): AuthConfigIR | undefined => {
    if (calleeName(call.getExpression()) !== "createAuth") {
        return undefined;
    }

    const argument = call.getArguments()[0];
    const hasSpread =
        argument !== undefined && Node.isObjectLiteralExpression(argument) && argument.getProperties().some((property) => Node.isSpreadAssignment(property));

    const facts = argument !== undefined && Node.isObjectLiteralExpression(argument) && !hasSpread ? readAuthConfig(argument) : unanalyzableAuthConfig();

    return { exportName: enclosingExportName(call), file: relativePath, line: call.getStartLineNumber(), ...facts };
};

/** `createAuth({...})` calls in one source file. */
const authConfigsInSourceFile = (sourceFile: SourceFile, relativePath: string): AuthConfigIR[] => {
    const found: AuthConfigIR[] = [];

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const row = authConfigInCall(call, relativePath);

        if (row) {
            found.push(row);
        }
    }

    return found;
};

/**
 * Discover `createAuth({...})` calls in `lunora/` — the shared input for the
 * five `auth_*` security lints (trusted-origins wildcard, CSRF check disabled,
 * secure cookies disabled, email verification disabled, session freshAge zero).
 * Matched by callee NAME, so a re-export or alias still resolves. When the
 * config argument isn't a statically-analyzable object literal (a top-level
 * spread, or not an object literal at all), the row is recorded with
 * `analyzable: false` and every boolean fact at its SAFE value, so no lint fires
 * on an opaque config.
 */
const discoverAuthConfig = (project: Project, lunoraDirectory: string): AuthConfigIR[] => {
    const rows: AuthConfigIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        rows.push(...authConfigsInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return rows;
};

export default discoverAuthConfig;
