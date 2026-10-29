import preset from "@anolilab/semantic-release-preset/pnpm" with { type: "json" };

// multi-semantic-release merges this over every package's .releaserc.json. Without the git plugin
// each package only tags and publishes; the workflow then pushes all bumps as one commit, since
// every branch push rebuilds the merge queue.
const plugins = preset.plugins
    .filter((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) !== "@semantic-release/git")
    .map((plugin) => {
        if (!Array.isArray(plugin) || plugin[0] !== "@semantic-release/release-notes-generator") {
            return plugin;
        }

        const [name, options] = plugin;

        // The bump commit lands after the tags, inside every released package's next range.
        // Must precede the generic `chore` entry: the first matching type wins.
        const types = [{ hidden: true, scope: "release", type: "chore" }, ...options.presetConfig.types];

        return [name, { ...options, presetConfig: { ...options.presetConfig, types } }];
    });

export default { plugins };
