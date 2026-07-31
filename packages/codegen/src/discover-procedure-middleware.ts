import type { CallExpression, Node as TsNode, Project, SourceFile, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { classifyProcedureCall, listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { ProcedureMiddlewareIR } from "./ir";
import { argumentNames, procedureArgumentObjects } from "./procedure-argument-objects";

/**
 * Middleware factory names mapped to the protection flag they set. Matched by the
 * callee name of a `.use(factory(...))` argument (bare identifier or property
 * access), mirroring how the RLS feeder matches `rls(...)` — by name, not import
 * origin, so degraded type info doesn't blind the lint.
 */
const MIDDLEWARE_FLAGS: Record<string, "usesCaptcha" | "usesEmailGate" | "usesMask" | "usesRateLimit" | "usesRls"> = {
    dbRateLimit: "usesRateLimit",
    emailGateMiddleware: "usesEmailGate",
    mask: "usesMask",
    rateLimit: "usesRateLimit",
    rls: "usesRls",
    verifyTurnstile: "usesCaptcha",
    verifyTurnstileMiddleware: "usesCaptcha",
};

/** Terminal words that mark a table as user/session-creating (captcha-expected). */
const USER_TABLE_WORDS: ReadonlySet<string> = new Set(["account", "credential", "member", "passkey", "session", "user"]);

/**
 * Split a table name into its camelCase / snake_case / kebab-case words, lowercased
 * (`"userPreferences"` -> `["user", "preferences"]`, `"account_credentials"` ->
 * `["account", "credentials"]`).
 */
const wordsOf = (name: string): string[] =>
    name
        .replaceAll(/[-_]/gu, " ")
        .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
        .split(" ")
        .filter(Boolean)
        .map((word) => word.toLowerCase());

/**
 * True when a table name's TERMINAL word is (a singular or simple plural of) one of
 * {@link USER_TABLE_WORDS} — `"users"` and `"account_credentials"` match,
 * `"userPreferences"` and `"sessionReplay"` do not, because `user`/`session` sit
 * there as a modifier on a different terminal word, not naming the table itself.
 * Mirrors the terminal-word matching in {@link isEmailArgumentName} rather than a
 * bare substring test, which the modifier cases used to false-positive on.
 */
const isUserTableName = (name: string): boolean => {
    const words = wordsOf(name);
    const last = words.at(-1);

    if (!last) {
        return false;
    }

    const singular = last.endsWith("s") ? last.slice(0, -1) : last;

    return USER_TABLE_WORDS.has(last) || USER_TABLE_WORDS.has(singular);
};

/**
 * True for an argument name that carries an email **address**.
 *
 * Separators are folded away and the name is matched on its terminal word, so
 * `email`, `e_mail`, `userEmail`, `billing_contact_email` and `emailAddress` all
 * count, while `emailVerified`, `emailOptIn` and `emailTemplateId` — which hold a
 * flag or an id, not an address `emailGateMiddleware` could select — do not.
 * Folding first (rather than one regex) keeps snake_case, kebab-case and
 * camelCase on the same path without a nested quantifier.
 */
const isEmailArgumentName = (name: string): boolean => {
    const folded = name.replaceAll(/[^a-z0-9]/giu, "").toLowerCase();

    return folded.endsWith("email") || folded.endsWith("emailaddress");
};

/**
 * Whether the procedure declares an email-shaped argument, or `undefined` when
 * its argument list can't be read statically (`.input(sharedSchema)`, a spread,
 * or a factory whose `args` comes from a variable).
 *
 * Tri-state on purpose. This feeds `signup_mutation_without_disposable_gating`,
 * which skips a procedure known to take no email — so collapsing "unreadable"
 * into `false` would silently clear the lint on a registration that may well
 * expose one. Unknown stays unknown and the lint keeps firing.
 */
const declaresEmailArgument = (call: CallExpression, receiver: TsNode | undefined): boolean | undefined => {
    const { objects, opaque } = procedureArgumentObjects(call, receiver);

    // A definite hit wins over opacity: finding the argument is enough, whatever
    // else the declaration hides.
    if (argumentNames(objects).some((name) => isEmailArgumentName(name))) {
        return true;
    }

    return opaque ? undefined : false;
};

/** The set of protections a builder chain carries. */
interface Protections {
    usesCaptcha: boolean;
    usesEmailGate: boolean;
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
const NO_PROTECTIONS: Protections = { usesCaptcha: false, usesEmailGate: false, usesMask: false, usesRateLimit: false, usesRls: false };

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
            protections.usesEmailGate ||= step.usesEmailGate;
            protections.usesMask ||= step.usesMask;
            protections.usesRateLimit ||= step.usesRateLimit;
            protections.usesRls ||= step.usesRls;
        }

        node = chainCallee.getExpression();
    }

    return protections;
};

/** `ctx.db` write methods that create/replace a row wholesale — the ones a user/session-creating write can arrive through. */
const USER_TABLE_INSERT_METHODS: ReadonlySet<string> = new Set(["insert", "insertMany", "insertManyUnsafe", "replace"]);

/** True when `call` is a `ctx.db.insert("table", …)` / `db.insertMany("table", …)` / … write into a user-shaped table. */
const isUserTableInsert = (call: CallExpression): boolean => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || !USER_TABLE_INSERT_METHODS.has(callee.getName())) {
        return false;
    }

    const receiver = callee.getExpression();
    const onDatabase = Node.isPropertyAccessExpression(receiver) ? receiver.getName() === "db" : Node.isIdentifier(receiver) && receiver.getText() === "db";

    if (!onDatabase) {
        return false;
    }

    const tableArgument = call.getArguments()[0];

    return Boolean(tableArgument && Node.isStringLiteral(tableArgument) && isUserTableName(tableArgument.getLiteralText()));
};

/** Method names that dispatch privileged, billable async work (fan-out surfaces). */
const FANOUT_METHODS = new Set(["create", "runAfter", "runAt", "send", "sendBatch"]);

/** `ctx.&lt;surface>` accessors those fan-out methods dispatch through. */
const FANOUT_SURFACES = new Set(["queues", "scheduler", "workflows"]);

/**
 * True when `call` is a privileged fan-out dispatch — a {@link FANOUT_METHODS}
 * call whose receiver chain roots at `ctx.scheduler` / `ctx.queues` /
 * `ctx.workflows` (`ctx.scheduler.runAfter(...)`, `ctx.queues.&lt;name>.send(...)`,
 * `ctx.workflows.&lt;name>.create(...)`). Anchoring to the `ctx.&lt;surface>` root — not
 * just the method name — keeps generic `.create`/`.send` calls on unrelated
 * objects from matching.
 */
const isFanOutCall = (call: CallExpression): boolean => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || !FANOUT_METHODS.has(callee.getName())) {
        return false;
    }

    let node: TsNode = callee.getExpression();

    while (Node.isCallExpression(node) || Node.isElementAccessExpression(node) || Node.isPropertyAccessExpression(node)) {
        if (Node.isPropertyAccessExpression(node) && FANOUT_SURFACES.has(node.getName())) {
            const receiver = node.getExpression();

            if (Node.isIdentifier(receiver) && receiver.getText() === "ctx") {
                return true;
            }
        }

        node = node.getExpression();
    }

    return false;
};

/** True when `call` is a `ctx.db.insertManyUnsafe(...)` / `db.insertManyUnsafe(...)` — the validator/trigger-bypassing bulk insert. */
const isUnsafeInsert = (call: CallExpression): boolean => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== "insertManyUnsafe") {
        return false;
    }

    const receiver = callee.getExpression();

    return Node.isPropertyAccessExpression(receiver) ? receiver.getName() === "db" : Node.isIdentifier(receiver) && receiver.getText() === "db";
};

/** AI SDK text/object generation helpers (re-exported from `@lunora/ai`) that accept a `maxOutputTokens` bound. */
const AI_GENERATION_CALLEES = new Set(["generateObject", "generateText", "streamObject", "streamText"]);

/** True when `call` is any AI generation helper, bounded or not. */
const isAiGeneration = (call: CallExpression): boolean => {
    const callee = calleeNameOf(call);

    return callee !== undefined && AI_GENERATION_CALLEES.has(callee);
};

/**
 * True when `call` is an AI generation helper ({@link AI_GENERATION_CALLEES})
 * invoked with an object-literal config that declares no `maxOutputTokens` key —
 * an unbounded generation. A non-object-literal config (statically opaque) is NOT
 * flagged: we can't see whether it carries a bound, so this fails open to avoid a
 * false positive on a hoisted-config call. A literal carrying a spread
 * (`{ ...shared, prompt }`) is opaque the same way — the bound may come from the
 * spread source — so it fails open too, matching the sibling config readers.
 */
const isUnboundedAiGeneration = (call: CallExpression): boolean => {
    const name = calleeNameOf(call);

    if (name === undefined || !AI_GENERATION_CALLEES.has(name)) {
        return false;
    }

    const argument = call.getArguments()[0];

    if (!argument || !Node.isObjectLiteralExpression(argument)) {
        return false;
    }

    // A spread makes the literal opaque — `maxOutputTokens` could be set by the
    // spread source, so fail open rather than flag a false positive.
    if (argument.getProperties().some((property) => Node.isSpreadAssignment(property))) {
        return false;
    }

    return !argument.getProperty("maxOutputTokens");
};

/** `ctx.*` members that emit a structured observability event. */
const EVENT_MEMBERS: ReadonlySet<string> = new Set(["log", "span", "trace"]);

/** `ctx.*` members that reach a model. */
const AI_MEMBERS: ReadonlySet<string> = new Set(["ai"]);

/** `ctx.*` members that send mail. */
const MAIL_MEMBERS: ReadonlySet<string> = new Set(["email", "mail"]);

/** `ctx.*` members that reach the outside world and can therefore fail in ways worth catching. */
const OUTBOUND_MEMBERS: ReadonlySet<string> = new Set(["ai", "browser", "fetch", "mail", "notify", "queues", "sql", "storage", "workflows"]);

/** True when any `ctx.&lt;member>` in `declaration` is one of `members`. */
const referencesContextMember = (declaration: TsNode, members: ReadonlySet<string>): boolean =>
    declaration.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).some((access) => {
        if (!members.has(access.getName())) {
            return false;
        }

        const receiver = access.getExpression();

        return Node.isIdentifier(receiver) && receiver.getText() === "ctx";
    });

/**
 * True when the body throws a bare `new Error(...)`.
 *
 * A bare `Error` crosses the RPC boundary as an opaque string: the client cannot
 * branch on it and the Studio cannot group it. `LunoraError` (and anything else
 * constructed from the error catalog) carries a stable code, so only the
 * unqualified builtin counts here — a subclass or a catalog helper does not.
 */
const throwsBareError = (declaration: TsNode): boolean =>
    declaration.getDescendantsOfKind(SyntaxKind.ThrowStatement).some((statement) => {
        const thrown = statement.getExpression();

        if (!Node.isNewExpression(thrown)) {
            return false;
        }

        const callee = thrown.getExpression();

        return Node.isIdentifier(callee) && callee.getText() === "Error";
    });

/**
 * The opt-out directive, with an optional trailing reason:
 *
 * ```ts
 * // lunora-advisor-exempt -- legacy endpoint, replaced by v2 in Q3
 * export const legacy = mutation({ ... });
 * ```
 *
 * A leading comment rather than a config list: it sits next to the code it
 * excuses, survives a file move, and shows up in the diff of whoever removes the
 * handler. The reason is captured into the artifact so an exemption has to be
 * argued in review rather than added silently.
 */
const EXEMPT_DIRECTIVE = "lunora-advisor-exempt";

/** Leading comment punctuation and indentation on one line of a comment block. */
const COMMENT_PREFIX = /^[\s*/]+/u;

/** A character that would make the directive part of a longer word. */
const WORD_CHARACTER = /[\w-]/u;

/**
 * Read the exemption directive off a declaration's leading comments.
 *
 * Matched line-by-line with plain string operations rather than one regex: the
 * pattern this replaced was flagged for super-linear backtracking (adjacent
 * optional whitespace runs), which would have let a crafted comment stall
 * codegen. Scanning is linear in the comment length.
 *
 * The directive must *start* a comment line and must not be a prefix of a longer
 * token. Without both rules, prose about the directive opts a procedure out —
 * "Do NOT add lunora-advisor-exempt here" and "lunora-advisor-exempt-later" both
 * used to exempt the handler, silently, and `compareToBaseline` skips exempt
 * rows, so every later regression on it (security lints included) went unseen.
 */
const exemptionOf = (declaration: VariableDeclaration): { exempt: boolean; exemptReason: string } => {
    // The directive sits above `export const ...`, i.e. on the statement, not the declarator.
    const statement = declaration.getFirstAncestorByKind(SyntaxKind.VariableStatement);
    const comments = (statement ?? declaration)
        .getLeadingCommentRanges()
        .map((range) => range.getText())
        .join("\n");

    for (const line of comments.split("\n")) {
        const body = line.replace(COMMENT_PREFIX, "");

        if (!body.startsWith(EXEMPT_DIRECTIVE)) {
            continue;
        }

        const rest = body.slice(EXEMPT_DIRECTIVE.length);

        if (WORD_CHARACTER.test(rest.charAt(0))) {
            continue;
        }

        const separator = rest.indexOf("--");
        // Stop at `*` so a directive inside a block comment cannot swallow its
        // closing delimiter into the reason.
        const reason = separator === -1 ? "" : (rest.slice(separator + 2).split("*")[0] ?? "");

        return { exempt: true, exemptReason: reason.trim() };
    }

    return { exempt: false, exemptReason: "" };
};

/** Behavioural facts read from the procedure declaration body. */
const behaviourOf = (
    declaration: TsNode,
): {
    callsMail: boolean;
    emitsEvent: boolean;
    fanOut: boolean;
    handlesErrors: boolean;
    reachesOutbound: boolean;
    runsAiGeneration: boolean;
    throwsBareError: boolean;
    unboundedAiGeneration: boolean;
    usesInsertManyUnsafe: boolean;
    writesUserTable: boolean;
} => {
    let fanOut = false;
    let runsAiGeneration = false;
    let unboundedAiGeneration = false;
    let usesInsertManyUnsafe = false;
    let writesUserTable = false;

    for (const call of declaration.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (isUserTableInsert(call)) {
            writesUserTable = true;
        }

        if (isFanOutCall(call)) {
            fanOut = true;
        }

        if (isUnsafeInsert(call)) {
            usesInsertManyUnsafe = true;
        }

        if (isAiGeneration(call)) {
            runsAiGeneration = true;
        }

        if (isUnboundedAiGeneration(call)) {
            unboundedAiGeneration = true;
        }

        if (writesUserTable && fanOut && usesInsertManyUnsafe && unboundedAiGeneration) {
            break;
        }
    }

    return {
        callsMail: referencesContextMember(declaration, MAIL_MEMBERS),
        emitsEvent: referencesContextMember(declaration, EVENT_MEMBERS),
        fanOut,
        handlesErrors: declaration.getDescendantsOfKind(SyntaxKind.TryStatement).length > 0,
        reachesOutbound: referencesContextMember(declaration, OUTBOUND_MEMBERS),
        runsAiGeneration: runsAiGeneration || referencesContextMember(declaration, AI_MEMBERS),
        throwsBareError: throwsBareError(declaration),
        unboundedAiGeneration,
        usesInsertManyUnsafe,
        writesUserTable,
    };
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
        : { usesCaptcha: false, usesEmailGate: false, usesMask: false, usesRateLimit: false, usesRls: false };

    // Every key of both fact bags is an IR field, so spreading keeps this in step
    // automatically when either gains one.
    return {
        ...behaviourOf(declaration),
        ...exemptionOf(declaration),
        ...protections,
        exportName: declaration.getName(),
        file: relativePath,
        hasEmailArg: declaresEmailArgument(initializer, classified.receiver),
        kind: classified.kind,
        visibility: classified.visibility,
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
