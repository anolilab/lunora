import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Split a `.gitignore` on either line ending, so a CRLF file's patterns still match. */
const GITIGNORE_LINE = /\r?\n/u;

/**
 * Make sure the `.gitignore` in `directory` covers every pattern in `patterns`,
 * appending only the ones it lacks. A no-op once they are all present, so a
 * second call changes nothing.
 *
 * ORDER IS LOAD-BEARING: git is last-match-wins, so a negation only works while
 * it sits below every pattern that would otherwise catch its file. An appended
 * pattern lands BELOW whatever the file already had, so when anything is
 * appended every negation in `patterns` is re-stated after the additions.
 * @param directory The directory whose `.gitignore` is ensured; the patterns are relative to it.
 * @param patterns The `.gitignore` lines the directory must carry.
 * @returns The patterns appended, empty when the file already covered them all.
 */
const ensureGitignoreEntries = (directory: string, patterns: ReadonlyArray<string>): string[] => {
    const gitignorePath = join(directory, ".gitignore");
    const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
    const lines = new Set(existing.split(GITIGNORE_LINE).map((line) => line.trim()));
    const missing = patterns.filter((pattern) => !lines.has(pattern));

    if (missing.length === 0) {
        return [];
    }

    const additions = missing.some((pattern) => !pattern.startsWith("!"))
        ? [...missing.filter((pattern) => !pattern.startsWith("!")), ...patterns.filter((pattern) => pattern.startsWith("!"))]
        : missing;
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";

    writeFileSync(gitignorePath, `${existing}${prefix}\n# Lunora — local secrets and dev state, never commit\n${additions.join("\n")}\n`, "utf8");

    return missing;
};

export default ensureGitignoreEntries;
