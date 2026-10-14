/**
 * The bits of `pnpm-workspace.yaml` the repo's own guards need: which top-level
 * directories hold workspace members, and what each catalog pins.
 *
 * It exists because five checkers had hardcoded `["apps", "examples",
 * "packages", "tests"]` and one had hardcoded nothing at all, so the set that
 * pnpm actually installs and the set the guards actually walk were free to
 * diverge — silently, since every one of them `catch`es an unreadable directory
 * and moves on. A new workspace glob would simply never be checked.
 *
 * Hand-scanned rather than parsed with a YAML library: none is resolvable from
 * the repo root under pnpm's strict `node_modules`, and both blocks are flat
 * maps of scalars anchored on indentation.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The lines of one column-0 block (`packages:`, `catalogs:`), excluding its header. */
const block = (name) => {
    const lines = readFileSync(join(rootDir, "pnpm-workspace.yaml"), "utf8").split("\n");
    const out = [];

    let inside = false;

    for (const line of lines) {
        if (new RegExp(String.raw`^${name}:\s*$`).test(line)) {
            inside = true;

            continue;
        }

        if (inside && /^\S/.test(line)) {
            break;
        }

        if (inside) {
            out.push(line);
        }
    }

    return out;
};

/**
 * Top-level directories a `<dir>/*` workspace glob covers, in file order.
 *
 * Negations (`!*​/__tests__/**`) are ignored: they exclude paths inside a member,
 * not members themselves.
 */
export const workspaceGroups = () => {
    const groups = [];

    for (const line of block("packages")) {
        const entry = /^\s*-\s*"?([^"\s#]+)"?\s*(?:#.*)?$/.exec(line);

        if (entry === null || entry[1].startsWith("!")) {
            continue;
        }

        const glob = /^([\w.-]+)\/\*$/.exec(entry[1]);

        if (glob !== null && !groups.includes(glob[1])) {
            groups.push(glob[1]);
        }
    }

    if (groups.length === 0) {
        throw new Error("workspace-config: pnpm-workspace.yaml declares no `<dir>/*` package globs — a guard walking zero directories passes vacuously.");
    }

    return groups;
};

/** `catalog name -> { package: specifier }` from the `catalogs:` block. */
export const catalogs = () => {
    const result = {};

    let current;

    for (const line of block("catalogs")) {
        const name = /^ {2}"?([\w.-]+)"?:\s*$/.exec(line);

        if (name !== null) {
            current = name[1];
            result[current] = {};

            continue;
        }

        const entry = /^ {4}"?(@?[^"\s:]+)"?:\s*"?([^"#\s][^"#]*?)"?\s*(?:#.*)?$/.exec(line);

        if (entry !== null && current !== undefined) {
            result[current][entry[1]] = entry[2].trim();
        }
    }

    return result;
};
