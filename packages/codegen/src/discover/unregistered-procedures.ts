import type { Finding } from "@lunora/advisor";
import type { Project, SourceFile, Type, VariableDeclaration } from "ts-morph";
import { Node } from "ts-morph";

import { listLunoraSourceFiles, lunoraRelativePath } from "./ast";

/**
 * Every type a `lunora/` registration terminates in, mapped to the call that
 * produces it. A binding whose TYPE is one of these is a registration no matter
 * how the value was produced — which is the whole point: the syntactic scan can
 * be fooled by a factory, a resolved type cannot.
 *
 * Every kind here is discovered the same way and drops the same way: each
 * discoverer walks exported variable declarations and `continue`s past anything
 * whose initializer is not literally its own `define*` call, so a factory, an
 * alias, or a separate `export { … }` is skipped in silence
 * (`mutators.ts:153`, `shapes.ts:146`, `workflows.ts:208`, `queues.ts:131`,
 * `agents.ts:144`, `containers.ts:281`, `migrations.ts:132`). #651 reported it
 * for procedures; it was never only procedures.
 *
 * A row may be added ONLY once the kind's identity reaches
 * {@link Registrations}, or every healthy export of it is reported as dropped.
 * That is why crons are absent: `CronJobIR` records a per-job `name` and no
 * exporting binding, so there is nothing to match a `cronJobs()` export
 * against. Deliberately absent too: `RegisteredFunction` (the base interface,
 * never a terminal on its own), `RegisteredDataMigration` and
 * `RegisteredLunoraFunction` (codegen's own emit metadata, not user
 * registrations), and `@lunora/mcp`'s internal `RegisteredTool`.
 *
 * The call is stored whole rather than assembled from a kind because the halves
 * do not always match: `.stream()` hangs off the QUERY builder
 * (`QueryBuilder.stream`), so a dropped stream needs `query.….stream(handler)`.
 * Assembling `${kind}.input(…).${kind}(…)` printed `query.….query(…)` for every
 * kind, which handed an action author a query to paste.
 */
const REGISTRATION_BY_TYPE_NAME = new Map<string, { call: string; file?: string; note?: string }>([
    ["AgentDefinition", { call: "defineAgent({ … })", file: "agents" }],
    ["ContainerDefinition", { call: "defineContainer({ … })", file: "containers" }],
    ["QueueDefinition", { call: "defineQueue({ … })", file: "queues", note: "A dropped queue has no caller to fail — its consumer is simply never wired." }],
    ["RegisteredAction", { call: "action.input({ … }).action(handler)" }],
    [
        "RegisteredLifecycleHook",
        {
            call: "onConnect(handler)",
            // `lifecycle` is typed as the whole `LifecycleEventKind` union rather
            // than a literal, so — unlike the reactor below — there is nothing to
            // read that says which of the three factories produced this. Naming
            // one and being wrong twice out of three times is the papercut this
            // map exists to avoid, so the finding says so instead.
            note: "Substitute the hook you called: `onConnect`, `onDisconnect` and `onShardInit` share one type, so codegen cannot tell which you wrote. A dropped hook has no caller to fail — it silently never fires.",
        },
    ],
    ["RegisteredMigration", { call: "defineMigration({ … })", note: "A dropped migration never runs, so `lunora migrate up` reports nothing to do." }],
    ["RegisteredMutation", { call: "mutation.input({ … }).mutation(handler)" }],
    ["RegisteredMutator", { call: "defineMutator({ … })", file: "mutators" }],
    ["RegisteredQuery", { call: "query.input({ … }).query(handler)" }],
    ["RegisteredReactor", { call: "onQueryChange(select, handler)", note: "A dropped reactor has no caller to fail — it silently never runs." }],
    ["RegisteredShape", { call: "defineShape({ … })", file: "shapes" }],
    ["RegisteredStream", { call: "query.input({ … }).stream(handler)" }],
    ["WorkflowDefinition", { call: "defineWorkflow({ … })", file: "workflows" }],
]);

/**
 * The identities of everything discovery DID register, which is what a dropped
 * export is diffed against.
 *
 * Two sets because the IRs disagree about what they record: procedures,
 * mutators, shapes and migrations carry a `filePath`, so they key precisely.
 * Workflows, queues, agents and containers record only an `exportName` (their
 * `name` is the addressable identity, not a file), so they key on the bare name
 * — which can only ever hide a dropped export that shares a name with a
 * registered one, never invent one.
 */
type Registrations = {
    byName: ReadonlySet<string>;
    byPath: ReadonlySet<string>;
};

/** Whether discovery already registered this export under either keying. */
const isRegistered = ({ byName, byPath }: Registrations, relativePath: string, exportName: string): boolean =>
    byPath.has(`${relativePath}:${exportName}`) || byName.has(exportName);

/** A binding the type checker says is a registered procedure. */
type Registration = { call: string; file?: string; note?: string; typeName: string };

/** A registered procedure used to probe whether the checker resolves anything at all. */
type Witness = { declaration: VariableDeclaration; exportName: string; relativePath: string };

/**
 * Whether the checker resolved this type at all.
 *
 * An unresolvable type is `any` — `@lunora/server` not installed, no usable
 * tsconfig, unbuilt project references. That is the one state in which nothing
 * this pass reports means anything, so it is checked rather than assumed away;
 * see {@link typeCheckUnavailable}.
 */
const resolves = (type: Type): boolean => !type.isAny();

/**
 * The registration of a binding, or `undefined` when it is not one.
 *
 * Resolves through the alias symbol first so a re-exported or locally aliased
 * `RegisteredQuery` still matches.
 *
 * Unresolved types are rejected before the name is read, and that order is the
 * whole point: TypeScript keeps the alias symbol of an unresolved annotation,
 * so `const x: RegisteredQuery<…> = …` in a project with no `@lunora/server`
 * still answers `"RegisteredQuery"` off an `any`. Matching that would be a
 * string comparison against the text the author typed — which a factory fools
 * exactly as easily as the syntactic scan does, and which any unrelated type
 * that happens to be called `RegisteredQuery` trips.
 */
const registrationOf = (node: Node): Registration | undefined => {
    const type = node.getType();

    if (!resolves(type)) {
        return undefined;
    }

    const typeName = type.getAliasSymbol()?.getName() ?? type.getSymbol()?.getName();
    const registration = typeName === undefined ? undefined : REGISTRATION_BY_TYPE_NAME.get(typeName);

    return registration === undefined || typeName === undefined ? undefined : { ...registration, typeName };
};

/**
 * Whether this declaration is worth type-checking.
 *
 * `getType()` runs the checker, which is far more expensive than the rest of
 * codegen's syntactic passes, so it is spent only on the shapes that can
 * actually hide a registration: a call the scan did not recognise
 * (`export const x = makeQuery(...)`) or an identifier aliasing one
 * (`export const x = y`). Literals, arrow functions, objects and arrays are
 * skipped without touching the checker.
 */
const mayHideRegistration = (declaration: VariableDeclaration): boolean => {
    const initializer = declaration.getInitializer();

    if (initializer === undefined) {
        return false;
    }

    return Node.isCallExpression(initializer) || Node.isIdentifier(initializer) || Node.isPropertyAccessExpression(initializer);
};

/** Why codegen could not see this one, and what to write instead. */
type MissedRegistration = { cause: string; remediation: string };

const INDIRECT_INITIALIZER: MissedRegistration = {
    cause: "codegen recognises a registration only when the initializer is the registering call itself, and this one comes from a factory or an alias",
    remediation: "A factory that returns a registration cannot be read statically — inline it, or export what the factory builds.",
};

/**
 * `defineShape` and friends are read from ONE module each — `lunora/shapes.ts`,
 * `lunora/mutators.ts`, `lunora/workflows.ts`, `lunora/queues.ts`,
 * `lunora/agents.ts`, `lunora/containers.ts` — so the same call in any other
 * file is skipped no matter how directly it is assigned. Reporting the
 * indirection cause here would send the reader to inline a factory that is not
 * the problem, and they would still get nothing.
 */
const wrongFile = (file: string): MissedRegistration => {
    return {
        cause: `codegen reads this kind of registration only from \`lunora/${file}.ts\`, and this is a different module`,
        remediation: `Move it into \`lunora/${file}.ts\` — the declaration itself is fine.`,
    };
};

const SEPARATE_EXPORT_STATEMENT: MissedRegistration = {
    cause: "the binding is exported by a separate `export { … }` statement, and codegen reads the `export` keyword on the declaration itself",
    remediation: "Move the keyword onto the declaration and drop the separate export statement.",
};

const findingFor = (relativePath: string, exportName: string, registration: Registration, line: number, indirection: MissedRegistration): Finding => {
    const { call, file, note, typeName } = registration;
    // The wrong module beats every other cause: nothing about how the value was
    // produced matters while codegen is not reading this file for this kind —
    // and telling someone to assign a registration they already assigned
    // directly is how a diagnostic loses trust.
    const misplacedIn = file !== undefined && relativePath !== file ? file : undefined;
    const missed = misplacedIn === undefined ? indirection : wrongFile(misplacedIn);
    const suffix = note === undefined ? missed.remediation : `${note} ${missed.remediation}`;

    return {
        cacheKey: `procedure_not_registered:${relativePath}:${exportName}`,
        categories: ["SCHEMA"],
        description:
            "Codegen registers an export only when the declaration carries `export` and its initializer is literally the registering call. Written any other way it exists at runtime but never reaches the generated output — `_generated/api.ts` for a procedure, the lifecycle manifest for a hook or reactor — so a caller cannot address it and a hook never fires.",
        detail: `\`${exportName}\` in \`${relativePath}\` (line ${line.toString()}) has type \`${typeName}\` but was not registered — ${missed.cause}.`,
        facing: "INTERNAL",
        level: "WARN",
        metadata: { exportName, filePath: relativePath, line, typeName },
        name: "procedure_not_registered",
        remediation: misplacedIn === undefined ? `Assign the registration directly: \`export const ${exportName} = ${call};\`. ${suffix}` : suffix,
        title: "Procedure exists at runtime but is missing from the generated API",
    };
};

/**
 * Report exported bindings that ARE procedures by type but never made it into
 * `api.ts`.
 *
 * Three separate investigations traced back to the same
 * defect. `export default someProcedure` (now registered), `export const x =
 * factory(...)`, and `defineWorkflow(config)` all produced a function that
 * exists at runtime and is absent from the generated API — with codegen exiting
 * 0 and saying nothing. Each time the error surfaced somewhere else entirely
 * ("Property 'x' does not exist"), often in another package, and read as "you
 * named something wrong" rather than "your function was dropped".
 *
 * This is a type-level check rather than a syntactic one, so it cannot be
 * fooled by the very indirection that causes the bug.
 */
const namedExportFindings = (source: SourceFile, relativePath: string, registrations: Registrations): Finding[] => {
    const findings: Finding[] = [];

    for (const statement of source.getVariableStatements().filter((entry) => entry.isExported())) {
        for (const declaration of statement.getDeclarations()) {
            const exportName = declaration.getName();

            if (isRegistered(registrations, relativePath, exportName) || !mayHideRegistration(declaration)) {
                continue;
            }

            const registration = registrationOf(declaration);

            if (registration !== undefined) {
                findings.push(findingFor(relativePath, exportName, registration, declaration.getStartLineNumber(), INDIRECT_INITIALIZER));
            }
        }
    }

    return findings;
};

/**
 * `export default buildProcedure()` registers only when the initializer is a
 * readable builder chain, so an unresolvable factory behind a default export is
 * dropped exactly like a named one — and would otherwise be the single shape
 * this check could not see.
 */
const defaultExportFindings = (source: SourceFile, relativePath: string, registrations: Registrations): Finding[] => {
    if (isRegistered(registrations, relativePath, "default")) {
        return [];
    }

    const findings: Finding[] = [];

    for (const assignment of source.getExportAssignments().filter((entry) => !entry.isExportEquals())) {
        const registration = registrationOf(assignment.getExpression());

        if (registration !== undefined) {
            findings.push(findingFor(relativePath, "default", registration, assignment.getStartLineNumber(), INDIRECT_INITIALIZER));
        }
    }

    return findings;
};

/**
 * `const handler = query.…; export { handler };` — the export-declaration form.
 *
 * Discovery walks variable statements and asks each whether it `isExported()`,
 * which is false here: the `export` is a separate statement. So the procedure is
 * dropped from `api.ts` exactly like a factory-produced one, and the binding it
 * is dropped from looks like a perfectly ordinary builder chain — which is what
 * makes this shape worse than the ones above rather than merely another of them.
 *
 * The exported name is what a caller addresses, so `export { a as b }` is
 * checked and reported as `b`. Re-exports (`export { x } from "./other"`) are
 * skipped: the declaration lives in another file, and naming this one would send
 * the reader to the wrong place.
 */
const exportDeclarationFindings = (source: SourceFile, relativePath: string, registrations: Registrations): Finding[] => {
    const findings: Finding[] = [];

    for (const declaration of source.getExportDeclarations().filter((entry) => entry.getModuleSpecifier() === undefined)) {
        for (const specifier of declaration.getNamedExports()) {
            const exportName = specifier.getAliasNode()?.getText() ?? specifier.getName();

            if (isRegistered(registrations, relativePath, exportName)) {
                continue;
            }

            const local = specifier.getLocalTargetDeclarations().find((entry): entry is VariableDeclaration => Node.isVariableDeclaration(entry));

            if (local === undefined || !mayHideRegistration(local)) {
                continue;
            }

            const registration = registrationOf(local);

            if (registration !== undefined) {
                findings.push(findingFor(relativePath, exportName, registration, specifier.getStartLineNumber(), SEPARATE_EXPORT_STATEMENT));
            }
        }
    }

    return findings;
};

const fileFindings = (source: SourceFile, relativePath: string, registrations: Registrations): Finding[] => [
    ...namedExportFindings(source, relativePath, registrations),
    ...defaultExportFindings(source, relativePath, registrations),
    ...exportDeclarationFindings(source, relativePath, registrations),
];

/**
 * The registered exports the checker can be probed against.
 *
 * Deliberately the inverse of the `registered.has(...)` skip in
 * {@link namedExportFindings}: one walk selects the exports this pass reports
 * on, this one selects the exports it can trust, and they must keep keying
 * identically.
 *
 * Only a declaration initialized by a builder TERMINAL counts — a call on a
 * property access, `query.….query(handler)`. Discovery also registers the bare
 * factory form `query({ args, handler })`, but the generated `query` is a
 * non-callable builder object, so that call's type is `any` in a perfectly
 * well-installed project; taking it as a witness reported the toolchain as
 * blind when the truth was that the call itself is broken.
 *
 * Variable statements only. A project whose registrations are ALL `export
 * default` (or arrive via mutators, http routes, or the bare factory form)
 * yields no witness and gets no verdict — which errs toward saying nothing
 * rather than toward a warning nobody can act on.
 */
const registeredDeclarations = (source: SourceFile, relativePath: string, registrations: Registrations): Witness[] =>
    source
        .getVariableStatements()
        .filter((entry) => entry.isExported())
        .flatMap((entry) => entry.getDeclarations())
        .filter((declaration) => isRegistered(registrations, relativePath, declaration.getName()))
        .filter((declaration) => {
            const initializer = declaration.getInitializer();

            return initializer !== undefined && Node.isCallExpression(initializer) && Node.isPropertyAccessExpression(initializer.getExpression());
        })
        .map((declaration) => {
            return { declaration, exportName: declaration.getName(), relativePath };
        });

/**
 * Reported when types don't resolve, so nothing above could have been found.
 *
 * Without it a blind checker prints exactly what a clean project prints, which
 * is the indistinguishability the rest of this pass exists to end — see the
 * incident in {@link namedExportFindings}.
 *
 * Names the witness it failed to read, so "your types don't resolve" is one
 * `tsc` invocation away from being reproduced rather than being taken on faith.
 */
const typeCheckUnavailable = ({ exportName, relativePath }: Witness): Finding => {
    return {
        cacheKey: "procedure_type_check_unavailable",
        categories: ["SCHEMA"],
        description:
            "Codegen cross-checks every export in `lunora/` against its TYPE to catch a procedure the syntactic scan dropped — a factory-assigned export, an alias, a separate `export { … }`. That check needs the type checker to resolve `@lunora/server`; when it cannot, the check reports nothing regardless of what the code does.",
        detail: `Type resolution for \`lunora/\` is unavailable — the registered procedure \`${exportName}\` in \`${relativePath}\` types as \`any\`, as does every other one — so codegen cannot tell you when an export is dropped from \`_generated/api.ts\`. A dropped procedure will surface as \`Property '<name>' does not exist\` at its call site instead.`,
        facing: "INTERNAL",
        level: "WARN",
        metadata: { exportName, filePath: relativePath },
        name: "procedure_type_check_unavailable",
        remediation: `Check what codegen sees: \`${exportName}\` should have a procedure type, not \`any\`. It needs a \`tsconfig.json\` at or above \`lunora/\` — the one codegen finds walking up from there, which is not necessarily the one your editor uses — resolving \`lunorash\` / \`@lunora/server\` to declarations that exist on disk (a workspace dependency has to be built first).`,
        title: "Codegen cannot type-check `lunora/`, so dropped procedures go unreported",
    };
};

const discoverUnregisteredProcedures = (project: Project, lunoraDirectory: string, registrations: Registrations): Finding[] => {
    const findings: Finding[] = [];
    const witnesses: Witness[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        // Only files the discovery pass already loaded — never add one here, so
        // this stays a read over work that has been done rather than a second
        // parse of the tree.
        const source: SourceFile | undefined = project.getSourceFile(filePath);

        if (source === undefined) {
            continue;
        }

        const relativePath = lunoraRelativePath(lunoraDirectory, filePath);

        findings.push(...fileFindings(source, relativePath, registrations));
        witnesses.push(...registeredDeclarations(source, relativePath, registrations));
    }

    // ONE resolving procedure is enough to prove the checker, so `every` walks
    // only until it finds one: a healthy project spends a single `getType()`
    // here, and a blind one spends error-type lookups. Requiring *all* of them
    // to fail — rather than sampling the first — keeps the verdict independent
    // of file order, which is what a partially-resolving project would otherwise
    // make it. No witness at all is not evidence of anything.
    const [first] = witnesses;

    if (first !== undefined && witnesses.every(({ declaration }) => !resolves(declaration.getType()))) {
        findings.push(typeCheckUnavailable(first));
    }

    return findings.toSorted((a, b) => a.cacheKey.localeCompare(b.cacheKey));
};

export default discoverUnregisteredProcedures;
