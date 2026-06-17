import { readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

import FastGlob from "fast-glob";
import type { MetaData, PageData, Source, VirtualFile } from "fumadocs-core/source";
import { loader } from "fumadocs-core/source";
import matter from "gray-matter";

let files: [string, string][];

if (typeof import.meta.glob === "function") {
    files = Object.entries(
        import.meta.glob<true, "raw">("/src/content/articles/**/*", {
            eager: true,
            import: "default",
            query: "?raw",
        }),
    );
} else {
    files = FastGlob.sync("./src/content/articles/**/*").map((file) => [file, readFileSync(file).toString()]);
}

const virtualFiles: VirtualFile[] = files.flatMap(([file, content]): VirtualFile[] => {
    const extension = extname(file);
    const virtualPath = relative("src/content/articles", join(process.cwd(), file));

    if (extension === ".mdx" || extension === ".md") {
        const parsed = matter(content);

        return [
            {
                data: {
                    ...parsed.data,
                    content: parsed.content,
                } as PageData,
                path: virtualPath,
                type: "page",
            },
        ];
    }

    if (extension === ".json") {
        return [
            {
                data: JSON.parse(content) as MetaData,
                path: virtualPath,
                type: "meta",
            },
        ];
    }

    return [];
});

// eslint-disable-next-line import/prefer-default-export
export const source = loader({
    baseUrl: "/articles",
    source: {
        files: virtualFiles,
    } as Source<{
        metaData: MetaData;
        pageData: PageData & {
            content: string;
        };
    }>,
});
