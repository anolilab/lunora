/* eslint-disable unicorn/prevent-abbreviations -- "docs" is the user-facing CLI command name (cirrus docs); renaming the identifiers would diverge from the command users type */
import type { Logger } from "../util/logger.js";
import type { OpenUrlOptions } from "../util/open-url.js";
import { openUrl } from "../util/open-url.js";

interface DocsCommandOptions {
    logger: Logger;
    /** Inject the opener so tests don't spawn a browser. */
    opener?: OpenUrlOptions["opener"];
    /** Optional path under the docs site (e.g. "addons/dashboard"). */
    section?: string;
}

interface DocsCommandResult {
    code: number;
    url: string;
}

const DEFAULT_DOCS_URL = "https://cirrus.anolilab.dev/docs";

/** Strip leading and trailing `/` characters without a backtracking regex. */
const trimSlashes = (value: string): string => {
    let start = 0;
    let end = value.length;

    while (start < end && value[start] === "/") {
        start += 1;
    }

    while (end > start && value[end - 1] === "/") {
        end -= 1;
    }

    return value.slice(start, end);
};

const buildUrl = (section: string | undefined): string => {
    if (!section || section.length === 0) {
        return DEFAULT_DOCS_URL;
    }

    const trimmed = trimSlashes(section);

    if (trimmed.length === 0) {
        return DEFAULT_DOCS_URL;
    }

    return `${DEFAULT_DOCS_URL}/${trimmed}`;
};

const runDocsCommand = async (options: DocsCommandOptions): Promise<DocsCommandResult> => {
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

export type { DocsCommandOptions, DocsCommandResult };
export { runDocsCommand };
/* eslint-enable unicorn/prevent-abbreviations */
