/** `{ hint }` for a server error frame that carried a well-formed hint (a string or an array of strings), else `{}`. */
const frameHintOption = (value: unknown): { hint?: string | string[] } => {
    const wellFormed = typeof value === "string" || (Array.isArray(value) && value.every((entry) => typeof entry === "string"));

    return wellFormed ? { hint: value } : {};
};

export default frameHintOption;
