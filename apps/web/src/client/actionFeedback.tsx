import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type ToastKind = "busy" | "ok" | "err";

type Toast = {
  id: number;
  kind: ToastKind;
  text: string;
};

type ActionFeedback = {
  busy: (text: string, key?: string) => void;
  ok: (text: string) => void;
  err: (text: string) => void;
  clear: () => void;
  isBusy: (key: string) => boolean;
  anyBusy: boolean;
};

const ActionFeedbackContext = createContext<ActionFeedback | null>(null);

const OK_MS = 4000;
const ERR_MS = 6000;

export function ActionFeedbackProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const idRef = useRef(0);
  const timerRef = useRef<number>(0);

  const show = useCallback((kind: ToastKind, text: string, autoClearMs?: number) => {
    const id = ++idRef.current;
    setToast({ id, kind, text });
    window.clearTimeout(timerRef.current);
    if (autoClearMs) {
      timerRef.current = window.setTimeout(() => {
        setToast((current) => (current?.id === id ? null : current));
      }, autoClearMs);
    }
  }, []);

  const api = useMemo<ActionFeedback>(
    () => ({
      busy(text, key) {
        setBusyKey(key ?? "action");
        show("busy", text);
      },
      ok(text) {
        setBusyKey(null);
        show("ok", text, OK_MS);
      },
      err(text) {
        setBusyKey(null);
        show("err", text, ERR_MS);
      },
      clear() {
        setBusyKey(null);
        window.clearTimeout(timerRef.current);
        setToast(null);
      },
      isBusy(key) {
        return busyKey === key;
      },
      anyBusy: busyKey !== null,
    }),
    [busyKey, show],
  );

  return (
    <ActionFeedbackContext.Provider value={api}>
      {children}
      {toast ? (
        <div
          key={toast.id}
          className={`action-toast action-toast-${toast.kind}`}
          role="status"
          aria-live="polite"
        >
          {toast.kind === "busy" ? <span className="action-toast-dot" aria-hidden="true" /> : null}
          <span className="action-toast-text">{toast.text}</span>
        </div>
      ) : null}
    </ActionFeedbackContext.Provider>
  );
}

export function useActionFeedback(): ActionFeedback {
  const value = useContext(ActionFeedbackContext);
  if (!value) {
    throw new Error("useActionFeedback requires ActionFeedbackProvider");
  }
  return value;
}
