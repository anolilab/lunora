import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import type { CallEdgeIR, RowEffectIR, TableWriteIR } from "../ir";
import { sanitizeNamespace } from "../paths";
import { collectNodeRows, lunoraRelativePath } from "./ast";

/**
 * A top-level function or variable under `lunora/`: the unit a row write is
 * attributed to. A procedure (`export const x = mutation.mutation(…)`) is a
 * variable whose initializer is the whole handler, so its unit spans the handler
 * and every nested closure in it.
 */
interface Unit {
    endLine: number;
    /** Whether the unit is exported, so a caller reaches it through the API. */
    exported: boolean;
    /** Source file relative to `lunora/`, without extension. */
    file: string;
    /** The declared name: the export name when the unit is exported, else the local name. */
    name: string;
    /** The declaration node, walked for calls. */
    node: TsNode;
    /** 1-based first and last line of the declaration. */
    startLine: number;
}

/** One row-changing effect a unit performs. Two identical effects reached twice count once. */
interface Effect {
    fields?: string[];
    method: string;
    table: string;
}

/** The lookup key of a unit: its file and its name. */
const unitId = (file: string, name: string): string => `${file}:${name}`;

/** A top-level declaration as a unit, or `undefined` for a nested, anonymous, or default declaration. */
const topLevelUnit = (node: TsNode, file: string, name: string | undefined, exported: boolean): Unit | undefined =>
    name === undefined ? undefined : { endLine: node.getEndLineNumber(), exported, file, name, node, startLine: node.getStartLineNumber() };

/** Every top-level function and variable declaration under `lunora/`, as units. */
const unitsOf = (project: Project, lunoraDirectory: string): Unit[] => [
    ...collectNodeRows(project, lunoraDirectory, SyntaxKind.FunctionDeclaration, (node, file) =>
        node.getParent().getKind() === SyntaxKind.SourceFile ? topLevelUnit(node, file, node.getName(), node.isExported()) : undefined,
    ),
    ...collectNodeRows(project, lunoraDirectory, SyntaxKind.VariableDeclaration, (node, file) => {
        const statement = node.getVariableStatement();

        return statement?.getParent().getKind() === SyntaxKind.SourceFile ? topLevelUnit(statement, file, node.getName(), statement.isExported()) : undefined;
    }),
];

/**
 * The unit a call's identifier resolves to through the type checker, following an
 * import alias to its source. `undefined` when the callee is not a unit under
 * `lunora/`: a library function, a property call, or an unresolved name.
 */
const calleeUnitOf = (call: CallExpression, units: ReadonlyMap<string, Unit>, lunoraDirectory: string): Unit | undefined => {
    const callee = call.getExpression();

    if (!Node.isIdentifier(callee)) {
        return undefined;
    }

    const symbol = callee.getSymbol();
    const declaration = (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations()[0];

    if (declaration === undefined || !(Node.isFunctionDeclaration(declaration) || Node.isVariableDeclaration(declaration))) {
        return undefined;
    }

    const name = declaration.getName();
    const file = lunoraRelativePath(lunoraDirectory, declaration.getSourceFile().getFilePath());

    return name === undefined ? undefined : units.get(unitId(file, name));
};

/** Stable identity of one effect, so the fixpoint can tell a new effect from one it already holds. */
const effectKey = (effect: Effect): string => `${effect.table}|${effect.method}|${effect.fields?.join(",") ?? "*"}`;

/**
 * Assign each table write to the unit whose lines contain it. A write outside every
 * unit (module scope) has no owner, so it contributes nothing.
 */
const directEffectsOf = (units: ReadonlyArray<Unit>, tableWrites: ReadonlyArray<TableWriteIR>): Map<string, Map<string, Effect>> => {
    const effects = new Map<string, Map<string, Effect>>(units.map((unit) => [unitId(unit.file, unit.name), new Map()]));

    for (const write of tableWrites) {
        const owner = units.find((unit) => unit.file === write.file && unit.startLine <= write.line && write.line <= unit.endLine);

        if (owner !== undefined && write.table !== "") {
            effects.get(unitId(owner.file, owner.name))?.set(effectKey(write), { fields: write.fields, method: write.method, table: write.table });
        }
    }

    return effects;
};

/** The units a unit calls through an identifier that resolves to a unit in `lunora/`. */
const importCalleesOf = (unit: Unit, unitsById: ReadonlyMap<string, Unit>, lunoraDirectory: string): Unit[] =>
    unit.node
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .map((call) => calleeUnitOf(call, unitsById, lunoraDirectory))
        .filter((callee): callee is Unit => callee !== undefined);

/** Record each `ctx.run*` call edge as a call from its caller unit to the unit it names by namespace key. */
const addCallEdges = (
    callEdges: ReadonlyArray<CallEdgeIR>,
    unitsById: ReadonlyMap<string, Unit>,
    unitsByNamespaceKey: ReadonlyMap<string, Unit>,
    callees: Map<string, Unit[]>,
): void => {
    for (const edge of callEdges) {
        const caller = edge.scope.kind === "module" ? undefined : unitsById.get(unitId(edge.file, edge.scope.name));
        const callee = edge.target === undefined ? undefined : unitsByNamespaceKey.get(edge.target);

        if (edge.kind === "call" && caller !== undefined && callee !== undefined) {
            callees.get(unitId(caller.file, caller.name))?.push(callee);
        }
    }
};

/**
 * The units each unit calls: identifiers that resolve to a unit through an import,
 * and `ctx.run*` call edges that name a unit by its namespace key.
 */
const calleesOf = (units: ReadonlyArray<Unit>, lunoraDirectory: string, callEdges: ReadonlyArray<CallEdgeIR>): Map<string, Unit[]> => {
    const unitsById = new Map(units.map((unit) => [unitId(unit.file, unit.name), unit]));
    const unitsByNamespaceKey = new Map(units.map((unit) => [`${sanitizeNamespace(unit.file)}:${unit.name}`, unit]));
    const callees = new Map<string, Unit[]>(units.map((unit) => [unitId(unit.file, unit.name), importCalleesOf(unit, unitsById, lunoraDirectory)]));

    addCallEdges(callEdges, unitsById, unitsByNamespaceKey, callees);

    return callees;
};

/** Copy into `target` every effect of `source` it lacks. Returns whether `target` gained one. */
const inheritEffects = (target: Map<string, Effect> | undefined, source: Map<string, Effect> | undefined): boolean => {
    let gained = false;

    for (const [key, effect] of source ?? []) {
        if (target !== undefined && !target.has(key)) {
            target.set(key, effect);
            gained = true;
        }
    }

    return gained;
};

/**
 * Give every unit the effects of every unit it calls, repeating until no unit gains
 * one. A cycle of calls settles once each member holds the union of the others.
 */
const closeOverCalls = (units: ReadonlyArray<Unit>, effects: Map<string, Map<string, Effect>>, callees: ReadonlyMap<string, ReadonlyArray<Unit>>): void => {
    let changed = true;

    while (changed) {
        changed = false;

        for (const unit of units) {
            for (const callee of callees.get(unitId(unit.file, unit.name)) ?? []) {
                if (inheritEffects(effects.get(unitId(unit.file, unit.name)), effects.get(unitId(callee.file, callee.name)))) {
                    changed = true;
                }
            }
        }
    }
};

/**
 * Attribute every row-changing write to the exported units that can reach it.
 *
 * Writes are assigned to the unit that contains them, the call graph is closed over
 * so a unit inherits what it calls (through an import, or a `ctx.run*` edge), and
 * only exported units are reported: a caller reaches those through the API. The
 * table feeder still reports each write where it happens; this feeder adds the
 * writes that happen in a function the export calls, possibly in another file.
 */
const discoverRowEffects = (
    project: Project,
    lunoraDirectory: string,
    tableWrites: ReadonlyArray<TableWriteIR>,
    callEdges: ReadonlyArray<CallEdgeIR>,
): RowEffectIR[] => {
    const units = unitsOf(project, lunoraDirectory);
    const effects = directEffectsOf(units, tableWrites);

    closeOverCalls(units, effects, calleesOf(units, lunoraDirectory, callEdges));

    return units
        .filter((unit) => unit.exported)
        .flatMap((unit) =>
            [...(effects.get(unitId(unit.file, unit.name))?.values() ?? [])].map((effect) => {
                return {
                    ...effect,
                    exportName: unit.name,
                    file: unit.file,
                };
            }),
        );
};

export default discoverRowEffects;
