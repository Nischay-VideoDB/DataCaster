import Hls from "hls.js";
import { Check, Copy, ExternalLink, Send, Video, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface ReelResult {
  reel_url: string | null;
  caption: string;
  aspect: string;
  n: number;
  events_used: number;
  delivered_to: "telegram" | null;
  telegram_message_id: number | null;
  telegram_configured: boolean;
}

interface Props {
  /** When non-null, the dialog is open showing this result. */
  result: ReelResult | null;
  /** Whether the parent is still composing (delays render of empty state). */
  busy?: boolean;
  onClose: () => void;
}

/**
 * Modal that surfaces a freshly-composed highlight reel: a 9:16 HLS preview,
 * the auto-generated recap caption (copy-able), and the Telegram-delivery
 * status. Mirrors `EndSessionDialog` styling so the two reads as the same
 * UI surface.
 */
export function ReelDialog({ result, busy, onClose }: Props) {
  const open = !!result;
  const reelUrl = result?.reel_url ?? null;
  const caption = result?.caption ?? "";
  const videoRef = useRef<HTMLVideoElement>(null);
  const [copied, setCopied] = useState(false);

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Attach hls.js when we get a fresh reel URL.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !reelUrl) return;
    if (reelUrl.endsWith(".m3u8") || reelUrl.includes("/manifests/")) {
      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true });
        hls.loadSource(reelUrl);
        hls.attachMedia(v);
        return () => hls.destroy();
      }
      if (v.canPlayType("application/vnd.apple.mpegurl")) {
        v.src = reelUrl;
      }
    } else {
      v.src = reelUrl;
    }
  }, [reelUrl]);

  // Copy caption helper. Reset the "copied" indicator after a beat.
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(caption);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard permission denied — ignore.
    }
  };

  if (!open) return null;

  const delivered = result?.delivered_to === "telegram"
    && result?.telegram_message_id != null;
  const telegramHint = result?.telegram_configured
    ? "Delivery attempt failed — caption is ready to copy."
    : "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env to enable auto-delivery.";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reel-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* HEADER */}
        <div className="flex items-start justify-between border-b border-zinc-800 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2">
              <Video className="h-4 w-4 text-emerald-300" />
            </div>
            <div>
              <h2
                id="reel-title"
                className="text-sm font-semibold text-zinc-100"
              >
                Highlight reel
              </h2>
              <p className="mt-0.5 text-xs text-zinc-400">
                {result
                  ? `${result.events_used} events · ${result.aspect} · composed via VideoDB Timeline`
                  : "Composing…"}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* PREVIEW */}
        <div className="bg-black px-5 py-4">
          {reelUrl ? (
            <div className="mx-auto" style={{ maxWidth: "270px" }}>
              {/* 9:16 frame at ~270×480 fits comfortably in the dialog */}
              <video
                ref={videoRef}
                controls
                playsInline
                muted
                autoPlay
                className="aspect-[9/16] w-full rounded border border-zinc-800 bg-zinc-950"
              />
            </div>
          ) : (
            <div className="flex h-32 items-center justify-center text-xs text-zinc-500">
              {busy ? "Composing reel…" : "No reel returned (compose failed)."}
            </div>
          )}
        </div>

        {/* CAPTION */}
        <div className="border-t border-zinc-800 px-5 py-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">
              Recap caption
            </span>
            <button
              type="button"
              onClick={onCopy}
              disabled={!caption}
              className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
            >
              {copied ? (
                <>
                  <Check className="h-3 w-3 text-emerald-400" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" />
                  Copy
                </>
              )}
            </button>
          </div>
          <textarea
            readOnly
            value={caption || "(no caption)"}
            className="h-32 w-full resize-none rounded border border-zinc-800 bg-zinc-900/50 px-2 py-1.5 text-xs leading-relaxed text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-700"
          />
        </div>

        {/* DELIVERY STATUS + ACTIONS */}
        <div className="flex items-center justify-between gap-3 border-t border-zinc-800 bg-zinc-900/40 px-5 py-3 text-[11px]">
          <div className="flex min-w-0 items-center gap-2">
            {delivered ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 uppercase tracking-wider text-emerald-300">
                <Send className="h-3 w-3" />
                Sent to Telegram · #{result?.telegram_message_id}
              </span>
            ) : (
              <span className="text-zinc-500" title={telegramHint}>
                {telegramHint}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {reelUrl && (
              <a
                href={reelUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-transparent px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-zinc-800"
              >
                <ExternalLink className="h-3 w-3" />
                Open
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-zinc-700 bg-transparent px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:bg-zinc-800"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
