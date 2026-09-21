// Theme first: it is the base layer, so component CSS Modules (pulled in via
// App) must come after it in the cascade. Importing it last would let global
// rules such as `:focus-visible` override component-level resets.
import "./theme/index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { appStore } from "./lib/app-state.ts";
import { applyAppearance, watchSystemAppearance } from "./lib/theme.ts";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root not found");
}

// Registered once, outside React: the OS scheme flipping is a property of the
// environment, not of any component's lifetime. Only `system` reacts — once the
// user has picked a literal colour, a system change must not override it.
watchSystemAppearance(() => {
  if (appStore.get().settings.appearance === "system") applyAppearance("system");
});

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
