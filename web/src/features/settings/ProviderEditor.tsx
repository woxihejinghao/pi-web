import { useState } from "react";
import clsx from "clsx";
import { Glyph } from "../../components/dsh-icons.tsx";
import { actions, appStore } from "../../lib/app-state.ts";
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
 * at all and the stored one survives. "已配置——输入新值可替换" is the placeholder
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
    if (id.length === 0) return creating ? "请输入提供方 ID。" : null;
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      return "需以小写字母开头，之后可用小写字母、数字和短横线。";
    }
    if (creating && existing.has(id)) return "已有提供方使用了这个 ID。";
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
      setFetchError("请先填写 API 地址，再获取。");
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
          setFetchError("该提供方没有列出任何模型，请手动添加。");
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
      ? `编辑 ${provider?.name ?? id}`
      : mode === "create-custom"
        ? "自定义提供方"
        : "添加提供方";

  return (
    <Dialog onClose={busy ? undefined : onClose} label={title}>
      <h2 className={styles.title}>{title}</h2>

      <div className={styles.body}>
        {known ? (
          <Field label="提供方" hint="以小写字母开头的标识，在请求中唯一标识该提供方，并用于派生凭据名。">
            <select
              className={styles.input}
              value={id}
              aria-label="提供方"
              onChange={(event) => {
                setId(event.target.value);
                setName(event.target.value);
              }}
            >
              <option value="">未选择</option>
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
          <Field label="提供方 ID" hint={idLocked ? undefined : "以小写字母开头的标识，在请求中唯一标识该提供方，并用于派生凭据名。"}>
            <input
              className={styles.input}
              value={id}
              readOnly={idLocked}
              aria-label="提供方 ID"
              placeholder="my-provider"
              onChange={(event) => setId(event.target.value)}
            />
          </Field>
        )}

        {!known && (
          <Field label="显示名称" hint="留空时使用提供方 ID。">
            <input
              className={styles.input}
              value={name}
              aria-label="显示名称"
              placeholder={id}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        )}

        <Field
          label="API 密钥"
          hint={
            provider?.configured === true
              ? "已配置——输入新值可替换"
              : "输入 API 密钥；若该提供方以其他方式鉴权，可以留空。"
          }
        >
          <input
            className={styles.input}
            type="password"
            value={apiKey}
            aria-label="API 密钥"
            autoComplete="off"
            placeholder={provider?.configured === true ? "已配置——输入新值可替换" : "输入 API 密钥"}
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
          />
          自定义设置
        </button>

        {advancedOpen && (
          <div className={styles.advanced}>
            <Field
              label="API 地址"
              hint="留空则使用 pi 对该提供方的默认地址。"
            >
              <input
                className={styles.input}
                value={baseUrl}
                aria-label="API 地址"
                placeholder="https://api.example.com/v1"
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </Field>

            <Field label="API 协议" hint="留空则使用 pi 对该提供方的默认协议。">
              <select
                className={styles.input}
                value={api}
                aria-label="API 协议"
                onChange={(event) => setApi(event.target.value)}
              >
                <option value="">未选择</option>
                {apiProtocols.map((protocol) => (
                  <option key={protocol} value={protocol}>
                    {protocol}
                  </option>
                ))}
              </select>
            </Field>

            <div className={styles.modelsHeader}>
              <span className={styles.modelsLabel}>模型目录</span>
              <button
                type="button"
                className={styles.smallButton}
                disabled={fetching}
                onClick={discoverModels}
              >
                {fetching ? "正在询问提供方…" : "获取可用模型"}
              </button>
              <button
                type="button"
                className={styles.smallButton}
                onClick={() => setModels((list) => [...list, { id: "" }])}
              >
                <Glyph name="plus" size={14} />
                添加模型
              </button>
            </div>
            {fetchError !== null && <p className={styles.fetchError}>{fetchError}</p>}
            {models.length === 0 && (
              <p className={styles.modelsEmpty}>
                pi 的内置提供方自带模型列表；自定义提供方需要在这里至少添加一个模型。
              </p>
            )}
            {models.map((model, index) => (
              <div className={styles.modelRow} key={`${index}-${model.id}`}>
                <input
                  className={styles.input}
                  value={model.id}
                  aria-label={`模型 ID ${index + 1}`}
                  placeholder="模型 ID"
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
                  aria-label={`显示名称 ${index + 1}`}
                  placeholder="留空时使用模型 ID"
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
                  aria-label={`删除模型 ${index + 1}`}
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
        <button type="button" className={styles.ghostButton} onClick={onClose} disabled={busy}>
          取消
        </button>
        <button
          type="button"
          className={clsx(styles.primaryButton)}
          onClick={submit}
          disabled={busy || idProblem !== null}
        >
          {busy ? (creating ? "创建中…" : "保存中…") : creating ? "创建提供方" : "保存"}
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
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      {hint !== undefined && <span className={styles.fieldHint}>{hint}</span>}
      {children}
    </label>
  );
}
