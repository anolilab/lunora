/** Deterministic, position-dependent bytes, so a misplaced chunk changes the result. Shared by the unit and workerd upload suites. */
const pattern = (length: number): Uint8Array<ArrayBuffer> => {
    const bytes = new Uint8Array(length);

    for (let index = 0; index < length; index += 1) {
        bytes[index] = (index * 31 + 7) % 251;
    }

    return bytes;
};

// eslint-disable-next-line import/prefer-default-export -- a named test helper
export { pattern };
