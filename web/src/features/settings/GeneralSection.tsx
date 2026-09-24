import { useEffect } from "react";
import { actions, appStore, useT } from "../../lib/app-state.ts";
import type { Translate } from "../../lib/i18n/index.ts";
import { useStore } from "../../lib/store.ts";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  type AppearancePreference,
  type BusySendBehavior,
  type LanguagePreference,
  type TranscriptDisplay,
} from "../../lib/types.ts";
import {
  SettingsCubes,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
  SettingsStepper,
} from "./SettingsRow.tsx";
import { UpdateSection } from "./UpdateSection.tsx";

/**
 * These labels were dsh's zh dictionary verbatim (`appearance.*`, `fontSize.*`,
 * `settings.transcript.*`, `settings.enter.*`), so the wording matched the UI
 * this page is ported from; they now live in `lib/i18n`, with that same Chinese
 * wording kept as the source table.
 *
 * The option lists are built per render from `t` instead of being module
 * constants, because their labels are language-dependent while their values are
 * not. The union types in the signatures are what keeps a typo from compiling.
 */
type CubeOption = {
  value: AppearancePreference;
  label: string;
  glyph: "light" | "dark" | "system";
};

function appearanceOptions(t: Translate): readonly CubeOption[] {
  return [
    { value: "light", label: t("settings.appearance.light"), glyph: "light" },
    { value: "dark", label: t("settings.appearance.dark"), glyph: "dark" },
    { value: "system", label: t("settings.appearance.system"), glyph: "system" },
  ];
}

/**
 * Language choices, each written in its own language: someone who switched to
 * the wrong one still recognises "简体中文", which is why that entry is the
 * same string in both tables.
 */
function languageOptions(t: Translate): readonly { value: LanguagePreference; label: string }[] {
  return [
    { value: "system", label: t("settings.language.system") },
    { value: "zh-CN", label: t("settings.language.zh") },
    { value: "en", label: t("settings.language.en") },
  ];
}

function transcriptOptions(t: Translate): readonly { value: TranscriptDisplay; label: string }[] {
  return [
    { value: "normal", label: t("settings.transcript.normal") },
    { value: "compact", label: t("settings.transcript.compact") },
  ];
}

function busySendOptions(t: Translate): readonly { value: BusySendBehavior; label: string }[] {
  return [
    { value: "queue", label: t("settings.busySend.queue") },
    { value: "steer", label: t("settings.busySend.steer") },
  ];
}

/** pi's `autoCompactionEnabled` is a boolean; the select speaks in labels. */
function autoCompactionOptions(t: Translate): readonly { value: "on" | "off"; label: string }[] {
  return [
    { value: "on", label: t("settings.autoCompaction.on") },
    { value: "off", label: t("settings.autoCompaction.off") },
  ];
}

/**
 * Preferences owned by this UI, plus the two agent settings that belong to pi.
 * Split from the models section because everything here is a scalar the store
 * already holds, while that one owns files and a dialog.
 */
export function GeneralSection({
  className,
  onOpenPlugins,
}: {
  className?: string;
  /** Where 关于 sends someone who wants to act on a package update. */
  onOpenPlugins?: () => void;
}) {
  const state = useStore(appStore);
  const t = useT();
  const projectPath =
    state.projects.find((project) => project.id === state.selectedProjectId)?.path ??
    state.projects[0]?.path ??
    null;
  const agent = projectPath === null ? undefined : state.agentSettings[projectPath];

  useEffect(() => {
    // Agent-side behaviour lives in a pi process, so this can wait on a cold
    // start. Every other row is already interactive from the store.
    if (projectPath !== null) void actions.loadAgentSettings(projectPath);
  }, [projectPath]);

  return (
    <div className={className}>
        <SettingsGroup title={t("settings.appearance.title")}>
          <SettingsCubes
            value={state.settings.appearance}
            options={appearanceOptions(t)}
            onChange={(appearance) => {
              void actions.updateSettings({ appearance });
            }}
          />
        </SettingsGroup>

        {/*
          Next to appearance because they are the same kind of preference: a
          shell-wide choice that changes how this page looks, not how the agent
          behaves. Both write through `updateSettings`, so both survive a reload
          in the server's store file rather than in the browser.
        */}
        <SettingsRow
          title={t("settings.language.title")}
          description={t("settings.language.description")}
        >
          <SettingsSelect
            label={t("settings.language.title")}
            value={state.settings.language}
            options={languageOptions(t)}
            onChange={(language) => {
              void actions.updateSettings({ language });
            }}
          />
        </SettingsRow>

        <SettingsRow
          title={t("settings.fontSize.title")}
          description={t("settings.fontSize.description")}
        >
          <SettingsStepper
            value={state.settings.contentFontSize}
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            unit="px"
            decreaseLabel={t("settings.fontSize.decrease")}
            increaseLabel={t("settings.fontSize.increase")}
            onChange={(contentFontSize) => {
              void actions.updateSettings({ contentFontSize });
            }}
          />
        </SettingsRow>

        <SettingsRow
          title={t("settings.transcript.title")}
          description={t("settings.transcript.description")}
        >
          <SettingsSelect
            label={t("settings.transcript.title")}
            value={state.settings.transcriptDisplay}
            options={transcriptOptions(t)}
            onChange={(transcriptDisplay) => {
              void actions.updateSettings({ transcriptDisplay });
            }}
          />
        </SettingsRow>

        <SettingsRow
          title={t("settings.busySend.title")}
          description={t("settings.busySend.description")}
        >
          <SettingsSelect
            label={t("settings.busySend.title")}
            value={state.settings.busySendBehavior}
            options={busySendOptions(t)}
            onChange={(busySendBehavior) => {
              void actions.updateSettings({ busySendBehavior });
            }}
          />
        </SettingsRow>

        {/*
          Not a dsh row: this one is pi's, read back from a live process. Until
          that lands (or if no process can be started) the control is disabled
          rather than showing a guessed value the user would then "change" to
          what it already appeared to be.
        */}
        <SettingsRow
          title={t("settings.autoCompaction.title")}
          description={t("settings.autoCompaction.description")}
        >
          <SettingsSelect
            label={t("settings.autoCompaction.title")}
            value={agent?.available === true && agent.autoCompaction ? "on" : "off"}
            options={autoCompactionOptions(t)}
            disabled={agent?.available !== true}
            onChange={(choice) => {
              if (projectPath === null) return;
              void actions.updateAgentSettings(projectPath, {
                autoCompaction: choice === "on",
              });
            }}
          />
        </SettingsRow>

        {/*
          Last, because it answers a question about the app itself rather than
          about how it behaves — a version notice is not a preference, and the
          rows above are the ones people come here to change.
        */}
        <UpdateSection projectPath={projectPath} onOpenPlugins={onOpenPlugins} />
    </div>
  );
}
