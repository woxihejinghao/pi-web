import { useEffect } from "react";
import { actions, appStore } from "../../lib/app-state.ts";
import { useStore } from "../../lib/store.ts";
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from "../../lib/types.ts";
import {
  SettingsCubes,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
  SettingsStepper,
} from "./SettingsRow.tsx";

/**
 * Labels are dsh's zh dictionary, verbatim (`appearance.*`, `fontSize.*`,
 * `settings.transcript.*`, `settings.enter.*`), so the wording matches the UI
 * this page is ported from.
 */
const APPEARANCE_OPTIONS = [
  { value: "light", label: "浅色", glyph: "light" },
  { value: "dark", label: "深色", glyph: "dark" },
  { value: "system", label: "跟随系统", glyph: "system" },
] as const;

const TRANSCRIPT_OPTIONS = [
  { value: "normal", label: "标准" },
  { value: "compact", label: "紧凑" },
] as const;

const BUSY_SEND_OPTIONS = [
  { value: "queue", label: "排队发送" },
  { value: "steer", label: "插话发送" },
] as const;

/** pi's `autoCompactionEnabled` is a boolean; the select speaks in labels. */
const AUTO_COMPACTION_OPTIONS = [
  { value: "on", label: "开启" },
  { value: "off", label: "关闭" },
] as const;

/**
 * Preferences owned by this UI, plus the two agent settings that belong to pi.
 * Split from the models section because everything here is a scalar the store
 * already holds, while that one owns files and a dialog.
 */
export function GeneralSection({ className }: { className?: string }) {
  const state = useStore(appStore);
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
        <SettingsGroup title="外观">
          <SettingsCubes
            value={state.settings.appearance}
            options={APPEARANCE_OPTIONS}
            onChange={(appearance) => {
              void actions.updateSettings({ appearance });
            }}
          />
        </SettingsGroup>

        <SettingsRow title="字号大小" description="仅影响会话内容的字号">
          <SettingsStepper
            value={state.settings.contentFontSize}
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            unit="px"
            decreaseLabel="减小字号"
            increaseLabel="增大字号"
            onChange={(contentFontSize) => {
              void actions.updateSettings({ contentFontSize });
            }}
          />
        </SettingsRow>

        <SettingsRow title="对话显示" description="控制已完成轮次的过程内容">
          <SettingsSelect
            label="对话显示"
            value={state.settings.transcriptDisplay}
            options={TRANSCRIPT_OPTIONS}
            onChange={(transcriptDisplay) => {
              void actions.updateSettings({ transcriptDisplay });
            }}
          />
        </SettingsRow>

        <SettingsRow
          title="繁忙时的发送行为"
          description="智能体运行时 Enter 键和发送按钮的行为；Cmd/Ctrl+Enter 使用另一行为"
        >
          <SettingsSelect
            label="繁忙时的发送行为"
            value={state.settings.busySendBehavior}
            options={BUSY_SEND_OPTIONS}
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
        <SettingsRow title="自动压缩" description="上下文接近上限时自动压缩较早的对话">
          <SettingsSelect
            label="自动压缩"
            value={agent?.available === true && agent.autoCompaction ? "on" : "off"}
            options={AUTO_COMPACTION_OPTIONS}
            disabled={agent?.available !== true}
            onChange={(choice) => {
              if (projectPath === null) return;
              void actions.updateAgentSettings(projectPath, {
                autoCompaction: choice === "on",
              });
            }}
          />
        </SettingsRow>
    </div>
  );
}
