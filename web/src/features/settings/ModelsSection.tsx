import { useEffect, useState } from "react";
import clsx from "clsx";
import { Glyph } from "../../components/dsh-icons.tsx";
import { actions, appStore, useT } from "../../lib/app-state.ts";
import { useStore } from "../../lib/store.ts";
import type { ModelProvider } from "../../lib/types.ts";
import { ProviderEditor } from "./ProviderEditor.tsx";
import { Dialog } from "./Dialog.tsx";
import styles from "./ModelsSection.module.css";

/**
 * The model provider list, ported from dsh's `settings-models` section.
 *
 * What differs is where the data comes from. dsh has its own provider registry
 * and a `settings.yaml` it mutates through a controller; pi keeps providers in
 * `models.json` with credentials in `auth.json` and exposes no RPC for either,
 * so the server edits those files directly. The shape of the page — a row per
 * provider with its credential state, then two add buttons — is the same.
 */
export function ModelsSection({ className }: { className?: string }) {
  const t = useT();
  const state = useStore(appStore);
  const [editing, setEditing] = useState<ModelProvider | null>(null);
  const [creating, setCreating] = useState<"known" | "custom" | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<ModelProvider | null>(null);

  useEffect(() => {
    // The list is a file read, but the first one happens after a cold start of
    // the API server, so it still lands a tick late.
    if (state.models === null) void actions.loadModels();
  }, [state.models]);

  const models = state.models;

  return (
    <div className={className}>
      <div className={styles.header}>
        <h1 className={styles.heading}>{t("model.label")}</h1>
        {/*
          dsh's button says 打开配置文件 because it is a desktop app that can
          hand the path to the OS. A browser cannot, so the label names what
          this actually does instead of promising a reveal that will not happen.
          The path is shown next to it so the copy target is never a mystery.
        */}
        <button
          type="button"
          className={styles.configPath}
          title={models === null ? undefined : models.modelsPath}
          onClick={() => {
            if (models === null) return;
            void navigator.clipboard
              .writeText(models.modelsPath)
              .then(() => actions.setNotice(t("settings.models.copyNotice", { path: models.modelsPath })))
              .catch(() => actions.setNotice(models.modelsPath));
          }}
        >{t("settings.models.copyPath")}</button>
      </div>

      <p className={styles.lead}>{t("settings.models.lead")}</p>

      {models === null ? (
        <div className={styles.loading}>{t("settings.models.loading")}</div>
      ) : (
        <>
          <div className={styles.list}>
            {models.providers.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                onEdit={() => setEditing(provider)}
                onDelete={() => setConfirmingDelete(provider)}
              />
            ))}
          </div>

          <div className={styles.addRow}>
            <button
              type="button"
              className={styles.addButton}
              onClick={() => setCreating("known")}
            >
              <Glyph name="plus" size={16} />{t("settings.provider.addTitle")}</button>
            <button
              type="button"
              className={styles.addButton}
              onClick={() => setCreating("custom")}
            >
              <Glyph name="plus" size={16} />{t("settings.models.addCustom")}</button>
          </div>
        </>
      )}

      {editing !== null && (
        <ProviderEditor
          mode="edit"
          provider={editing}
          knownProviders={models?.knownProviders ?? []}
          apiProtocols={models?.apiProtocols ?? []}
          onClose={() => setEditing(null)}
        />
      )}

      {creating !== null && (
        <ProviderEditor
          mode={creating === "custom" ? "create-custom" : "create-known"}
          provider={null}
          knownProviders={models?.knownProviders ?? []}
          apiProtocols={models?.apiProtocols ?? []}
          onClose={() => setCreating(null)}
        />
      )}

      {confirmingDelete !== null && (
        <DeleteProviderDialog
          provider={confirmingDelete}
          onClose={() => setConfirmingDelete(null)}
        />
      )}
    </div>
  );
}

function ProviderRow({
  provider,
  onEdit,
  onDelete,
}: {
  provider: ModelProvider;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  return (
    <div className={styles.row}>
      <span className={styles.rowName}>{provider.name}</span>
      {provider.custom && <span className={styles.badge}>{t("settings.models.customBadge")}</span>}
      {/*
        The dot reports a credential in the config files, which is where a
        provider configured on this page keeps it. A key supplied through the
        environment is not visible here — saying "未配置" for it would be wrong,
        so the wording names the scope: this is what the files hold.
      */}
      <span
        className={clsx(
          styles.dot,
          provider.configured ? styles.dotOn : styles.dotOff,
        )}
        title={
          provider.configured
            ? provider.keySource === "auth"
              ? t("settings.models.keyInAuth")
              : t("settings.models.keyInline")
            : t("settings.models.keyMissing")
        }
      />
      <div className={styles.rowActions}>
        <button type="button" className={styles.pillButton} onClick={onEdit}>{t("tool.edit")}</button>
        <button
          type="button"
          className={styles.dangerButton}
          onClick={onDelete}
          aria-label={t("settings.models.removeLabel", { id: provider.id })}
        >{t("common.delete")}</button>
      </div>
    </div>
  );
}

/**
 * Deletion is the one irreversible action here, so the consequence is spelled
 * out with dsh's wording — including which credentials survive. A key in
 * `auth.json` is ours and goes with the provider; one from the environment was
 * never ours to remove.
 */
function DeleteProviderDialog({
  provider,
  onClose,
}: {
  provider: ModelProvider;
  onClose: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = (): void => {
    setBusy(true);
    setError(null);
    void actions
      .deleteProvider(provider.id)
      .then(() => onClose())
      .catch((err: Error) => {
        setError(err.message);
        setBusy(false);
      });
  };

  return (
    <Dialog onClose={busy ? undefined : onClose} label={t("settings.models.removeTitle", { name: provider.id })}>
      <h2 className={styles.dialogTitle}>{t("settings.models.removeTitle", { name: provider.name })}</h2>
      <p className={styles.dialogCopy}>
        {provider.keySource === "auth"
          ? t("settings.models.removeWithKey", { name: provider.name })
          : t("settings.models.removeKeepKey", { name: provider.name })}
      </p>
      {error !== null && <p className={styles.dialogError}>{error}</p>}
      <div className={styles.dialogActions}>
        <button type="button" className={styles.ghostButton} onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
        <button type="button" className={styles.dangerButtonSolid} onClick={remove} disabled={busy}>
          {busy ? t("settings.models.removing", { name: provider.name }) : t("common.delete")}
        </button>
      </div>
    </Dialog>
  );
}
