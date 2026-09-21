import type { ReactNode } from "react";
import { Glyph } from "../../components/dsh-icons.tsx";
import styles from "./SettingsRow.module.css";

/**
 * One settings row: title, optional description, control on the right.
 *
 * Rows are separated by a hairline that the last row in a section drops, so the
 * separator belongs to the row rather than the list.
 */
export function SettingsRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className={styles.row}>
      <div className={styles.rowText}>
        <div className={styles.title}>{title}</div>
        {description === undefined ? null : (
          <div className={styles.description}>{description}</div>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * A row whose control sits *below* the title rather than beside it, for
 * controls that need the full column width (the appearance cubes wrap).
 */
export function SettingsGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.group}>
      <div className={styles.title}>{title}</div>
      {children}
    </div>
  );
}

/**
 * The pill select. `value`/`onChange` are narrowed to the option union so a
 * typo cannot compile, and the visible label is resolved from `options` rather
 * than passed separately (which could drift from what is actually selected).
 */
export function SettingsSelect<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div className={styles.selectWrap}>
      <select
        className={styles.select}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
          onChange(event.target.value as T);
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <Glyph name="chevronDown" size={14} className={styles.selectChevron} />
    </div>
  );
}

/** The three appearance cubes. `selected` tracks the stored preference. */
export function SettingsCubes<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string; glyph: "light" | "dark" | "system" }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className={styles.cubeRow}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={
            option.value === value
              ? `${styles.themeCube} ${styles.selected}`
              : styles.themeCube
          }
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          <Glyph name={option.glyph} size={16} />
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A number stepper. Out-of-range values are impossible to reach rather than
 * clamped after the fact: the buttons disable at the bounds, so the control can
 * never produce a value the server would reject.
 */
export function SettingsStepper({
  value,
  min,
  max,
  unit,
  decreaseLabel,
  increaseLabel,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  unit: string;
  decreaseLabel: string;
  increaseLabel: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className={styles.control}>
      <div className={styles.stepper}>
        <span className={styles.stepperValue}>{value}</span>
        <div className={styles.stepperArrows}>
          <button
            type="button"
            className={styles.stepperArrow}
            disabled={value >= max}
            aria-label={increaseLabel}
            onClick={() => onChange(Math.min(max, value + 1))}
          >
            {/* The set only ships a down chevron; flipping it is cheaper than a
                second identical path rotated in the bundle. */}
            <Glyph name="chevronDown" size={12} className={styles.stepperArrowUp} />
          </button>
          <button
            type="button"
            className={styles.stepperArrow}
            disabled={value <= min}
            aria-label={decreaseLabel}
            onClick={() => onChange(Math.max(min, value - 1))}
          >
            <Glyph name="chevronDown" size={12} />
          </button>
        </div>
      </div>
      <span className={styles.stepperUnit}>{unit}</span>
    </div>
  );
}
