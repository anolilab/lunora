import { isAbsolute, relative, sep } from "node:path";

import type { Node } from "ts-morph";

import type { DeclarationSiteIR } from "../../../ir";
import { lunoraRelativePath } from "../../ast";

/**
 * Where a schema node is declared, or `undefined` when its file is not source under `lunora/` (an installed package's
 * extension, a file outside the project). The schema walk threads one locator through every helper, so each IR row
 * records its own node.
 */
type SiteLocator = (node: Node) => DeclarationSiteIR | undefined;

/** A locator that records nothing: for callers that have no `lunora/` directory to resolve against. */
const noSite: SiteLocator = () => undefined;

/** The locator for schema files under `lunoraDirectory`. */
const siteLocatorFor =
    (lunoraDirectory: string): SiteLocator =>
    (node) => {
        const filePath = node.getSourceFile().getFilePath();
        const fromLunora = relative(lunoraDirectory, filePath);

        if (fromLunora === "" || fromLunora.startsWith("..") || isAbsolute(fromLunora) || fromLunora.split(sep).includes("node_modules")) {
            return undefined;
        }

        return { file: lunoraRelativePath(lunoraDirectory, filePath), line: node.getStartLineNumber() };
    };

export type { SiteLocator };
export { noSite, siteLocatorFor };
