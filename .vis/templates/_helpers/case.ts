/**
 * String-casing helpers shared by the cirrus-* generators. Kept here so each
 * template stays small and the conversion rules don't drift between them.
 */
// sonarjs/slow-regex: the character classes [-_\s] and \w don't overlap, so
// there is no catastrophic backtracking risk on the +(\w) boundary.
// eslint-disable-next-line sonarjs/slow-regex
const CAMEL_BOUNDARY = /[-_\s]+(\w)/gu;

const CAMEL_LEADING_UPPER = /^[A-Z]/u;

const DASH_CAMEL_SPLIT = /([a-z0-9])([A-Z])/gu;

const DASH_SEPARATORS = /[_\s]+/gu;

const JS_IDENTIFIER = /^[$A-Z_a-z][\w$]*$/u;

const PACKAGE_NAME = /^[a-z][\da-z-]*$/u;

export const camelCase = (input: string): string =>
    input.replaceAll(CAMEL_BOUNDARY, (_, c: string) => c.toUpperCase()).replace(CAMEL_LEADING_UPPER, (c) => c.toLowerCase());

export const dashCase = (input: string): string => input.replaceAll(DASH_CAMEL_SPLIT, "$1-$2").replaceAll(DASH_SEPARATORS, "-").toLowerCase();

export const kebabCase = dashCase;

export const pascalCase = (input: string): string => {
    const camel = camelCase(input);
    return camel.charAt(0).toUpperCase() + camel.slice(1);
};

export const snakeCase = (input: string): string => dashCase(input).replaceAll("-", "_");

export type FileNameCase = "camel" | "kebab" | "pascal" | "snake";

export const FILE_NAME_CASE_VALUES: readonly FileNameCase[] = ["camel", "kebab", "pascal", "snake"];

export const isFileNameCase = (value: unknown): value is FileNameCase =>
    typeof value === "string" && (FILE_NAME_CASE_VALUES as readonly string[]).includes(value);

export const formatFileName = (input: string, style: FileNameCase): string => {
    switch (style) {
        case "kebab":
            return dashCase(input);
        case "pascal":
            return pascalCase(input);
        case "snake":
            return snakeCase(input);
        case "camel":
        default:
            return camelCase(input);
    }
};

export const isJsIdentifier = (value: string): boolean => JS_IDENTIFIER.test(value);

export const isPackageName = (value: string): boolean => PACKAGE_NAME.test(value);
