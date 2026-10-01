import { moduleOf } from "../../../../../shared/architecture-manifest";
import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a function that inserts into a table another module declares it owns
 * (`defineModule({ tables })`). Ownership is a boundary the app opted into: a
 * table written from outside its module couples the two, so a change to its
 * shape or invariants now has callers its owner does not know about. A file
 * outside every module writing an owned table counts too.
 *
 * An installed component counts as a module that owns its prefixed tables
 * (`voting_votes`) and its `lunora/<key>/` folder, so app code inserting straight
 * into a component's table — bypassing the functions the component exposes — is
 * flagged the same way.
 *
 * Runs only when the codegen feeder supplies modules and insert evidence; an
 * app with no declared module and no installed component sees nothing. Only `ctx.db.insert("table", …)`
 * is attributed today — a `patch`/`replace`/`delete` addresses a row by id, whose
 * table is not readable without the type checker.
 */
const crossModuleTableWrite: Lint = {
    categories: ["SCHEMA"],
    description:
        "A function inserts into a table that a different module declares it owns (`defineModule({ tables })`), or into an installed component's table from outside the component. The write couples the two modules: the owner can no longer change the table's shape or invariants without breaking a caller it does not know about.",
    facing: "INTERNAL",
    level: "WARN",
    name: "cross_module_table_write",
    remediation:
        "Move the write behind a function in the owning module and call that instead (`ctx.runMutation(internal.<owner>.<fn>, …)`), or move the table's ownership to the module that writes it. For a component's table, call the function the component exports for that write.",
    run: (context) => {
        const modules = context.modules ?? [];
        const owners = new Map(modules.flatMap((entry) => entry.tables.map((table) => [table, entry] as const)));

        if (owners.size === 0 || context.inserts === undefined) {
            return [];
        }

        return context.inserts.flatMap((insert) => {
            const owner = owners.get(insert.table);
            const writer = moduleOf(modules, insert.file);

            if (owner === undefined || owner.name === writer) {
                return [];
            }

            const ownedBy = owner.installed === true ? `the installed component \`${owner.name}\`` : `module \`${owner.name}\``;

            return [
                emit(crossModuleTableWrite, {
                    cacheKey: `cross_module_table_write:${insert.file}:${insert.exportName}:${insert.table}`,
                    detail: `\`${insert.exportName}\` (${insert.file}) inserts into \`${insert.table}\`, which ${ownedBy} owns, from ${writer === undefined ? "outside every module" : `module \`${writer}\``}.`,
                    metadata: {
                        exportName: insert.exportName,
                        file: insert.file,
                        owner: owner.name,
                        table: insert.table,
                        ...(owner.installed === true ? { installed: true } : {}),
                        ...(writer === undefined ? {} : { writer }),
                    },
                }),
            ];
        });
    },
    source: "static",
    title: "Function writes a table another module owns",
};

export default crossModuleTableWrite;
