// eslint-disable-next-line e18e/ban-dependencies -- module-replacements@3.1.0 added gray-matter to its "preferred" manifest (suggesting @11ty/gray-matter). We stay on gray-matter deliberately: patches/gray-matter@4.0.3.patch rewrites its removed safeLoad/safeDump onto js-yaml 4, which is what keeps the whole tree off the unmaintained js-yaml 3 (see the js-yaml override in pnpm-workspace.yaml). Swapping the package would drop that patch, so it is a migration, not a lint fix.
import matter from "gray-matter";

/**
 * Loads every package changelog bundled into src/content/changelogs by
 * scripts/copy-package-docs.js.
 *
 * Vite statically replaces this `import.meta.glob(...)` call with a record of
 * the matched files at build time, so the bundled server/function carries the
 * content inline and never reads the filesystem at runtime. It must not be
 * gated behind a `typeof import.meta.glob === "function"` check — see the note
 * in blog-source for why that guard is always false in the built output.
 */
const files: [string, string][] = Object.entries(
    import.meta.glob<true, "raw">("/src/content/changelogs/**/*.md", {
        eager: true,
        import: "default",
        query: "?raw",
    }),
);

const MD_EXTENSION = /\.md$/;

const slugFromPath = (file: string): string => (file.split("/").pop() ?? file).replace(MD_EXTENSION, "");

export interface ChangelogEntry {
    content: string;
    key: string;
    title: string;
}

export const listChangelogs = (): ChangelogEntry[] =>
    files
        .map(([file, raw]): ChangelogEntry => {
            const parsed = matter(raw);
            const key = slugFromPath(file);

            return {
                content: parsed.content,
                key,
                title: typeof parsed.data.title === "string" ? parsed.data.title : key,
            };
        })
        .toSorted((a, b) => a.title.localeCompare(b.title));
