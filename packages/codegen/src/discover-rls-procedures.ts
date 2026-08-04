import type { CallExpression, Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { classifyProcedureCall, listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { RlsMetadataIR, RlsPolicyIR, RlsProcedureIR, RlsRoleIR } from "./ir";

// ---------------------------------------------------------------------------
// Builder-chain helpers
// ---------------------------------------------------------------------------

/**
 * True when `node` is a `CallExpression` whose callee resolves to the name
 * `"rls"` — either a bare identifier (`rls(policies)`) or a property access
 * (`rlsModule.rls(policies)`). We match by name rather than import origin so
 * the check is robust even when ts-morph has degraded type info.
 */
const isRlsCall = (node: TsNode): boolean => {
    if (!Node.isCallExpression(node)) {
        return false;
    }

    const callee = node.getExpression();

    if (Node.isIdentifier(callee)) {
        return callee.getText() === "rls";
    }

    if (Node.isPropertyAccessExpression(callee)) {
        return callee.getName() === "rls";
    }

    return false;
};

/**
 * Extract the string-literal `table` property values from the first argument of
 * an `rls(policies)` call. `policies` is expected to be an array literal of
 * object literals, each with a `table: "name"` property assignment.
 *
 * When the argument is not a literal array (a variable reference), returns `[]`
 * (conservative: `usesRls` is still `true` but table names are unknown).
 */
const extractPolicyTables = (rlsCall: CallExpression): string[] => {
    const argument = rlsCall.getArguments()[0];

    if (!argument || !Node.isArrayLiteralExpression(argument)) {
        // Non-literal array → can't enumerate tables statically.
        return [];
    }

    const tables: string[] = [];

    for (const element of argument.getElements()) {
        if (!Node.isObjectLiteralExpression(element)) {
            continue;
        }

        const tableProperty = element.getProperty("table");

        if (!tableProperty || !Node.isPropertyAssignment(tableProperty)) {
            continue;
        }

        const initializer = tableProperty.getInitializer();

        if (initializer && Node.isStringLiteral(initializer)) {
            tables.push(initializer.getLiteralText());
        }
    }

    return tables;
};

/**
 * Walk a builder chain leftward from `receiver` (the expression to the left of the
 * terminal `.query(...)` / `.mutation(...)` call) and collect every `rls(...)`
 * `CallExpression` it carries through a `.use(rls(...))` step. The single source of
 * truth for the chain shape; the lint ({@link rlsFromBuilderChain}) and the studio
 * inspector metadata ({@link rlsMetadataFromChain}) each layer their own extraction
 * over the same walk, so the chain-recognition invariant lives in one place.
 *
 * Structure recognised (leftward) — in `c.use(rls([...])).query(handler)` the
 * `c.use(rls([...]))` portion is the receiver and `.query(handler)` is terminal.
 * The chain is a nested `CallExpression` tree; each step is a `CallExpression` whose
 * callee is a `PropertyAccessExpression` (the builder method `.use`/`.input`/… and
 * its argument). A `.use(rls(...))` step is the property name `"use"` with a first
 * argument that is an `rls(...)` call (callee an identifier/property named `"rls"`).
 */
const rlsCallsInChain = (receiver: TsNode): CallExpression[] => {
    const calls: CallExpression[] = [];
    let node: TsNode = receiver;

    while (Node.isCallExpression(node)) {
        const chainCallee = node.getExpression();

        if (!Node.isPropertyAccessExpression(chainCallee)) {
            break;
        }

        if (chainCallee.getName() === "use") {
            const argument = node.getArguments()[0];

            if (argument && isRlsCall(argument)) {
                calls.push(argument as CallExpression);
            }
        }

        node = chainCallee.getExpression();
    }

    return calls;
};

/**
 * Lint view of a builder chain: whether it carries any `.use(rls(...))` and the
 * statically-readable table names from those `rls(policies)` arguments.
 */
const rlsFromBuilderChain = (receiver: TsNode): { rlsTables: string[]; usesRls: boolean } => {
    const calls = rlsCallsInChain(receiver);

    return { rlsTables: calls.flatMap((call) => extractPolicyTables(call)), usesRls: calls.length > 0 };
};

// ---------------------------------------------------------------------------
// Table-access discovery inside a function body
// ---------------------------------------------------------------------------

/**
 * Read-access call sites: `ctx.db.query("table")` / `db.query("table")`,
 * `ctx.db.findMany("table", ...)` / `db.findMany("table", ...)`, and the same
 * for `findFirst` / `findFirstOrThrow` / `get`. These are the public
 * `DatabaseWriter` read entry points that RLS wraps.
 */
const READ_METHODS = new Set(["findFirst", "findFirstOrThrow", "findMany", "get", "query"]);

/**
 * Write-access call sites: `ctx.db.insert("table", ...)` / `db.insert(...)`,
 * and `patch` / `replace` / `delete` (id-based, table isn't always a literal —
 * we capture the first string-literal argument when present). The batch forms
 * (`insertMany("table", …)`, `deleteMany`/`patchMany`) write through the same
 * paths, so they count as writes too — otherwise a procedure that writes a
 * policy-gated table ONLY via a batch method would slip past the
 * `rls-uncovered-table` advisor.
 */
const WRITE_METHODS = new Set(["delete", "deleteMany", "insert", "insertMany", "patch", "patchMany", "replace"]);

/** True when `call` is a `ctx.db.<method>(...)` or bare `db.<method>(...)` call. */
const isDatabaseCall = (call: CallExpression, methodSet: Set<string>): boolean => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee) || !methodSet.has(callee.getName())) {
        return false;
    }

    const receiver = callee.getExpression();

    if (Node.isPropertyAccessExpression(receiver)) {
        return receiver.getName() === "db";
    }

    return Node.isIdentifier(receiver) && receiver.getText() === "db";
};

/**
 * String-literal first argument of a `ctx.db.<method>("table", ...)` call, or
 * `""` when the argument is not a string literal (dynamic table — not lintable).
 */
const tableArgumentOf = (call: CallExpression): string => {
    const argument = call.getArguments()[0];

    return argument && Node.isStringLiteral(argument) ? argument.getLiteralText() : "";
};

/**
 * Discover the set of tables read and written inside the lexical scope of an
 * ancestor `VariableDeclaration` (the exported procedure binding). We descend
 * from the declaration rather than from the terminal call so we also capture
 * reads/writes in helper closures defined inside the function body.
 */
const tablesAccessedIn = (declaration: TsNode): { tablesRead: string[]; tablesWritten: string[] } => {
    const tablesRead = new Set<string>();
    const tablesWritten = new Set<string>();

    for (const call of declaration.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (isDatabaseCall(call, READ_METHODS)) {
            const table = tableArgumentOf(call);

            if (table !== "") {
                tablesRead.add(table);
            }
        } else if (isDatabaseCall(call, WRITE_METHODS)) {
            const table = tableArgumentOf(call);

            if (table !== "") {
                tablesWritten.add(table);
            }
        }
    }

    return { tablesRead: [...tablesRead], tablesWritten: [...tablesWritten] };
};

// ---------------------------------------------------------------------------
// Top-level discovery
// ---------------------------------------------------------------------------

/**
 * Discover RLS usage for every exported Lunora procedure under the lunora source
 * directory. For each procedure, records whether its builder chain includes
 * `.use(rls(...))`, which tables the `rls(policies)` argument names, and which
 * tables the procedure reads/writes through `ctx.db`.
 *
 * Only functions registered via the **builder** form (`c.use(...).query(...)`)
 * can carry `.use(rls(...))`; the bare-factory form (`query({ handler })`) never
 * has a builder chain, so those procedures are always `usesRls: false` with empty
 * `rlsTables`. Both forms are still included so the lint can flag bare-factory
 * procedures that touch policy-covered tables.
 */
const procedureIrFromDeclaration = (declaration: TsNode, relativePath: string): RlsProcedureIR | undefined => {
    if (!Node.isVariableDeclaration(declaration)) {
        return undefined;
    }

    const initializer = declaration.getInitializer();

    if (!initializer || !Node.isCallExpression(initializer)) {
        return undefined;
    }

    // Shared classification (kind + visibility + builder receiver) —
    // single source of truth with function discovery.
    const classified = classifyProcedureCall(initializer);

    if (!classified) {
        return undefined;
    }

    // Only the builder form (`c.use(...).query(...)`) can carry
    // `.use(rls(...))`; a bare factory has no chain → never uses RLS.
    const chain = classified.receiver ? rlsFromBuilderChain(classified.receiver) : { rlsTables: [], usesRls: false };
    const { tablesRead, tablesWritten } = tablesAccessedIn(declaration);

    return {
        exportName: declaration.getName(),
        file: relativePath,
        rlsTables: chain.rlsTables,
        tablesRead,
        tablesWritten,
        usesRls: chain.usesRls,
        visibility: classified.visibility,
    };
};

const discoverRlsProcedures = (project: Project, lunoraDirectory: string): RlsProcedureIR[] => {
    const procedures: RlsProcedureIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        for (const statement of sourceFile.getVariableStatements()) {
            if (!statement.isExported()) {
                continue;
            }

            for (const declaration of statement.getDeclarations()) {
                const ir = procedureIrFromDeclaration(declaration, relativePath);

                if (ir) {
                    procedures.push(ir);
                }
            }
        }
    }

    return procedures;
};

/** The operations `definePolicy({ on })` accepts; anything else is ignored as malformed. */
const POLICY_OPERATIONS = new Set<RlsPolicyIR["on"]>(["delete", "insert", "read", "update"]);

/** Read a string-literal property from an object literal, or `undefined` when absent/non-literal. */
const stringPropertyOf = (object: TsNode, name: string): string | undefined => {
    if (!Node.isObjectLiteralExpression(object)) {
        return undefined;
    }

    const property = object.getProperty(name);

    if (!property || !Node.isPropertyAssignment(property)) {
        return undefined;
    }

    const initializer = property.getInitializer();

    return initializer && Node.isStringLiteral(initializer) ? initializer.getLiteralText() : undefined;
};

/**
 * Extract `{ table, on }` from each object-literal element of an `rls(policies)`
 * array literal — the read-only metadata the studio's RLS inspector lists. The
 * `when` predicate is intentionally NOT read: it's an opaque closure whose logic
 * lives in code, not the UI. A non-literal policies argument yields `[]`.
 */
const extractPolicies = (rlsCall: CallExpression, file: string, procedure: string): RlsPolicyIR[] => {
    const argument = rlsCall.getArguments()[0];

    if (!argument || !Node.isArrayLiteralExpression(argument)) {
        return [];
    }

    const policies: RlsPolicyIR[] = [];

    for (const element of argument.getElements()) {
        if (!Node.isObjectLiteralExpression(element)) {
            continue;
        }

        const on = stringPropertyOf(element, "on");

        if (on === undefined || !POLICY_OPERATIONS.has(on as RlsPolicyIR["on"])) {
            continue;
        }

        policies.push({ file, on: on as RlsPolicyIR["on"], procedure, table: stringPropertyOf(element, "table") ?? "" });
    }

    return policies;
};

/**
 * Read the permission names a `defineRole(name, { permissions: [...] })` element
 * grants. Each entry is either a string literal (`"posts:write"`) or a
 * `definePermission("name", …)` call whose first string-literal argument names
 * the permission. Non-literal entries are skipped (unreadable statically).
 */
const extractRolePermissions = (roleObject: TsNode): string[] => {
    if (!Node.isObjectLiteralExpression(roleObject)) {
        return [];
    }

    const property = roleObject.getProperty("permissions");

    if (!property || !Node.isPropertyAssignment(property)) {
        return [];
    }

    const initializer = property.getInitializer();

    if (!initializer || !Node.isArrayLiteralExpression(initializer)) {
        return [];
    }

    const permissions: string[] = [];

    for (const element of initializer.getElements()) {
        if (Node.isStringLiteral(element)) {
            permissions.push(element.getLiteralText());

            continue;
        }

        if (Node.isCallExpression(element)) {
            const firstArgument = element.getArguments()[0];

            if (firstArgument && Node.isStringLiteral(firstArgument)) {
                permissions.push(firstArgument.getLiteralText());
            }
        }
    }

    return permissions;
};

/**
 * Extract the roles registered through the second argument of an
 * `rls(policies, { roles: [...] })` call. Each `roles` element is expected to be
 * a `defineRole(name, options)` call or an object literal with a `name`. Returns
 * `[]` when no statically-readable `roles` option is present.
 */
const withDescription = (role: { name: string; permissions: string[] }, description: string | undefined): RlsRoleIR =>
    description === undefined ? role : { ...role, description };

/**
 * Parse one `roles` array element into an {@link RlsRoleIR}, or `undefined` when
 * it isn't a statically-readable role. Handles both the canonical
 * `defineRole("name", { description, permissions })` call and a bare
 * `{ name, permissions }` object literal.
 */
const roleFromElement = (element: TsNode): RlsRoleIR | undefined => {
    if (Node.isCallExpression(element)) {
        const nameArgument = element.getArguments()[0];

        if (!nameArgument || !Node.isStringLiteral(nameArgument)) {
            return undefined;
        }

        const optionsObject = element.getArguments()[1];
        const description = optionsObject ? stringPropertyOf(optionsObject, "description") : undefined;
        const permissions = optionsObject ? extractRolePermissions(optionsObject) : [];

        return withDescription({ name: nameArgument.getLiteralText(), permissions }, description);
    }

    if (Node.isObjectLiteralExpression(element)) {
        const name = stringPropertyOf(element, "name");

        if (name === undefined) {
            return undefined;
        }

        return withDescription({ name, permissions: extractRolePermissions(element) }, stringPropertyOf(element, "description"));
    }

    return undefined;
};

const extractRoles = (rlsCall: CallExpression): RlsRoleIR[] => {
    const optionsArgument = rlsCall.getArguments()[1];

    if (!optionsArgument || !Node.isObjectLiteralExpression(optionsArgument)) {
        return [];
    }

    const rolesProperty = optionsArgument.getProperty("roles");

    if (!rolesProperty || !Node.isPropertyAssignment(rolesProperty)) {
        return [];
    }

    const initializer = rolesProperty.getInitializer();

    if (!initializer || !Node.isArrayLiteralExpression(initializer)) {
        return [];
    }

    const roles: RlsRoleIR[] = [];

    for (const element of initializer.getElements()) {
        const role = roleFromElement(element);

        if (role) {
            roles.push(role);
        }
    }

    return roles;
};

/**
 * Inspector view of a builder chain: the policy entries and role declarations its
 * `.use(rls(...))` calls carry. Shares {@link rlsCallsInChain} with the lint's
 * {@link rlsFromBuilderChain} but yields the richer metadata the studio reads rather
 * than the lint's table-name set.
 */
const rlsMetadataFromChain = (receiver: TsNode, file: string, procedure: string): { policies: RlsPolicyIR[]; roles: RlsRoleIR[] } => {
    const calls = rlsCallsInChain(receiver);

    return {
        policies: calls.flatMap((call) => extractPolicies(call, file, procedure)),
        roles: calls.flatMap((call) => extractRoles(call)),
    };
};

/** The exported variable declarations in `sourceFile` whose initializer is a procedure builder chain with a receiver. */
const exportedProcedureChains = (sourceFile: SourceFile): { name: string; receiver: TsNode }[] => {
    const chains: { name: string; receiver: TsNode }[] = [];

    for (const statement of sourceFile.getVariableStatements()) {
        if (!statement.isExported()) {
            continue;
        }

        for (const declaration of statement.getDeclarations()) {
            const initializer = declaration.getInitializer();
            const classified = initializer && Node.isCallExpression(initializer) ? classifyProcedureCall(initializer) : undefined;

            if (classified?.receiver) {
                chains.push({ name: declaration.getName(), receiver: classified.receiver });
            }
        }
    }

    return chains;
};

/**
 * Aggregate the schema-wide RLS metadata the studio's read-only inspector reads:
 * every statically-discovered `(table, on, procedure)` policy entry plus every
 * role declared via `rls(policies, { roles })`. Walks the same builder chains as
 * {@link discoverRlsProcedures} but extracts the richer `{ on }` operation +
 * role/permission shape rather than the lint's table-name set.
 *
 * Only the **builder** form (`c.use(rls(...)).query(...)`) can declare policies,
 * so bare-factory procedures contribute nothing. The `when` predicate is never
 * read — it's an opaque JS closure whose logic belongs in code, not the UI.
 * Roles are deduped by name (first declaration wins) so a role registered on
 * several procedures lists once.
 */
const discoverRlsMetadata = (project: Project, lunoraDirectory: string): RlsMetadataIR => {
    const policies: RlsPolicyIR[] = [];
    const rolesByName = new Map<string, RlsRoleIR>();

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);
        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        for (const { name, receiver } of exportedProcedureChains(sourceFile)) {
            const metadata = rlsMetadataFromChain(receiver, relativePath, name);

            policies.push(...metadata.policies);

            for (const role of metadata.roles) {
                if (!rolesByName.has(role.name)) {
                    rolesByName.set(role.name, role);
                }
            }
        }
    }

    return { policies, roles: [...rolesByName.values()] };
};

export { discoverRlsMetadata };

export default discoverRlsProcedures;
