import { defineConfig } from "deepsec/config";

export default defineConfig({
    projects: [
        { id: "cirrus", root: ".." },
        // <deepsec:projects-insert-above>
    ],
});
