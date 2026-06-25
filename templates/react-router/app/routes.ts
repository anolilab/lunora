import { index, type RouteConfig } from "@react-router/dev/routes";

/**
 * React Router v7 framework-mode route config. Each entry maps a URL pattern to
 * a route module under `app/`. `index("routes/welcome.tsx")` registers the
 * branded welcome page at "/".
 */
export default [index("routes/welcome.tsx")] satisfies RouteConfig;
