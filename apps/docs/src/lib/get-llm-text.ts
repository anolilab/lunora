import type { InferPageType } from "fumadocs-core/source";

import type { source } from "@/lib/docs-source";
import { siteConfig } from "~/site.config";

/**
 * Render one page for `llms-full.txt`.
 *
 * The `Source:` line is load-bearing rather than decorative. `llms-full.txt` is
 * over a megabyte, so nothing reads it whole: it gets chunked, and a chunk that
 * has drifted from its heading needs to still say where it came from. An
 * absolute URL survives that, and it is what a model cites when it answers from
 * this content. The path used to sit in the heading as a site-relative string,
 * which is neither citable nor resolvable once the file is read away from the
 * site.
 */
export const getLLMText = async (page: InferPageType<typeof source>): Promise<string> => {
    const processed = await page.data.getText("processed");

    return `# ${page.data.title}

Source: ${siteConfig.brand.url}${page.url}

${processed}`;
};
