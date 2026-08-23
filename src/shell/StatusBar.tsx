import styles from "./StatusBar.module.css";

export type StatusTone = "neutral" | "ok" | "warning" | "danger";

export interface StatusTile {
  key: string;
  label: string;
  value: string;
  tone?: StatusTone;
  onSelect?: () => void;
}

interface StatusBarProps {
  tiles: StatusTile[];
}

/**
 * The bottom bar.
 *
 * Tiles are buttons only when they lead somewhere; a tile that reports a number
 * and does nothing should not advertise itself to a screen reader as actionable.
 */
export function StatusBar({ tiles }: StatusBarProps) {
  return (
    <footer className={styles.bar} aria-label="Global product status">
      {tiles.map((tile) =>
        tile.onSelect ? (
          <button
            key={tile.key}
            type="button"
            className={styles.tile}
            data-tone={tile.tone ?? "neutral"}
            aria-label={`${tile.label}: ${tile.value}`}
            onClick={tile.onSelect}
          >
            <span className={styles.label}>{tile.label}</span>
            <span className={styles.value}>{tile.value}</span>
          </button>
        ) : (
          <span
            key={tile.key}
            className={styles.tile}
            data-tone={tile.tone ?? "neutral"}
            aria-label={`${tile.label}: ${tile.value}`}
          >
            <span className={styles.label}>{tile.label}</span>
            <span className={styles.value}>{tile.value}</span>
          </span>
        ),
      )}
    </footer>
  );
}
