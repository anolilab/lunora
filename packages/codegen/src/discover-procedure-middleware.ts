import type { CallExpression, Node as TsNode, Project, SourceFile, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { classifyProcedureCall, listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { ProcedureMiddlewareIR } from "./ir";

/**
 * Middleware factory names mapped to the protection flag they set. Matched by the
 * callee name of a `.use(factory(...))` argument (bare identifier or property
 * access), mirroring how the RLS feeder matches `rls(...)` — by name, not import
 * origin, so degraded type info doesn't blind the lint.
 */
const MIDDLEWARE_FLAGS: Record<string, "usesCaptcha" | "usesMask" | "usesRateLimit" | "usesRls"> = {
    mask: "usesMask",
    rateLimit: "usesRateLimit",
    rls: "usesRls",
    verifyTurnstile: "usesCaptcha",
    verifyTurnstileMiddleware: "usesCaptcha",
};

/** Tables whose insert marks a procedure as user/session-creating (captcha-expected). */
const USER_TABLE_RE = /account|credential|member|passkey|session|user/iu;

/** The set of protections a builder chain carries. */
interface Protections {
    usesCaptcha: boolean;
    usesMask: boolean;
    usesRateLimit: boolean;
    usesRls: boolean;
}

/** The callee name of a call expression — bare identifier or property access — or `undefined`. */
const calleeNameOf = (call: CallExpression): string | undefined => {
    const callee = call.getExpression();

    if (Node.isIdentifier(callee)) {
        return callee.getText();
    }

    if (Node.isPropertyAccessExpression(callee)) {
        return callee.getName();
    }

    return undefined;
};

/**
 * Fold a `protectPublic({ rateLimit, captcha })` bundle into the protection flags
 * it sets by reading which keys its object-literal argument declares — the bundle
 * composes `rateLimit` + `captcha`, so a present (non-`undefined`) key counts
 * exactly as the standalone `.use(rateLimit(...))` / `.use(verifyTurnstile(...))`
 * step would. A non-literal argument is assumed to carry both common guards rather
 * than false-flag a protected procedure.
 */
const protectPublicFlags = (call: CallExpression): { usesCaptcha: boolean; usesRateLimit: boolean } => {
    const argument = call.getArguments()[0];

    if (!argument || !Node.isObjectLiteralExpression(argument)) {
        return { usesCaptcha: true, usesRateLimit: true };
    }

    return { usesCaptcha: Boolean(argument.getProperty("captcha")), usesRateLimit: Boolean(argument.getProperty("rateLimit")) };
};

/**
 * Walk a builder chain leftward from `receiver` collecting the protective
 * middlewares its `.use(...)` steps install. Recognises the individual factories
 * in {@link MIDDLEWARE_FLAGS} and unwraps a `protectPublic({...})` bundle.
 */
const protectionsInChain = (receiver: TsNode): Protections => {
    const protections: Protections = { usesCaptcha: false, usesMask: false, usesRateLimit: false, usesRls: false };
    let node: TsNode = receiver;

    while (Node.isCallExpression(node)) {
        const chainCallee = node.getExpression();

        if (!Node.isPropertyAccessExpression(chainCallee)) {
            break;
        }

        if (chainCallee.getName() === "use") {
            const argument = node.getArguments()[0];

            if (argument && Node.isCallExpression(argument)) {
                const name = calleeNameOf(argument);

                if (name === "protectPublic") {
                    const bundle = protectPublicFlags(argument);

                    protections.usesRateLimit ||= bundle.usesRateLimit;
                    protections.usesCaptcha ||= bundle.usesCaptcha;
                } else if (name !== undefined && name in MIDDLEWARE_FLAGS) {
                    protections[MIDDLEWARE_FLAGS[name] as keyof Protections] = true;
                }
            }
        }

        node = chainCallee.getExpression();
    }

    return protections;
};

/** True when `call` is a `ctx.db.insert("table", …)` / `db.insert("table", …)` write into a user-shaped table. */
const isUserTableInsert = (call: CallExpression): boolean => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "insert") {
        return false;
    }

    const receiver = callee.getExpression();
    const onDatabase = Node.isPropertyAccessExpression(receiver) ? receiver.getName() === "db" : Node.isIdentifier(receiver) && receiver.getText() === "db";

    if (!onDatabase) {
        return false;
    }

    const tableArgument = call.getArguments()[0];

    return Boolean(tableArgument && Node.isStringLiteral(tableArgument) && USER_TABLE_RE.test(tableArgument.getLiteralText()));
};

/** True when a node anywhere in `declaration` references `ctx.mail` / `ctx.email` (a mail send). */
const referencesMail = (declaration: TsNode): boolean =>
    declaration.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).some((access) => {
        const name = access.getName();

        if (name !== "mail" && name !== "email") {
            return false;
        }

        const receiver = access.getExpression();

        return Node.isIdentifier(receiver) && receiver.getText() === "ctx";
    });

/** Behavioural facts read from the procedure declaration body. */
const behaviourOf = (declaration: TsNode): { callsMail: boolean; writesUserTable: boolean } => {
    let writesUserTable = false;

    for (const call of declaration.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (isUserTableInsert(call)) {
            writesUserTable = true;

            break;
        }
    }

    return { callsMail: referencesMail(declaration), writesUserTable };
};

/** Build the {@link ProcedureMiddlewareIR} for one exported declaration, or `undefined` when it isn't a procedure. */
const middlewareIrFromDeclaration = (declaration: VariableDeclaration, relativePath: string): ProcedureMiddlewareIR | undefined => {
    const initializer = declaration.getInitializer();

    if (!initializer || !Node.isCallExpression(initializer)) {
        return undefined;
    }

    const classified = classifyProcedureCall(initializer);

    if (!classified || (classified.kind !== "query" && classified.kind !== "mutation" && classified.kind !== "action")) {
        return undefined;
    }

    const protections = classified.receiver
        ? protectionsInChain(classified.receiver)
        : { usesCaptcha: false, usesMask: false, usesRateLimit: false, usesRls: false };
    const { callsMail, writesUserTable } = behaviourOf(declaration);

    return {
        callsMail,
        exportName: declaration.getName(),
        file: relativePath,
        kind: classified.kind,
        usesCaptcha: protections.usesCaptcha,
        usesMask: protections.usesMask,
        usesRateLimit: protections.usesRateLimit,
        usesRls: protections.usesRls,
        visibility: classified.visibility,
        writesUserTable,
    };
};

/** Per-procedure middleware/behaviour snapshots across one source file. */
const middlewareInSourceFile = (sourceFile: SourceFile, relativePath: string): ProcedureMiddlewareIR[] => {
    const found: ProcedureMiddlewareIR[] = [];

    for (const statement of sourceFile.getVariableStatements()) {
        if (!statement.isExported()) {
            continue;
        }

        for (const declaration of statement.getDeclarations()) {
            const ir = middlewareIrFromDeclaration(declaration, relativePath);

            if (ir) {
                found.push(ir);
            }
        }
    }

    return found;
};

/**
 * Discover, per exported query/mutation/action under the lunora source directory,
 * which protective middlewares (`rateLimit`, `verifyTurnstile`/captcha, `rls`,
 * `mask` — plus the `protectPublic` bundle) its builder chain installs and whether
 * its handler writes a user/session table or sends mail. Feeds the
 * `public_mutation_without_ratelimit` and `user_creating_mutation_without_captcha`
 * lints. The bare-factory form (`mutation({ handler })`) has no builder chain, so
 * those procedures carry no protections — exactly what the lints flag.
 */
const discoverProcedureMiddleware = (project: Project, lunoraDirectory: string): ProcedureMiddlewareIR[] => {
    const procedures: ProcedureMiddlewareIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        procedures.push(...middlewareInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return procedures;
};

export default discoverProcedureMiddleware;
