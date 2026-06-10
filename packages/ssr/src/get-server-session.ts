/**
 * Structural shape of a better-auth `getSession` call's resolved value.
 *
 * better-auth's `auth.api.getSession({ headers })` returns `{ user, session }`
 * when a valid session cookie is present, or `null` otherwise. We keep `user`
 * and `session` as open records so `@cirrus/ssr` carries no hard dependency on
 * better-auth's concrete `User`/`Session` types — the adapter passing the real
 * `auth` instance keeps full inference, while this package stays decoupled.
 */
interface ServerSession<User extends Record<string, unknown> = Record<string, unknown>, Session extends Record<string, unknown> = Record<string, unknown>> {
    readonly session: Session;
    readonly user: User;
}

/**
 * Structural subset of a better-auth instance: just the one endpoint
 * `getServerSession` needs. Typing it this way (rather than importing
 * `@cirrus/auth`'s `CirrusAuth`) means `@cirrus/ssr` does not depend on
 * better-auth internals — any object exposing `api.getSession` works, including
 * a test stub. The concrete return type is inferred from the passed instance.
 */
interface AuthLike<Result = ServerSession | null> {
    readonly api: {
        getSession: (input: { headers: Headers }) => Promise<Result> | Result;
    };
}

/**
 * Anything `getServerSession` can read request headers from: a `Request`, a
 * `Headers` object, or a plain object exposing `headers`. SSR loaders across
 * meta-frameworks hand back slightly different request objects, so accept the
 * common shapes rather than forcing the caller to unwrap.
 */
type HeadersSource = Headers | Request | { readonly headers: Headers };

const extractHeaders = (source: HeadersSource): Headers => {
    if (source instanceof Headers) {
        return source;
    }

    // `Request` and `{ headers }` both expose `.headers`.
    return source.headers;
};

/**
 * Resolve the signed-in session from a request inside an SSR loader.
 *
 * Wraps `auth.api.getSession({ headers })` — the helper every meta-framework
 * app otherwise hand-rolls — so a loader can read identity off the inbound
 * cookies in one call. Returns `{ user, session }` when a valid session cookie
 * is present, or `null` for anonymous requests.
 *
 * The `auth` parameter is structurally typed ({@link AuthLike}), so this
 * package does not depend on better-auth internals; pass a real
 * `@cirrus/auth` instance to keep full type inference on `user`/`session`.
 * Forward the resolved session's token to `createServerClient` to run the
 * server-side load (and the later WS subscription) as the same identity.
 */
const getServerSession = async <Result>(request: HeadersSource, auth: AuthLike<Result>): Promise<NonNullable<Result> | null> => {
    const headers = extractHeaders(request);

    const result = await auth.api.getSession({ headers });

    // Normalise both `undefined` (a stub that returns nothing) and `null` (the
    // anonymous case better-auth returns) to a single `null` sentinel. `null` is
    // the contract here — it mirrors better-auth's own `getSession` return and the
    // `{ user, session } | null` shape adapters consume. `Result` is unconstrained,
    // so TS can't prove the `??` is reachable, but a real instance returns `… | null`.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, unicorn/no-null -- defensive null normalisation matching better-auth's contract.
    return result ?? null;
};

export type { AuthLike, HeadersSource, ServerSession };
export { getServerSession };
