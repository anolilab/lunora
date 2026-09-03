import type { CallExpression, Node as TsNode, ObjectLiteralExpression, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { enclosingExportName } from "../argument-taint";
import type { AuthConfigIR } from "../ir";
import { collectSecurityCallRows, propertyInitializer } from "./ast";
import { calleeName } from "./callee";

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

/**
 * Discover `createAuth({...})` calls — the shared input for the `auth_*`
 * security lints (trusted-origins wildcard, CSRF check disabled, secure cookies
 * disabled, email verification disabled, session freshAge zero, SCIM without
 * transactions). Matched by callee NAME, so a re-export or alias still resolves.
 * When the config argument isn't a statically-analyzable object literal (a
 * top-level spread, or not an object literal at all), the row is recorded with
 * `analyzable: false` and every boolean fact at its SAFE value, so no lint fires
 * on an opaque config.
 *
 * Scans the worker entry as well as `lunora/` (see `listSecurityScanFiles`) for
 * the same reason `discover/config-calls` does: `createAuth` is built in the
 * entry by convention — `examples/blog/src/server/index.ts` is the shape — so a
 * `lunora/`-only walk left all six lints unable to fire on a real app.
 */
const discoverAuthConfig = (project: Project, lunoraDirectory: string): AuthConfigIR[] => collectSecurityCallRows(project, lunoraDirectory, authConfigInCall);

export default discoverAuthConfig;
