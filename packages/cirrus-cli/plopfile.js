/**
 * Plop generators for `cirrus init`. Mirrors the visulima monorepo's plop
 * pattern (see `visulima/plopfile.js`): one generator per template, each
 * just an `addMany` action that copies `plop-templates/<template>/**` into
 * the user-chosen destination, substituting `{{name}}` placeholders.
 *
 * The generators are consumed programmatically via `node-plop` from
 * `src/commands/init.ts`. The exported function shape is the standard
 * plop entry point so `pnpm exec plop` would also work for ad-hoc use.
 *
 * @param plop {import("plop").NodePlopAPI}
 * @returns {void}
 */
// eslint-disable-next-line import/no-unused-modules,func-names
export default function (plop) {
    const templates = ["vite", "standalone"];

    for (const template of templates) {
        plop.setGenerator(template, {
            description: `Scaffold a new Cirrus app from the ${template} template`,
            prompts: [
                {
                    type: "input",
                    name: "name",
                    message: "Project name:",
                    default: "cirrus-app",
                    validate: (value) => (value && value.length > 0 ? true : "name is required"),
                },
                {
                    type: "input",
                    name: "destination",
                    message: "Destination directory (relative to cwd):",
                    default: (answers) => `./${answers.name}`,
                },
            ],
            actions: (answers) => {
                if (!answers) {
                    return [];
                }

                return [
                    {
                        type: "addMany",
                        templateFiles: `plop-templates/${template}/**`,
                        base: `plop-templates/${template}`,
                        destination: "{{destination}}",
                        globOptions: { dot: true },
                        abortOnFail: true,
                    },
                ];
            },
        });
    }
}
