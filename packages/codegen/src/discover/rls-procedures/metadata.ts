import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node } from "ts-morph";

import type { RlsMetadataIR, RlsPolicyIR, RlsRoleIR } from "../../ir";
import { listLunoraSourceFiles, lunoraRelativePath, stringPropertyOf } from "../ast";
import exportedProcedureChains from "../functions/exported-procedure-chains";
import { rlsCallsInChain } from "./internal-chain";

/** The operations `definePolicy({ on })` accepts; anything else is ignored as malformed. */
const POLICY_OPERATIONS = new Set<RlsPolicyIR["on"]>(["delete", "insert", "read", "update"]);

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
 * `rlsFromBuilderChain` but yields the richer metadata the studio reads rather
 * than the lint's table-name set.
 */
const rlsMetadataFromChain = (receiver: TsNode, file: string, procedure: string): { policies: RlsPolicyIR[]; roles: RlsRoleIR[] } => {
    const calls = rlsCallsInChain(receiver);

    return {
        policies: calls.flatMap((call) => extractPolicies(call, file, procedure)),
        roles: calls.flatMap((call) => extractRoles(call)),
    };
};

/**
 * Aggregate the schema-wide RLS metadata the studio's read-only inspector reads:
 * every statically-discovered `(table, on, procedure)` policy entry plus every
 * role declared via `rls(policies, { roles })`. Walks the same builder chains as
 * `discoverRlsProcedures` but extracts the richer `{ on }` operation +
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

export default discoverRlsMetadata;
