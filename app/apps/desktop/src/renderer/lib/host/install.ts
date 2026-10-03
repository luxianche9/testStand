import { createTestStandApi } from "./api.js";
import { createLocalTransport } from "./transport.js";

// Imported first by the entry, so `window.teststand` exists before any view module runs.
window.teststand = createTestStandApi(createLocalTransport(window.teststandHost));
