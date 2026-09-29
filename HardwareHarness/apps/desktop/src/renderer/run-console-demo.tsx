// Standalone preview of the run console with mock data: no Electron preload, no Python backend.
import React from "react";
import ReactDOM from "react-dom/client";
import { RunConsolePage } from "./features/runs/console/RunConsolePage";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RunConsolePage />
  </React.StrictMode>
);
