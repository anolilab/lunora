import { index, type RouteConfig } from "@react-router/dev/routes";

/**
 * React Router v7 framework-mode route config. Each entry maps a URL pattern to
 * a route module under `app/`. `index("routes/home.tsx")` registers the home
 * route at "/".
 */
export default [index("routes/home.tsx")] satisfies RouteConfig;
