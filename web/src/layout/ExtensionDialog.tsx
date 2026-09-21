import { useEffect, useState } from "react";
import { actions, appStore } from "../lib/app-state.ts";
import { api } from "../lib/api.ts";
import { useStore } from "../lib/store.ts";
import styles from "./ExtensionDialog.module.css";

/**
 * Renders a blocking `extension_ui_request`. pi's own tools never prompt, but
 * an installed extension can — and that pi process stays blocked until this
 * dialog answers, so every branch includes a way out.
 */
export function ExtensionDialog() {
  const { pendingUiRequest } = useStore(appStore);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const requestId = pendingUiRequest?.request.id ?? null;

  useEffect(() => {
    if (!pendingUiRequest) return;
    const initial = pendingUiRequest.request.text;
    setValue(typeof initial === "string" ? initial : "");
    setSubmitting(false);
  }, [requestId, pendingUiRequest]);

  if (!pendingUiRequest) return null;

  const { sessionPath, request } = pendingUiRequest;

  const respond = async (payload: Record<string, unknown>): Promise<void> => {
    setSubmitting(true);
    actions.setPendingUiRequest(null);
    try {
      await api.respondToExtensionUi(sessionPath, { id: request.id, ...payload });
    } catch (err) {
      actions.setNotice((err as Error).message);
    }
  };

  const cancel = () => void respond({ cancelled: true });

  const title = request.title ?? request.method;
  const message = typeof request.message === "string" ? request.message : "";
  const options = Array.isArray(request.options) ? (request.options as string[]) : [];

  return (
    <div className={styles.backdrop} role="presentation" onClick={cancel}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className={styles.title}>{title}</h2>
        {message ? <p className={styles.message}>{message}</p> : null}

        {request.method === "select" ? (
          <div className={styles.options}>
            {options.map((option) => (
              <button
                key={option}
                type="button"
                className={styles.option}
                disabled={submitting}
                onClick={() => void respond({ value: option })}
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}

        {request.method === "input" ? (
          <input
            className={styles.input}
            autoFocus
            value={value}
            placeholder={typeof request.placeholder === "string" ? request.placeholder : ""}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void respond({ value });
              if (event.key === "Escape") cancel();
            }}
          />
        ) : null}

        {request.method === "editor" ? (
          <textarea
            className={styles.textarea}
            autoFocus
            rows={8}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        ) : null}

        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={cancel} disabled={submitting}>
            取消
          </button>
          {request.method === "confirm" ? (
            <>
              <button
                type="button"
                className={styles.secondary}
                disabled={submitting}
                onClick={() => void respond({ confirmed: false })}
              >
                否
              </button>
              <button
                type="button"
                className={styles.primary}
                disabled={submitting}
                onClick={() => void respond({ confirmed: true })}
              >
                是
              </button>
            </>
          ) : null}
          {request.method === "input" || request.method === "editor" ? (
            <button
              type="button"
              className={styles.primary}
              disabled={submitting}
              onClick={() => void respond({ value })}
            >
              提交
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
