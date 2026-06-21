module.exports = {
    extends: ["@anolilab/commitlint-config"],
    // Merge commits are not Conventional Commits and have no place in the
    // type-enum. commitlint's defaultIgnores only skips the auto-generated
    // "Merge branch …" / "Merge pull request …" subjects; this also skips a
    // descriptive merge subject (e.g. "Merge: …" or "merge: …"), so a
    // `git merge` never needs --no-verify. Concatenated with the extended
    // config's ignores; a normal commit like "fix: merge configs" is
    // unaffected (it does not start with "merge").
    ignores: [(message) => /^merge\b/i.test(message.trimStart())],
    rules: {
        // overwrite rules here
        // or extend rules
    },
};
