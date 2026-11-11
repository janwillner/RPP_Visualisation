import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { paletteCssVariables } from "@rpp/machine-view";
import "@rpp/machine-view/styles.css";
import { App } from "./App";
import "./styles.css";

for (const [name, value] of Object.entries(paletteCssVariables())) document.documentElement.style.setProperty(name, value);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
