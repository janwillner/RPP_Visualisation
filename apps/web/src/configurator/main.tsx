import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { paletteCssVariables } from "../palette";
import "../styles.css";
import { ConfiguratorApp } from "./ConfiguratorApp";

for (const [name, value] of Object.entries(paletteCssVariables())) document.documentElement.style.setProperty(name, value);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConfiguratorApp />
  </StrictMode>,
);
