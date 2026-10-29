/** Deterministic, position-dependent bytes, so a misplaced chunk changes the result. Shared by the unit and workerd upload suites. */
const pattern = (length: number): Uint8Array<ArrayBuffer> => {
    const bytes = new Uint8Array(length);

    for (let index = 0; index < length; index += 1) {
        bytes[index] = (index * 31 + 7) % 251;
    }

    return bytes;
};

/** Byte equality without a structural diff over megabytes (which is what makes `toStrictEqual` crawl). */
const sameBytes = (actual: Uint8Array | undefined, expected: Uint8Array): boolean =>
    actual?.byteLength === expected.byteLength && actual.every((byte, index) => byte === expected[index]);

export { pattern, sameBytes };
