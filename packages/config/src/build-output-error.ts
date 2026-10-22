/**
 * A deploy target needs the project's client build output, and none exists yet. The CLI tells this apart from an option a
 * target refuses: a run that is about to build creates that output and defers the check to after its build.
 */
class MissingBuildOutputError extends Error {}

// eslint-disable-next-line import/prefer-default-export -- the package index re-exports this class by name, so the module keeps the name
export { MissingBuildOutputError };
