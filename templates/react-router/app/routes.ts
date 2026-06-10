import { type RouteConfig, index } from "@react-router/dev/routes";

/**
 * The route table. A single index route renders the live-loader demo. Add more
 * routes here (file-based, `route("path", "routes/file.tsx")`) as the app grows.
 */
export default [index("routes/home.tsx")] satisfies RouteConfig;
