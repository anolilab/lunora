import { moduleOf } from "../../../../../shared/architecture-manifest";
import { callSiteDescription, callSiteLabel, callSiteMetadata } from "../../call-site-scope";
import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a function that writes to a table another module declares it owns
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
 * Runs only when the codegen feeder supplies modules and write evidence; an
 * app with no declared module and no installed component sees nothing. Inserts,
 * by-id writes (`patch`/`replace`/`delete`, the table read off the id's type),
 * batch writes and facade writes all count; a write whose table is unreadable
 * (an untyped id) is skipped.
 *
 * A write inside a same-file helper is reported once, named by the helper and
 * listing the exports calling it, so moving the write into a helper does not hide
 * it — and one in a helper no export calls is still flagged. The fix that does satisfy the lint is putting the write in the
 * owner's files: an exported owner-module helper taking the caller's `ctx`, or a
 * registered owner mutation called through `ctx.runMutation`.
 */
const crossModuleTableWrite: Lint = {
    categories: ["SCHEMA"],
    description:
        "A function writes to a table that a different module declares it owns (`defineModule({ tables })`), or to an installed component's table from outside the component. The write couples the two modules: the owner can no longer change the table's shape or invariants without breaking a caller it does not know about.",
    facing: "INTERNAL",
    level: "WARN",
    name: "cross_module_table_write",
    remediation:
        "Move the write into the owning module and call it from there: an exported helper in the owner's files that takes the caller's `ctx` (`openInvoice(ctx, …)`) keeps the write in the caller's invocation, and a registered owner mutation runs through `ctx.runMutation(internal.<owner>.<fn>, …)`. Or move the table's ownership to the module that writes it. For a component's table, call the function the component exports for that write.",
    run: (context) => {
        const modules = context.modules ?? [];
        const owners = new Map(modules.flatMap((entry) => entry.tables.map((table) => [table, entry] as const)));

        const writes = [...(context.inserts ?? []), ...(context.tableWrites ?? [])];

        if (owners.size === 0 || writes.length === 0) {
            return [];
        }

        // One finding per function (or helper) and table, however many writes it makes.
        const seen = new Set<string>();

        return writes.flatMap((write) => {
            const owner = owners.get(write.table);
            const writer = moduleOf(modules, write.file);
            const cacheKey = `cross_module_table_write:${write.file}:${callSiteLabel(write.scope)}:${write.table}`;

            if (owner === undefined || owner.name === writer || seen.has(cacheKey)) {
                return [];
            }

            seen.add(cacheKey);

            const ownedBy = owner.installed === true ? `the installed component \`${owner.name}\`` : `module \`${owner.name}\``;

            return [
                emit(crossModuleTableWrite, {
                    cacheKey,
                    detail: `${callSiteDescription(write.scope)} (${write.file}) writes to \`${write.table}\`, which ${ownedBy} owns, from ${writer === undefined ? "outside every module" : `module \`${writer}\``}.`,
                    metadata: {
                        ...callSiteMetadata(write.scope),
                        file: write.file,
                        owner: owner.name,
                        table: write.table,
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
