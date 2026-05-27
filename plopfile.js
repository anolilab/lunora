import { join } from "node:path";
import { cwd } from "node:process";

/**
 * @param string_ {string}
 * @returns {string}
 */
const capitalize = (string_) => string_.charAt(0).toUpperCase() + string_.slice(1);

/**
 * @param string_ {string}
 * @returns {string}
 */
const camelCase = (string_) => string_.replaceAll(/[-_](\w)/g, (_, c) => c.toUpperCase());

/**
 *
 * @param plop {import('plop').NodePlopAPI}
 * @returns {void}
 */
// eslint-disable-next-line func-names
export default function (plop) {
    plop.setHelper("capitalize", (text) => capitalize(camelCase(text)));
    plop.setHelper("camelCase", (text) => camelCase(text));

    plop.setGenerator("package", {
        actions(answers) {
            /**
             * @type {import("plop").ActionType[]}
             */
            const actions = [];

            if (!answers) {
                return actions;
            }

            const { category, description, outDir } = answers;
            const generatorName = answers.packageName ?? "";

            const data = {
                [`packageName`]: generatorName,
                category,
                description,
                outDir,
            };

            actions.push({
                abortOnFail: true,
                base: `plop/package`,
                data,
                destination: `./packages/{{category}}/{{dashCase packageName}}`,
                globOptions: { dot: true },
                templateFiles: `plop/package/**`,
                type: "addMany",
            });

            actions.push({
                data,
                path: join(cwd(), "package.json"),
                pattern: /"scripts": \{/,
                templateFile: `plop/package-scripts.hbs`,
                type: "append",
            });

            return actions;
        },
        description: `Generates a package`,
        prompts: [
            {
                choices: [
                    { name: "API", value: "api" },
                    { name: "Terminal", value: "terminal" },
                    { name: "Filesystem", value: "filesystem" },
                    { name: "Error & Debugging", value: "error-debugging" },
                    { name: "Data Manipulation", value: "data-manipulation" },
                    { name: "Storage", value: "storage" },
                    { name: "Email", value: "email" },
                    { name: "Tooling", value: "tooling" },
                ],
                message: `Select package category:`,
                name: "category",
                type: "list",
            },
            {
                message: `Enter package name:`,
                name: `packageName`,
                type: "input",
                validate: (value) => {
                    if (!value) {
                        return `package name is required`;
                    }

                    // check is case is correct
                    if (value !== value.toLowerCase()) {
                        return `package name must be in lowercase`;
                    }

                    // cannot have spaces
                    if (value.includes(" ")) {
                        return `package name cannot have spaces`;
                    }

                    return true;
                },
            },
            {
                message: `The description of this package:`,
                name: "description",
                type: "input",
            },
        ],
    });
}
