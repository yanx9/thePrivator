import styles from "./Placeholder.module.css";

interface PlaceholderProps {
  title: string;
  description: string;
}

/**
 * A destination whose surface has not been ported yet.
 *
 * The shell routes to real destinations from the first commit, so the nav is
 * honest about what exists; without this, every route would fall through to the
 * profiles page and a click on "Proxies" would look broken rather than unbuilt.
 */
export function Placeholder({ title, description }: PlaceholderProps) {
  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.description}>{description}</p>
    </div>
  );
}
