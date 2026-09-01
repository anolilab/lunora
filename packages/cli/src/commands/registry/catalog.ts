/**
 * The catalog: enumerate registry items and build/read the `index.json` the
 * `list` command shows. `listItemDirectories` is the single dir-scan shared by
 * the local-fallback catalog and the index generator.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

import { join } from "@visulima/path";

import safe from "./display";
import parseManifest from "./manifest";

/** One catalog entry as `lunora registry list` reports it. */
interface CatalogItem {
    description?: string;
    name: string;
}

/** A built index entry (catalog item plus its short `title`). */
interface IndexItem extends CatalogItem {
    title?: string;
}

/**
 * Optional-aware wrapper over the shared display sanitizer ({@link safe}): a
 * hostile `--source` registry can embed escape or BIDI sequences in a `name`/
 * `description` to spoof `list` output.
 */
const stripControlChars = (value: string | undefined): string | undefined => (value === undefined ? undefined : safe(value));

/** Names of the subdirectories under `root` that ship a `registry.json`. */
const listItemDirectories = (root: string): string[] =>
    readdirSync(root).filter((entry) => {
        const full = join(root, entry);

        return statSync(full).isDirectory() && existsSync(join(full, "registry.json"));
    });

/**
 * Collect the catalog from a resolved registry root. Prefers a top-level
 * `index.json` (`{ items: [{ name, description }] }`) — the curated, single-file
 * catalog the remote ships — and falls back to enumerating each subdirectory's
 * `registry.json` when no index is present (e.g. an ad-hoc local `--from` root).
 */
const collectCatalog = (root: string): CatalogItem[] => {
    const indexPath = join(root, "index.json");

    if (existsSync(indexPath)) {
        const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as { items?: unknown };

        if (Array.isArray(parsed.items)) {
            return parsed.items
                .filter((entry): entry is CatalogItem => typeof entry === "object" && entry !== null && typeof (entry as CatalogItem).name === "string")
                .map((entry) => {
                    // Strip control bytes from the untrusted remote strings before they
                    // can reach the terminal (ANSI/OSC escape-injection hardening).
                    return { description: stripControlChars(entry.description), name: stripControlChars(entry.name) ?? entry.name };
                });
        }
    }

    return listItemDirectories(root).map((name) => {
        const raw = JSON.parse(readFileSync(join(root, name, "registry.json"), "utf8")) as { description?: string };

        return { description: stripControlChars(raw.description), name };
    });
};

/**
 * Build the catalog (`index.json` contents) from a local registry root by
 * reading every item's `registry.json`. Used by both `lunora registry build`
 * and the registry tests so the committed index can't drift from the item dirs.
 */
const buildRegistryIndex = (root: string): { items: IndexItem[] } => {
    const items = listItemDirectories(root)
        .map((name) => {
            const manifest = parseManifest(JSON.parse(readFileSync(join(root, name, "registry.json"), "utf8")), name);

            return {
                ...(manifest.description === undefined ? {} : { description: manifest.description }),
                name: manifest.name,
                ...(manifest.title === undefined ? {} : { title: manifest.title }),
            };
        })
        .toSorted((a, b) => a.name.localeCompare(b.name));

    return { items };
};

export type { CatalogItem, IndexItem };
export { buildRegistryIndex, collectCatalog, listItemDirectories };
