/**
 * Read a `Response` body as a typed value.
 *
 * `Response.json()` resolves to `unknown` under workers-types, so every caller
 * otherwise needs its own assertion — and `no-unnecessary-type-assertion` reads
 * those as redundant even though `tsc --noEmit` fails without them. Declaring
 * the widening once, as this function's return type, leaves the call sites as
 * plain awaits with nothing for either tool to disagree about.
 *
 * The caller still states the shape it expects; this only moves the unavoidable
 * conversion to one place. It does NOT validate — the caller is responsible for
 * treating the result as untrusted, exactly as before.
 */
const readJson = async <T>(response: Response): Promise<T> => {
    const body: unknown = await response.json();

    return body as T;
};

export default readJson;
