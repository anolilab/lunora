/**
 * Scaffolding core for the access-rule editor (plan 025 Item 3). The sibling of
 * the visual schema editor's mutation core ({@link ./mutate}): it generates a
 * `definePolicy` / `defineRole` / `definePermission` **stub** file and,
 * optionally, wires `.use(rls(policies))` into an existing procedure's builder
 * chain. The stub is emitted from a string template (the layout is fixed); only
 * the wiring path parses with ts-morph, to edit one existing chain without
 * disturbing its handler. Both are pure string-in / string-out — no I/O, no
 * codegen (the handler wires those).
 *
 * Safety boundary mirrors plan 024 exactly: only **additive** scaffolding
 * applies. The scaffolder never authors the `when` predicate body (it emits a
 * `() => false` skeleton with a TODO) and never rewrites an existing
 * procedure's logic. A request to rewrite an existing policy's `when`, or any
 * non-additive request, is classified destructive and refused — those route
 * through the migration/manual-edit path, not this endpoint.
 */
import type { CallExpression, Node, SourceFile } from "ts-morph";
import { Project, SyntaxKind } from "ts-morph";

import { projectUsesUmbrella } from "../detect-framework";

/** Builder terminal methods — the kinds a procedure chain can end in. */
const TERMINAL_METHODS = new Set(["action", "mutation", "query", "stream"]);

/** A JS identifier, so a generated symbol/file name can't inject arbitrary text. */
const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/u;

/** Both spellings of the module the scaffolded builders come from. */
const SERVER_MODULES: ReadonlySet<string> = new Set(["@lunora/server", "lunorash/server"]);

/**
 * The server-module specifier to scaffold into a project's own source:
 * `lunorash/server` when the project depends on the umbrella, `@lunora/server`
 * when it installs the granular packages. Same detection codegen and the Vite
 * compose plugin use, so a scaffolded file imports what the emitted code does.
 */
const resolveServerModule = (projectRoot: string): string => (projectUsesUmbrella(projectRoot) ? "lunorash/server" : "@lunora/server");

/** Scaffold a new policy/role/permission stub file under `lunora/`. */
interface ScaffoldPolicyEdit {
    readonly kind: "scaffoldPolicy";

    /**
     * Base name for the generated file and its exported policy-set identifier,
     * e.g. `invoices` → `lunora/invoices.policies.ts` exporting `invoicesPolicies`.
     */
    readonly name: string;
    /** Logical table the scaffolded policy guards (used in the stub body). */
    readonly table: string;
}

/** Append `.use(rls(<policies>))` to an existing procedure's builder chain. */
interface WireRlsEdit {
    /** Exported procedure name to wire, e.g. `listInvoices`. */
    readonly exportName: string;
    readonly kind: "wireRls";
    /** Identifier of the policy set passed to `rls(...)`, e.g. `invoicesPolicies`. */
    readonly policies: string;
}

/** Additive scaffolder edits — the only requests the scaffolder applies. */
type AdditivePolicyEdit = ScaffoldPolicyEdit | WireRlsEdit;

/**
 * Destructive scaffolder requests — never applied. Rewriting an existing `when`
 * body changes evaluation semantics silently, so it is refused (STOP condition
 * in plan 025); carried as data so the editor can describe the request.
 */
interface DestructivePolicyEdit {
    readonly exportName?: string;
    readonly kind: "rewritePolicyWhen";
    readonly table?: string;
}

/** Any request the scaffolder can receive. */
type PolicyEdit = AdditivePolicyEdit | DestructivePolicyEdit;

const ADDITIVE_KINDS = new Set<PolicyEdit["kind"]>(["scaffoldPolicy", "wireRls"]);

/**
 * Classify a scaffolder request. Additive requests ({@link AdditivePolicyEdit})
 * apply directly; everything else (rewriting an existing predicate) changes
 * evaluation semantics and is destructive.
 */
const classifyPolicyEdit = (edit: PolicyEdit): "additive" | "destructive" => (ADDITIVE_KINDS.has(edit.kind) ? "additive" : "destructive");

/** Failure reasons a scaffolder request can report. */
type PolicyScaffoldFailureReason = "already-wired" | "destructive" | "invalid-identifier" | "unknown-procedure" | "unsupported-procedure-shape";

/** Tagged result of generating a stub file. */
type ScaffoldFileResult = { fileName: string; ok: true; source: string } | { ok: false; reason: PolicyScaffoldFailureReason };

/** Tagged result of wiring a procedure. */
type WireResult = { ok: false; reason: PolicyScaffoldFailureReason } | { ok: true; text: string };

/**
 * Generate the source of a new policy/role/permission stub file. The `when`
 * predicate is a `() => false` skeleton with a TODO — the scaffolder never
 * authors real logic, the developer fills it in. Pure (no I/O); the handler
 * writes the returned source and refuses to overwrite an existing file.
 *
 * `serverModule` is the specifier the PROJECT can resolve the builders from
 * (see {@link resolveServerModule}) — an umbrella-only install has no
 * `@lunora/server` on disk, so hard-coding it would scaffold a file that
 * cannot be bundled.
 */
const scaffoldPolicyFile = (edit: ScaffoldPolicyEdit, serverModule: string): ScaffoldFileResult => {
    // Both `name` and `table` flow into the generated source — `name` as
    // identifiers, `table` raw into the JSDoc prose below — so both must be
    // bare identifiers. Without this, a `table` of `*/ maliciousCode; /*` (or a
    // newline/backtick) could break out of the comment and inject code. The
    // `typeof` guards come first because `RegExp.test` coerces a non-string
    // (number, array) to a string that could slip past the pattern.
    if (typeof edit.name !== "string" || typeof edit.table !== "string" || !IDENTIFIER_PATTERN.test(edit.name) || !IDENTIFIER_PATTERN.test(edit.table)) {
        return { ok: false, reason: "invalid-identifier" };
    }

    const policiesIdentifier = `${edit.name}Policies`;
    const rolesIdentifier = `${edit.name}Roles`;
    const table = JSON.stringify(edit.table);

    const source = `import { definePermission, definePolicies, definePolicy, defineRole } from "${serverModule}";

/**
 * Access rules for the ${edit.table} table — scaffolded by the Lunora studio
 * (plan 025). The \`when\` predicates below DENY by default (\`() => false\`);
 * replace each TODO with the real condition, then wire \`${policiesIdentifier}\`
 * into the procedures that read/write ${edit.table} via
 * \`.use(rls(${policiesIdentifier}, { roles: ${rolesIdentifier} }))\`.
 */
export const ${policiesIdentifier} = definePolicies([
    definePolicy({
        on: "read",
        table: ${table},
        // TODO: return \`true\` to allow, a \`WhereInput\` to filter, or \`false\` to deny.
        when: () => false,
    }),
]);

/** Named permissions \`${policiesIdentifier}\` can check with \`ctx.auth.can(...)\`. */
export const ${edit.name}View = definePermission("${edit.name}:view");

/** Roles that grant the permissions above; register via \`rls(policies, { roles })\`. */
export const ${rolesIdentifier} = [defineRole("${edit.name}-admin", { permissions: [${edit.name}View] })];
`;

    return { fileName: `${edit.name}.policies.ts`, ok: true, source };
};

/** The receiver (chain to the left of the terminal `.query(...)`) for a procedure initializer, if it is a builder chain. */
const builderReceiver = (initializer: CallExpression): Node | undefined => {
    const callee = initializer.getExpression();

    // Bare-factory form (`query({ args, handler })`) — callee is an identifier,
    // there is no chain to append to. Only the builder form
    // (`c.use(...).query(handler)`) carries a receiver we can extend.
    if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) {
        return undefined;
    }

    const access = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);

    return TERMINAL_METHODS.has(access.getName()) ? access.getExpression() : undefined;
};

/**
 * Ensure `rls` is imported from the project's server module, so the appended
 * `.use(rls(...))` resolves and codegen keeps recognising the procedure. Adds
 * `rls` to an existing import of that module — or of the other spelling of it,
 * so a file already importing `lunorash/server` never gains a second, granular
 * import the project cannot resolve — otherwise inserts a fresh one. A no-op
 * when it is already imported. Purely additive — never touches other
 * specifiers or imports.
 */
const ensureRlsImport = (sourceFile: SourceFile, serverModule: string): void => {
    const serverImport = sourceFile.getImportDeclaration((declaration) => SERVER_MODULES.has(declaration.getModuleSpecifierValue()));

    if (serverImport === undefined) {
        sourceFile.addImportDeclaration({ moduleSpecifier: serverModule, namedImports: ["rls"] });

        return;
    }

    if (!serverImport.getNamedImports().some((named) => named.getName() === "rls")) {
        serverImport.addNamedImport("rls");
    }
};

/** True when a builder receiver chain already contains a `.use(rls(...))` call. */
const chainHasRls = (receiver: Node): boolean => {
    // `getDescendantsOfKind` excludes the receiver itself, but the receiver IS
    // the outermost `.use(rls(...))` call when the chain is already wired — so
    // check it alongside its descendants.
    const calls = receiver.getDescendantsOfKind(SyntaxKind.CallExpression);

    if (receiver.getKind() === SyntaxKind.CallExpression) {
        calls.push(receiver.asKindOrThrow(SyntaxKind.CallExpression));
    }

    for (const call of calls) {
        const callee = call.getExpression();

        if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) {
            continue;
        }

        const access = callee.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
        const [argument] = call.getArguments();

        if (
            access.getName() === "use" &&
            argument?.getKind() === SyntaxKind.CallExpression &&
            argument.asKindOrThrow(SyntaxKind.CallExpression).getExpression().getText() === "rls"
        ) {
            return true;
        }
    }

    return false;
};

/**
 * Append `.use(rls(<policies>))` to a procedure's builder chain, preserving the
 * terminal `.query(handler)` (and its handler body) byte-for-byte. Only the
 * **builder** form can be wired; the bare-factory form (`query({ handler })`)
 * has no chain and is reported `unsupported-procedure-shape` so the editor can
 * tell the developer to convert it rather than silently rewriting their code.
 */
const wireRlsIntoProcedure = (source: string, edit: WireRlsEdit, serverModule: string): WireResult => {
    // `policies` is interpolated into the appended `rls(...)` call, so it must be
    // a bare identifier. Guard `typeof` first — `RegExp.test` would coerce a
    // non-string and could let it slip past the pattern.
    if (typeof edit.policies !== "string" || !IDENTIFIER_PATTERN.test(edit.policies)) {
        return { ok: false, reason: "invalid-identifier" };
    }

    const project = new Project({ compilerOptions: { allowJs: true }, useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile("procedure.ts", source, { overwrite: true });

    const declaration = sourceFile.getVariableDeclaration(edit.exportName);
    const initializer = declaration?.getInitializer();

    if (declaration === undefined || initializer?.getKind() !== SyntaxKind.CallExpression) {
        return { ok: false, reason: "unknown-procedure" };
    }

    const receiver = builderReceiver(initializer.asKindOrThrow(SyntaxKind.CallExpression));

    if (receiver === undefined) {
        return { ok: false, reason: "unsupported-procedure-shape" };
    }

    if (chainHasRls(receiver)) {
        return { ok: false, reason: "already-wired" };
    }

    // Inject `.use(rls(policies))` between the chain-so-far and the terminal
    // `.query(handler)`. Replacing just the receiver leaves the handler intact.
    receiver.replaceWithText(`${receiver.getText()}.use(rls(${edit.policies}))`);

    // Keep the file compiling: the appended call references `rls`, which must
    // come from the server module for codegen to still recognise the procedure.
    ensureRlsImport(sourceFile, serverModule);

    return { ok: true, text: sourceFile.getFullText() };
};

export type {
    AdditivePolicyEdit,
    DestructivePolicyEdit,
    PolicyEdit,
    PolicyScaffoldFailureReason,
    ScaffoldFileResult,
    ScaffoldPolicyEdit,
    WireResult,
    WireRlsEdit,
};
export { classifyPolicyEdit, resolveServerModule, scaffoldPolicyFile, wireRlsIntoProcedure };
