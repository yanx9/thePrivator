import { useCallback, useEffect, useState } from "react";

import styles from "./SettingsPage.module.css";

export type ThemeChoice = "system" | "light" | "dark";

const THEMES: Array<{ id: ThemeChoice; label: string; description: string }> = [
  { id: "system", label: "Match the system", description: "Follow whatever this computer is set to." },
  { id: "light", label: "Light", description: "Always light, whatever the system says." },
  { id: "dark", label: "Dark", description: "Always dark, whatever the system says." },
];

/**
 * Read the theme back from the document.
 *
 * The attribute is the single source of truth rather than a piece of React
 * state: the tokens key off it, and keeping a second copy in state means the two
 * can disagree after any code path that sets one without the other.
 */
function currentTheme(): ThemeChoice {
  const attribute = document.documentElement.getAttribute("data-theme");
  return attribute === "light" || attribute === "dark" ? attribute : "system";
}

export function AppearanceSettings() {
  const [theme, setTheme] = useState<ThemeChoice>(currentTheme);

  useEffect(() => {
    setTheme(currentTheme());
  }, []);

  const choose = useCallback((choice: ThemeChoice) => {
    if (choice === "system") {
      // Removed, not set to "system": the token layer distinguishes "no
      // attribute" (follow prefers-color-scheme) from an explicit choice, and a
      // third value would match neither rule.
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", choice);
    }
    setTheme(choice);
  }, []);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>Appearance</h1>
        <p className={styles.lede}>How ThePrivator looks on this device.</p>
      </header>

      <section className={styles.card} aria-labelledby="theme-heading">
        <h2 id="theme-heading">Theme</h2>

        <div className={styles.choices} role="radiogroup" aria-labelledby="theme-heading">
          {THEMES.map((entry) => (
            <label key={entry.id} className={styles.choice}>
              <input
                type="radio"
                name="theme"
                value={entry.id}
                checked={theme === entry.id}
                onChange={() => choose(entry.id)}
              />
              <span>
                <strong>{entry.label}</strong>
                <span className={styles.hint}>{entry.description}</span>
              </span>
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}
