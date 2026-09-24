import { useState } from "react";
import clsx from "clsx";
import { Glyph } from "../../components/dsh-icons.tsx";
import { actions, appStore, useT } from "../../lib/app-state.ts";
// Aliased: `api` is also the name of this form's wire-protocol field, which is
// dsh's label for it (API 协议) and not worth renaming.
import { api as apiClient } from "../../lib/api.ts";
import { useStore } from "../../lib/store.ts";
import type { ModelProvider, ProviderModelEntry } from "../../lib/types.ts";
import { Dialog } from "./Dialog.tsx";
import { FetchModelsDialog } from "./FetchModelsDialog.tsx";
import styles from "./ProviderEditor.module.css";

type EditorMode = "edit" | "create-known" | "create-custom";

/**
 * One provider's editor, ported from dsh's `ProviderEditor`.
 *
 * Three choices carry over from dsh and are worth stating, because each one is
 * a place a naive editor would do something convenient and wrong:
 *
 * The API key is **write-only**. The page never receives the current key, so it
 * cannot show or echo one; a save that leaves the field untouched sends no key
 * at all and the stored one survives. t("settings.provider.apiKeyConfigured") is the placeholder
 * for exactly that state.
 *
 * The **API address and protocol live in a collapsed 自定义设置 area**. pi knows
 * the endpoint and wire protocol for its built-in providers, so most edits only
 * need a key, and putting the two technical fields next to it would make the
 * common case look like it required them.
 *
 * **Reasoning effort is absent** — dsh's reason, which holds here too: it is a
 * per-model capability, and models under one provider disagree about it, so a
 * provider-scoped control could only offer values some of them reject.
 */
export function ProviderEditor({
  mode,
  provider,
  knownProviders,
  apiProtocols,
  onClose,
}: {
  mode: EditorMode;
  provider: ModelProvider | null;
  knownProviders: string[];
  apiProtocols: string[];
  onClose: () => void;
}) {
  const t = useT();
  const state = useStore(appStore);
  const existing = new Set((state.models?.providers ?? []).map((p) => p.id));

  const [id, setId] = useState(provider?.id ?? "");
  const [name, setName] = useState(provider?.name ?? "");
  // Always empty: the current key is not ours to prefill.
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [api, setApi] = useState(provider?.api ?? "");
  const [models, setModels] = useState<ProviderModelEntry[]>(provider?.models ?? []);
  // Open when the provider already has something in there, or when the user is
  // creating one by hand and cannot get a working provider without it.
  const [advancedOpen, setAdvancedOpen] = useState(
    mode === "create-custom" || provider?.baseUrl != null || (provider?.models.length ?? 0) > 0,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Model discovery runs against the values currently in the form, not a saved
  // provider, so it works while creating one too.
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetched, setFetched] = useState<ProviderModelEntry[] | null>(null);

  const creating = mode !== "edit";
  const known = mode === "create-known";
  const idLocked = !creating || known;

  const idProblem = ((): string | null => {
    if (id.length === 0) return creating ? t("settings.provider.idRequired") : null;
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      return t("settings.provider.idRule");
    }
    if (creating && existing.has(id)) return t("settings.provider.idTaken");
    return null;
  })();

  /**
   * Ask the provider what it serves, then offer the results for selection.
   *
   * The credential sent is the one currently typed, or — when the field is
   * untouched — whatever is on disk under this provider's id, which the server
   * resolves. The key itself never comes back.
   */
  const discoverModels = (): void => {
    const trimmed = baseUrl.trim();
    if (trimmed.length === 0) {
      setFetchError(t("settings.provider.needBaseUrl"));
      return;
    }
    setFetching(true);
    setFetchError(null);
    void apiClient
      .fetchProviderModels({
        ...(creating ? {} : { id }),
        baseUrl: trimmed,
        ...(api.length > 0 ? { api } : {}),
        ...(apiKey.length > 0 ? { apiKey } : {}),
      })
      .then(({ models: found }) => {
        setFetching(false);
        if (found.length === 0) {
          setFetchError(t("settings.provider.noModels"));
          return;
        }
        setFetched(found);
      })
      .catch((err: Error) => {
        setFetching(false);
        setFetchError(err.message);
      });
  };

  const submit = (): void => {
    if (idProblem !== null) {
      setError(idProblem);
      return;
    }
    setBusy(true);
    setError(null);

    // A key is only sent when the user typed one. `undefined` tells the server
    // to leave the stored credential alone.
    const key = apiKey.length > 0 ? { apiKey } : {};
    const payload = {
      name,
      baseUrl,
      api,
      models,
      ...key,
    };

    const request = creating
      ? actions.createProvider({ id, ...payload })
      : actions.updateProvider(id, payload);

    void request
      .then(() => onClose())
      .catch((err: Error) => {
        setError(err.message);
        setBusy(false);
      });
  };

  const title =
    mode === "edit"
      ? t("settings.provider.editTitle", { name: provider?.name ?? id })
      : mode === "create-custom"
        ? t("settings.provider.customTitle")
        : t("settings.provider.addTitle");

  return (
    <Dialog onClose={busy ? undefined : onClose} label={title}>
      <h2 className={styles.title}>{title}</h2>

      <div className={styles.body}>
        {known ? (
          <Field label={t("settings.provider.fieldLabel")} hint={t("settings.provider.fieldHint")}>
            <select
              className={styles.input}
              value={id}
              aria-label={t("settings.provider.fieldLabel")}
              onChange={(event) => {
                setId(event.target.value);
                setName(event.target.value);
              }}
            >
              <option value="">{t("settings.provider.none")}</option>
              {knownProviders
                .filter((candidate) => !existing.has(candidate))
                .map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {candidate}
                  </option>
                ))}
            </select>
          </Field>
        ) : (
          <Field label={t("settings.provider.idLabel")} hint={idLocked ? undefined : t("settings.provider.fieldHint")}>
            <input
              className={styles.input}
              value={id}
              readOnly={idLocked}
              aria-label={t("settings.provider.idLabel")}
              placeholder="my-provider"
              onChange={(event) => setId(event.target.value)}
            />
          </Field>
        )}

        {!known && (
          <Field label={t("settings.provider.displayName")} hint={t("settings.provider.displayNameHint")}>
            <input
              className={styles.input}
              value={name}
              aria-label={t("settings.provider.displayName")}
              placeholder={id}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        )}

        <Field
          label={t("settings.provider.apiKey")}
          hint={
            provider?.configured === true
              ? t("settings.provider.apiKeyConfigured")
              : t("settings.provider.apiKeyHint")
          }
        >
          <input
            className={styles.input}
            type="password"
            value={apiKey}
            aria-label={t("settings.provider.apiKey")}
            autoComplete="off"
            placeholder={provider?.configured === true ? t("settings.provider.apiKeyConfigured") : t("settings.provider.apiKeyPlaceholder")}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </Field>

        <button
          type="button"
          className={styles.disclosure}
          aria-expanded={advancedOpen}
          data-disclosure-row
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <Glyph
            name="chevronDown"
            size={14}
            className={advancedOpen ? styles.caretOpen : styles.caret}
          />{t("settings.provider.customSettings")}</button>

        {advancedOpen && (
          <div className={styles.advanced}>
            <Field
              label={t("settings.provider.baseUrl")}
              hint={t("settings.provider.baseUrlHint")}
            >
              <input
                className={styles.input}
                value={baseUrl}
                aria-label={t("settings.provider.baseUrl")}
                placeholder="https://api.example.com/v1"
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </Field>

            <Field label={t("settings.provider.apiProtocol")} hint={t("settings.provider.apiProtocolHint")}>
              <select
                className={styles.input}
                value={api}
                aria-label={t("settings.provider.apiProtocol")}
                onChange={(event) => setApi(event.target.value)}
              >
                <option value="">{t("settings.provider.none")}</option>
                {apiProtocols.map((protocol) => (
                  <option key={protocol} value={protocol}>
                    {protocol}
                  </option>
                ))}
              </select>
            </Field>

            <div className={styles.modelsHeader}>
              <span className={styles.modelsLabel}>{t("settings.provider.modelCatalog")}</span>
              <button
                type="button"
                className={styles.smallButton}
                disabled={fetching}
                onClick={discoverModels}
              >
                {fetching ? t("settings.provider.fetching") : t("settings.provider.fetchModels")}
              </button>
              <button
                type="button"
                className={styles.smallButton}
                onClick={() => setModels((list) => [...list, { id: "" }])}
              >
                <Glyph name="plus" size={14} />{t("settings.provider.addModel")}</button>
            </div>
            {fetchError !== null && <p className={styles.fetchError}>{fetchError}</p>}
            {models.length === 0 && (
              <p className={styles.modelsEmpty}>{t("settings.provider.catalogHint")}</p>
            )}
            {models.map((model, index) => (
              <div className={styles.modelRow} key={`${index}-${model.id}`}>
                <input
                  className={styles.input}
                  value={model.id}
                  aria-label={t("settings.provider.modelIdLabel", { index: index + 1 })}
                  placeholder={t("settings.provider.modelId")}
                  onChange={(event) =>
                    setModels((list) =>
                      list.map((entry, i) =>
                        i === index ? { ...entry, id: event.target.value } : entry,
                      ),
                    )
                  }
                />
                <input
                  className={styles.input}
                  value={model.name ?? ""}
                  aria-label={t("settings.provider.modelNameLabel", { index: index + 1 })}
                  placeholder={t("settings.provider.modelNamePlaceholder")}
                  onChange={(event) =>
                    setModels((list) =>
                      list.map((entry, i) =>
                        i === index ? { ...entry, name: event.target.value } : entry,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label={t("settings.provider.removeModel", { index: index + 1 })}
                  onClick={() =>
                    setModels((list) => list.filter((_, i) => i !== index))
                  }
                >
                  <Glyph name="trash" size={16} />
                </button>
              </div>
            ))}
          </div>
        )}

        {error !== null && <p className={styles.error}>{error}</p>}
      </div>

      {fetched !== null && (
        <FetchModelsDialog
          models={fetched}
          existing={models.map((entry) => entry.id).filter((value) => value.length > 0)}
          onAdopt={(selected) => {
            // Existing entries are left exactly as they are; the dialog does not
            // let them be selected, so a hand-edited contextWindow survives a
            // discovery round.
            setModels((list) => {
              const byId = new Map(
                list.filter((entry) => entry.id.length > 0).map((entry) => [entry.id, entry]),
              );
              for (const entry of selected) byId.set(entry.id, entry);
              return [...byId.values()];
            });
            setFetched(null);
          }}
          onClose={() => setFetched(null)}
        />
      )}

      <div className={styles.actions}>
        <button type="button" className={styles.ghostButton} onClick={onClose} disabled={busy}>{t("common.cancel")}</button>
        <button
          type="button"
          className={clsx(styles.primaryButton)}
          onClick={submit}
          disabled={busy || idProblem !== null}
        >
          {busy ? (creating ? t("settings.provider.creating") : t("settings.provider.saving")) : creating ? t("settings.provider.create") : t("common.save")}
        </button>
      </div>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {hint !== undefined && <span className={styles.fieldHint}>{hint}</span>}
      {children}
    </label>
  );
}
