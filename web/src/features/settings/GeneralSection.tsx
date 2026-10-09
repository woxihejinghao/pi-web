import { useEffect, useState } from "react";
import { actions, appStore, useT } from "../../lib/app-state.ts";
import type { Translate } from "../../lib/i18n/index.ts";
import {
  notificationCapability,
  requestNotificationPermission,
  type NotificationCapability,
} from "../../lib/notifications.ts";
import { useStore } from "../../lib/store.ts";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  type AppearancePreference,
  type BusySendBehavior,
  type LanguagePreference,
  type ModelProvider,
  type TitleModelChoice,
  type TranscriptDisplay,
} from "../../lib/types.ts";
import {
  SettingsCubes,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
  SettingsStepper,
  SettingsSwitch,
} from "./SettingsRow.tsx";
import { UpdateSection } from "./UpdateSection.tsx";

/**
 * These labels were dsh's zh dictionary verbatim (`appearance.*`, `fontSize.*`,
 * `settings.transcript.*`, `settings.enter.*`), so the wording matched the UI
 * this page is ported from; they now live in `lib/i18n`, with that same Chinese
 * wording kept as the source table. The two work-details names dsh added later
 * (`detailed`, `verbose`) carry this project's Chinese: upstream's own wording
 * for them is not in the ported dictionary.
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
    { value: "compact", label: t("settings.transcript.compact") },
    { value: "standard", label: t("settings.transcript.standard") },
    { value: "detailed", label: t("settings.transcript.detailed") },
    { value: "verbose", label: t("settings.transcript.verbose") },
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

/** The value that means "no model writes titles". */
const NO_TITLE_MODEL = "";

/**
 * One flat list of every configured model, provider qualified.
 *
 * Two selects (provider, then its models) would be the obvious shape, but this
 * row is not about providers — a user with one provider should not have to
 * answer a question that has one answer. The pair is still what gets stored, so
 * the delimiter is the encoding rather than part of the value.
 */
function titleModelOptions(
  t: Translate,
  providers: readonly ModelProvider[],
): { value: string; label: string }[] {
  const options = [{ value: NO_TITLE_MODEL, label: t("settings.titleModel.off") }];
  for (const provider of providers) {
    for (const model of provider.models) {
      options.push({
        value: `${provider.id}::${model.id}`,
        label: `${provider.name} · ${model.name ?? model.id}`,
      });
    }
  }
  return options;
}

/**
 * Preferences owned by this UI, plus the two agent settings that belong to pi.
 * Split from the models section because everything here is a scalar the store
 * already holds, while that one owns files and a dialog.
 */
export function GeneralSection({ className }: { className?: string }) {
  const state = useStore(appStore);
  const t = useT();
  // Read once on mount rather than on every render: the permission only changes
  // in response to this page's own request, which updates it directly. Probing
  // the API during render would also make the page's output depend on a value
  // React cannot subscribe to.
  const [notificationPermission, setNotificationPermission] = useState<NotificationCapability>(
    () => notificationCapability(),
  );
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

  useEffect(() => {
    // The title row lists every configured model, so this page needs the
    // provider list even when the models section was never opened.
    if (state.models === null) void actions.loadModels();
  }, [state.models]);

  const titleModel = state.settings.titleModel;
  const titleModelValue = titleModel === null
    ? NO_TITLE_MODEL
    : `${titleModel.provider}::${titleModel.model}`;
  const titleChoices = titleModelOptions(t, state.models?.providers ?? []);
  // A model that was configured when this was chosen may be gone from
  // `models.json` since. Showing it keeps the setting legible instead of
  // silently reading as "off", and re-picking is one click away.
  if (titleModel !== null && !titleChoices.some((choice) => choice.value === titleModelValue)) {
    titleChoices.push({ value: titleModelValue, label: `${titleModel.provider} · ${titleModel.model}` });
  }

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
          A preference about this browser, not about the agent, so it sits with
          the other shell-side rows rather than next to auto-compaction. The
          description doubles as the failure message: a denied permission is
          the one state where the switch cannot do what it says, and the way
          back is only knowable in the browser's own settings.
        */}
        <SettingsRow
          title={t("settings.browserNotifications.title")}
          description={
            notificationPermission === "unsupported"
              ? t("settings.browserNotifications.unsupported")
              : notificationPermission === "denied"
                ? t("settings.browserNotifications.denied")
                : t("settings.browserNotifications.description")
          }
        >
          <SettingsSwitch
            label={t("settings.browserNotifications.title")}
            checked={state.settings.browserNotifications}
            disabled={notificationPermission === "unsupported"}
            onChange={(enabled) => {
              if (!enabled) {
                void actions.updateSettings({ browserNotifications: false });
                return;
              }
              // The prompt has to be raised from inside the click, and its
              // answer decides the setting: a switch left on without permission
              // would promise a notification the browser never shows.
              void requestNotificationPermission().then((permission) => {
                setNotificationPermission(permission);
                if (permission !== "granted") {
                  actions.setNotice(t("notice.notificationsDenied"));
                  return;
                }
                void actions.updateSettings({ browserNotifications: true });
              });
            }}
          />
        </SettingsRow>

        {/*
          The one row here that spends money: every session it names is an
          extra model call, which is why it is off by default and carries its
          own (usually cheap) model rather than following the session's.
        */}
        <SettingsRow
          title={t("settings.titleModel.title")}
          description={t("settings.titleModel.description")}
        >
          <SettingsSelect
            label={t("settings.titleModel.title")}
            value={titleModelValue}
            options={titleChoices}
            onChange={(next) => {
              if (next === NO_TITLE_MODEL) {
                void actions.updateSettings({ titleModel: null });
                return;
              }
              const [provider, model] = next.split("::");
              if (provider === undefined || model === undefined) return;
              const choice: TitleModelChoice = { provider, model };
              void actions.updateSettings({ titleModel: choice });
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
        <UpdateSection projectPath={projectPath} />
    </div>
  );
}
