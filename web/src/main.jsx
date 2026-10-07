import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { initTheme } from "./theme.jsx";
import "katex/dist/katex.min.css";
import "./index.css";

initTheme();

// Tells the desktop exe this window is open; it quits once none are.
try {
  new EventSource("/setup/alive");
} catch {
  /* ignore */
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
