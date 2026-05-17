import { Activity, Mic, MonitorPlay, Search, Trash2, X } from "lucide-react";
import { useEffect } from "react";

interface Props {
  open: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const ITEMS: { icon: React.ReactNode; label: string; detail: string }[] = [
  {
    icon: <MonitorPlay className="h-4 w-4 text-zinc-400" />,
    label: "Video player",
    detail: "Stops streaming and clears the loaded source.",
  },
  {
    icon: <Activity className="h-4 w-4 text-zinc-400" />,
    label: "Event timeline",
    detail: "Cleared from view. Events stay saved per-video — re-loading the same video skips re-indexing.",
  },
  {
    icon: <Mic className="h-4 w-4 text-zinc-400" />,
    label: "Commentary track",
    detail: "All generated scripts and audio cards cleared.",
  },
  {
    icon: <Search className="h-4 w-4 text-zinc-400" />,
    label: "Ask & Search history",
    detail: "Local question/answer history reset.",
  },
  {
    icon: <Trash2 className="h-4 w-4 text-zinc-400" />,
    label: "VideoDB sandbox + scene indexes",
    detail: "Pipeline shut down. Indexes remain in your VideoDB account.",
  },
];

export function EndSessionDialog({ open, busy, onConfirm, onCancel }: Props) {
  // Close on Escape so the dialog feels native.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="end-session-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* HEADER */}
        <div className="flex items-start justify-between border-b border-zinc-800 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-2">
              <Trash2 className="h-4 w-4 text-rose-300" />
            </div>
            <div>
              <h2
                id="end-session-title"
                className="text-sm font-semibold text-zinc-100"
              >
                End this session?
              </h2>
              <p className="mt-0.5 text-xs text-zinc-400">
                This stops the live pipeline and clears every panel.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* BODY — scope list */}
        <div className="px-5 py-4">
          <p className="mb-3 text-[11px] uppercase tracking-wider text-zinc-500">
            What gets cleared
          </p>
          <ul className="space-y-2.5">
            {ITEMS.map((item) => (
              <li key={item.label} className="flex items-start gap-2.5">
                <div className="mt-0.5 shrink-0">{item.icon}</div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-zinc-200">{item.label}</div>
                  <div className="text-[11px] text-zinc-500">{item.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* FOOTER — actions */}
        <div className="flex items-center justify-end gap-2 border-t border-zinc-800 bg-zinc-900/40 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-zinc-700 bg-transparent px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-rose-500/40 bg-rose-500/15 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-rose-200 transition hover:bg-rose-500/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 className="h-3 w-3" />
            {busy ? "Ending…" : "End session"}
          </button>
        </div>
      </div>
    </div>
  );
}
