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
    dbRateLimit: "usesRateLimit",
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
 * step would.
 *
 * A non-object-literal argument (e.g. a spread variable `protectPublic(cfg)`) is
 * statically opaque — we can't see which guards it carries. The abuse lints this
 * feeds are fail-CLOSED, so we assume NEITHER guard is present rather than clear a
 * possibly-unprotected public procedure; a developer who genuinely guards via a
 * variable can suppress the resulting advisory.
 */
const protectPublicFlags = (call: CallExpression): { usesCaptcha: boolean; usesRateLimit: boolean } => {
    const argument = call.getArguments()[0];

    if (!argument || !Node.isObjectLiteralExpression(argument)) {
        return { usesCaptcha: false, usesRateLimit: false };
    }

    return { usesCaptcha: Boolean(argument.getProperty("captcha")), usesRateLimit: Boolean(argument.getProperty("rateLimit")) };
};

/**
 * Resolve a `.use(...)` argument to the middleware-factory call it ultimately
 * installs. A direct `.use(rateLimit(...))` is already that call; a `.use(mw)`
 * alias — `const mw = rateLimit(limiter, "bucket", …)` then `.use(mw)`, the shape
 * the storage/presence templates use — resolves through the local `const`'s
 * initializer. Resolution is by NAME within the same file (no cross-file/type
 * info), matching the feeder's name-based philosophy; an alias defined elsewhere
 * (import) or initialised by something other than a call returns `undefined`, so
 * the lint stays fail-closed.
 */
const resolveUseArgumentCall = (argument: TsNode): CallExpression | undefined => {
    if (Node.isCallExpression(argument)) {
        return argument;
    }

    if (!Node.isIdentifier(argument)) {
        return undefined;
    }

    const declaration = argument.getSourceFile().getVariableDeclaration(argument.getText());
    const initializer = declaration?.getInitializer();

    return initializer && Node.isCallExpression(initializer) ? initializer : undefined;
};

/** The protections a single `.use(...)` step installs (all `false` when it matches none). */
const NO_PROTECTIONS: Protections = { usesCaptcha: false, usesMask: false, usesRateLimit: false, usesRls: false };

/**
 * The protections a single `.use(arg)` step installs. `arg` is resolved to its
 * factory call ({@link resolveUseArgumentCall}, so a `const`-aliased
 * `.use(rateLimitByOwner)` counts), then matched against the `protectPublic({...})`
 * bundle or the individual factories in {@link MIDDLEWARE_FLAGS}.
 */
const useStepProtections = (useArgument: TsNode): Protections => {
    const argument = resolveUseArgumentCall(useArgument);
    const name = argument ? calleeNameOf(argument) : undefined;

    if (argument && name === "protectPublic") {
        const bundle = protectPublicFlags(argument);

        return { ...NO_PROTECTIONS, usesCaptcha: bundle.usesCaptcha, usesRateLimit: bundle.usesRateLimit };
    }

    if (name !== undefined && name in MIDDLEWARE_FLAGS) {
        return { ...NO_PROTECTIONS, [MIDDLEWARE_FLAGS[name] as keyof Protections]: true };
    }

    return NO_PROTECTIONS;
};

/**
 * Walk a builder chain leftward from `receiver` collecting the protective
 * middlewares its `.use(...)` steps install. Recognises the individual factories
 * in {@link MIDDLEWARE_FLAGS}, unwraps a `protectPublic({...})` bundle, and
 * resolves a `const`-aliased middleware (`.use(rateLimitByOwner)`) to its factory.
 */
const protectionsInChain = (receiver: TsNode): Protections => {
    const protections: Protections = { ...NO_PROTECTIONS };
    let node: TsNode = receiver;

    while (Node.isCallExpression(node)) {
        const chainCallee = node.getExpression();

        if (!Node.isPropertyAccessExpression(chainCallee)) {
            break;
        }

        const useArgument = chainCallee.getName() === "use" ? node.getArguments()[0] : undefined;

        if (useArgument) {
            const step = useStepProtections(useArgument);

            protections.usesCaptcha ||= step.usesCaptcha;
            protections.usesMask ||= step.usesMask;
            protections.usesRateLimit ||= step.usesRateLimit;
            protections.usesRls ||= step.usesRls;
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
 *
 * Best-effort: middleware is matched by callee NAME (not import origin), so a local
 * no-op `rateLimit`/`rls`/`verifyTurnstile` shadowing the real `@lunora` factory
 * would be counted as protection. The trade-off favours recall under degraded type
 * info; a `protectPublic()` call with a non-literal (statically opaque) config is
 * treated as carrying NEITHER guard so the abuse lints fail closed rather than
 * clear a possibly-unprotected public procedure.
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
