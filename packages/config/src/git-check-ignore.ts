import { spawnSync } from "node:child_process";
import { basename, dirname } from "node:path";

/** Git's answer for one path: `unknown` outside a repository or without git, `timed-out` when git did not answer in time. */
type GitIgnoreStatus = "ignored" | "not-ignored" | "timed-out" | "unknown";

/**
 * Ask git whether `path` is ignored, counting every ignore source it reads (each
 * `.gitignore` up the tree, `.git/info/exclude`, the global excludes file).
 *
 * `noIndex` decides what a TRACKED file reads as. Without it git reports a tracked
 * file as not ignored whatever the patterns say, which is the right answer before
 * writing a secret into it. With it the patterns alone decide, which is the right
 * answer for a temp file that is about to be created.
 * @param path The file to ask about; git runs in its folder.
 * @param options How git is asked.
 * @param options.noIndex Pass `--no-index`, so a tracked file reads by its patterns alone.
 */
const gitCheckIgnore = (path: string, options: { noIndex: boolean }): GitIgnoreStatus => {
    const gitArguments = ["check-ignore", "-q", ...(options.noIndex ? ["--no-index"] : []), "--", basename(path)];
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- `git` must resolve from PATH (install location varies); args are fixed and no shell is involved
    const { error, status } = spawnSync("git", gitArguments, { cwd: dirname(path), stdio: "ignore", timeout: 5000 });

    if (error !== undefined && "code" in error && error.code === "ETIMEDOUT") {
        return "timed-out";
    }

    if (status === 0) {
        return "ignored";
    }

    return status === 1 ? "not-ignored" : "unknown";
};

export type { GitIgnoreStatus };
export { gitCheckIgnore };
