import "./index.css";

import { StudioApp } from "@cirrus/studio";
import { createRoot } from "react-dom/client";

import { createDevMockClient } from "./mock/dev-client.js";

// Dev-only harness: render the full studio chrome against a backend-free mock
// client (see `mock/dev-client.ts`), so every panel paints with representative
// data for design/screenshot iteration. Reached at `/mock.html` in dev.
const element = document.querySelector("#root");

if (element === null) {
    throw new Error("main.mock: #root not found");
}

// `dataEditable` is on so the harness exercises the inline cell editor + staged
// commit flow during design iteration; the mock records writes without a backend.
createRoot(element).render(<StudioApp client={createDevMockClient()} studio={{ dataEditable: true }} />);
