import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { paletteCssVariables } from "./palette";
import "./styles.css";

for (const [name, value] of Object.entries(paletteCssVariables())) document.documentElement.style.setProperty(name, value);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
