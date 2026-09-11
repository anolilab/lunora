/**
 * The create-project form, declared once for every framework.
 *
 * The bound here mirrors `v.string().max(120)` on the server. Duplicating it is
 * deliberate: the server's bound is the one that matters, and this one exists so
 * a user learns about it while typing rather than from a rejected submit.
 */
import type { FormController } from "./create-form-controller";
import { createFormController } from "./create-form-controller";

/** Matches the server's `name` bound in `registry/saas/saas.ts`. */
const NAME_MAX_LENGTH = 120;

const HAS_ALPHANUMERIC = /[a-z0-9]/iu;

const validateName = (value: string): string | undefined => {
    const trimmed = value.trim();

    if (trimmed === "") {
        return "Give the project a name.";
    }

    if (trimmed.length > NAME_MAX_LENGTH) {
        return `Keep it under ${NAME_MAX_LENGTH.toString()} characters.`;
    }

    // The server slugifies and rejects an empty slug; catching it here turns a
    // round trip into instant feedback for a name like "***".
    if (!HAS_ALPHANUMERIC.test(trimmed)) {
        return "Use at least one letter or number.";
    }

    return undefined;
};

const createProjectFormController = (onCreate: (name: string) => Promise<unknown>, onSuccess?: () => void): FormController<"name"> =>
    createFormController({
        fields: { name: { validate: validateName } },
        onSubmit: async ({ name }) => onCreate(name.trim()),
        onSuccess,
    });

export { createProjectFormController, NAME_MAX_LENGTH, validateName };
