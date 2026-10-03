/**
 * Read a `Response` body as a typed value.
 *
 * `Response.json()` resolves to `unknown`, so every call site otherwise needs
 * its own cast — and `@typescript-eslint/no-unnecessary-type-assertion` reads
 * those casts as redundant even though `tsc` fails without them. Declaring the
 * conversion once, as this helper's return type, means the call sites are plain
 * awaits and there is nothing for either tool to argue about.
 *
 * The caller still states the shape it expects (`readJson` with the shape it expects);
 * this only moves the unavoidable widening out of the tests.
 */
const readJson = async <T>(response: Response): Promise<T> => {
    const body: unknown = await response.json();

    return body as T;
};

export default readJson;
