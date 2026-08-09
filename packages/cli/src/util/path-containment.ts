import { sep } from "node:path";

/**
 * Is `candidate` the directory `root` itself, or something under it?
 *
 * The check every "this path came from data, keep it inside that directory"
 * guard needs, written once. Four of them had been hand-rolled — a Convex
 * snapshot's blob ids, an upload walk, the doctor's shadowed-CLI check, and a
 * backup manifest's `file` — three of which are security guards, all with the
 * same two subtleties to get wrong.
 *
 * **Compare with a separator, not by raw prefix.** `/backups-evil/x` starts
 * with `/backups` and is not inside it. And do not append a separator when
 * `root` already ends in one: that is what a directory at the filesystem root
 * looks like (`resolve("/")` is `/`), and `//` matches nothing.
 *
 * **Both sides must already be canonical** where symlinks matter. This compares
 * strings and makes no filesystem query, so a caller guarding a real path
 * passes it `realpath` output for BOTH arguments — canonicalising only the
 * candidate rejects legitimate paths whenever the root itself sits behind a
 * link.
 *
 * Deliberately not `path.relative(root, candidate).startsWith("..")`: that form
 * false-negatives on a legitimately named `..foo` directory.
 */
const isInsideDirectory = (root: string, candidate: string, separator: string = sep): boolean =>
    candidate === root || candidate.startsWith(root.endsWith(separator) ? root : `${root}${separator}`);

export default isInsideDirectory;
