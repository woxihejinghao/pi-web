import styles from "./TokenPreview.module.css";

const SWATCHES: Array<{ token: string; varName: string }> = [
  { token: "bg-base", varName: "--dsw-alias-bg-base" },
  { token: "bg-layer-1", varName: "--dsw-alias-bg-layer-1" },
  { token: "bg-layer-2", varName: "--dsw-alias-bg-layer-2" },
  { token: "bg-layer-3", varName: "--dsw-alias-bg-layer-3" },
  { token: "brand-primary", varName: "--dsw-alias-brand-primary" },
  { token: "button-primary-fill", varName: "--dsw-alias-button-primary-fill" },
  { token: "interactive-bg-hover", varName: "--dsw-alias-interactive-bg-hover" },
  { token: "sidebar-nav-active", varName: "--dsw-specific-sidebar-nav-item-active" },
];

/**
 * S2 self-check surface: renders every design-system facet this project will
 * consume (aliases, buttons, elevation, superellipse corners, typography,
 * sidebar chrome). Replaced by the real layout in S8.
 */
export function TokenPreview() {
  return (
    <div className={styles.page}>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Semantic aliases</h2>
        <div className={styles.swatches}>
          {SWATCHES.map((s) => (
            <div
              key={s.varName}
              className={styles.swatch}
              style={{ background: `var(${s.varName})` }}
            >
              <span className={styles.swatchLabel}>{s.token}</span>
              <span className={styles.swatchToken}>{s.varName}</span>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Buttons</h2>
        <div className={styles.row}>
          <button className={styles.buttonPrimary}>Apply</button>
          <button className={styles.buttonSecondary}>Cancel</button>
          <button className={styles.buttonGhost}>Ghost</button>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Elevation (borderless surfaces)</h2>
        <div className={styles.cards}>
          <div className={`${styles.card} ${styles.cardPanel}`}>
            <div className={styles.cardTitle}>panel</div>
            --dsw-elevation-panel
          </div>
          <div className={`${styles.card} ${styles.cardProminent}`}>
            <div className={styles.cardTitle}>prominent</div>
            --dsw-elevation-prominent
          </div>
          <div className={`${styles.card} ${styles.cardSoft}`}>
            <div className={styles.cardTitle}>soft</div>
            --dsw-elevation-soft
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Superellipse corners</h2>
        <div className={styles.corners}>
          <div className={styles.corner} style={{ borderRadius: 8 }}>
            8px
          </div>
          <div className={styles.corner} style={{ borderRadius: 20 }}>
            20px
          </div>
          <div className={`${styles.corner} ${styles.cornerRound}`}>round</div>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Typography</h2>
        <div className={styles.typography}>
          <span className={styles.typePrimary}>label-primary</span>
          <span className={styles.typeSecondary}>label-secondary</span>
          <span className={styles.typeTertiary}>label-tertiary</span>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Sidebar chrome</h2>
        <div className={styles.sidebarDemo}>
          <div className={`${styles.navItem} ${styles.navItemActive}`}>Active project</div>
          <div className={styles.navItem}>Hover me</div>
          <div className={styles.navItem}>Another project</div>
        </div>
      </section>
    </div>
  );
}
