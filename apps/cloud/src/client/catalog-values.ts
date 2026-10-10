import type { CatalogForm } from "../catalog/artifact";

/**
 * The install form's starting values. Vars start at their default; secrets always
 * start empty, so no secret is ever pre-filled in the browser.
 */
export const initialValues = (form: CatalogForm): { secrets: Record<string, string>; vars: Record<string, string> } => {
    return {
        secrets: Object.fromEntries(form.secrets.map((secret) => [secret.name, ""])),
        vars: Object.fromEntries(form.vars.map((variable) => [variable.name, variable.default ?? ""])),
    };
};

/** Drop blank entries, so an unfilled optional value falls back to its default and a blank generated secret is generated. */
export const withoutBlanks = (values: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ""));
