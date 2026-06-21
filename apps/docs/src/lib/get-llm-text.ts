import type { InferPageType } from "fumadocs-core/source";

import type { source } from "@/lib/docs-source";

export const getLLMText = async (page: InferPageType<typeof source>): Promise<string> => {
    const processed = await page.data.getText("processed");

    return `# ${page.data.title} (${page.url})

${processed}`;
};
