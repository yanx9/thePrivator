/*
 * The stylesheet import comes first, and the order is load-bearing.
 *
 * index.css is the only place that declares `@layer tokens, base, components,
 * utilities`, and a layer's position is fixed the first time its name is seen.
 * ES imports evaluate in source order, so importing App first injected every
 * CSS module -- each opening with `@layer components` -- before that
 * declaration ever ran. `components` was therefore registered as the first
 * layer, `base` landed after it, and the reset's `button { background: none;
 * border: none; padding: 0 }` beat every button rule in the app.
 *
 * The symptom was specific enough to be misleading: buttons in src/shell looked
 * fine because they never set those three properties, and inputs looked fine
 * because the reset does not touch their background or border. Only feature
 * buttons -- the editor tabs, Save, Cancel, Add tag, New profile -- rendered as
 * bare text.
 */
import "./styles/index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { suppressNativeContextMenu } from "./nativeContextMenu";

// Before the first paint, so a right-click during startup cannot reach it.
suppressNativeContextMenu();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("ThePrivator desktop root element was not found.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
