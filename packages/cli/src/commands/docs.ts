import type { Logger } from "../util/logger.js";
import type { OpenUrlOptions } from "../util/open-url.js";
import { openUrl } from "../util/open-url.js";

export interface DocsCommandOptions {
    logger: Logger;
    /** Inject the opener so tests don't spawn a browser. */
    opener?: OpenUrlOptions["opener"];
    /** Optional path under the docs site (e.g. "addons/dashboard"). */
    section?: string;
}

export interface DocsCommandResult {
    code: number;
    url: string;
}

const DEFAULT_DOCS_URL = "https://cirrus.anolilab.dev/docs";

const LEADING_SLASHES = /^\/+/u;
const TRAILING_SLASHES = /\/+$/u;

const buildUrl = (section: string | undefined): string => {
    if (!section || section.length === 0) {
        return DEFAULT_DOCS_URL;
    }

    const trimmed = section.replace(LEADING_SLASHES, "").replace(TRAILING_SLASHES, "");

    if (trimmed.length === 0) {
        return DEFAULT_DOCS_URL;
    }

    return `${DEFAULT_DOCS_URL}/${trimmed}`;
};

export const runDocsCommand = async (options: DocsCommandOptions): Promise<DocsCommandResult> => {
    const url = buildUrl(options.section);

    options.logger.info(`opening ${url}`);

    try {
        await openUrl(url, { opener: options.opener });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        options.logger.error(`docs: failed to open URL: ${message}`);

        return { code: 1, url };
    }

    return { code: 0, url };
};
