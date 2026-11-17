// @ts-check
import config from "@anolilab/oxfmt-config";

/**
 * Ported option-for-option from `@anolilab/prettier-config` (the source of the
 * former prettier.config.js). `@anolilab/oxfmt-config` covers the shared subset;
 * the rest is set here so oxfmt formats exactly as Prettier did. Ignore rules
 * come from `.gitignore` and `.prettierignore`, which oxfmt reads by default.
 *
 * @type {import('oxfmt').OxfmtConfig}
 */
export default {
    ...config,
    arrowParens: "always",
    bracketSpacing: true,
    embeddedLanguageFormatting: "auto",
    endOfLine: "lf",
    htmlWhitespaceSensitivity: "css",
    insertPragma: false,
    jsxSingleQuote: false,
    printWidth: 160,
    proseWrap: "preserve",
    quoteProps: "as-needed",
    requirePragma: false,
    semi: true,
    singleQuote: false,
    tabWidth: 4,
    trailingComma: "all",
    useTabs: false,
    vueIndentScriptAndStyle: false,
    svelte: true,
    // Prettier never formatted TOML. oxfmt's Markdown output splits wrapped paragraphs into
    // blockquotes and indented list items, so Markdown stays out of oxfmt until that is fixed.
    ignorePatterns: ["**/*.toml", "**/*.md", "**/*.mdx"],
    overrides: [
        { files: [".eslintrc", ".prettierrc", ".stylelintrc"], options: { parser: "json" } },
        // oxfmt caps printWidth at 320 (prettier allowed 1000); package.json lines never reach it.
        { files: ["package*.json"], options: { printWidth: 320 } },
        { files: ["*.yml", "*.yaml"], options: { singleQuote: false } },
    ],
};
