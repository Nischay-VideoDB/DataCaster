import { Link } from "lucide-react";
import { useState } from "react";
import type { MouseEvent } from "react";

interface Props {
  /** Event id to embed in the URL. Required. */
  eventId: number;
  /** Unix timestamp to also embed (optional but encouraged). */
  unixTs?: number | null;
  /** Custom label shown to screen readers / tooltip. Defaults to "Share this moment". */
  label?: string;
  /** Visual size variant. */
  size?: "xs" | "sm";
  className?: string;
}

function buildShareUrl(eventId: number, unixTs?: number | null): string {
  const url = new URL(window.location.href);
  url.search = ""; // strip existing query
  url.searchParams.set("event", String(eventId));
  if (unixTs && unixTs > 0) url.searchParams.set("t", String(Math.round(unixTs)));
  return url.toString();
}

export function ShareButton({
  eventId,
  unixTs,
  label = "Share this moment",
  size = "xs",
  className = "",
}: Props) {
  const [copied, setCopied] = useState(false);
  const onClick = async (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const u = buildShareUrl(eventId, unixTs);
    try {
      await navigator.clipboard.writeText(u);
    } catch {
      // Fallback for non-secure contexts: open a prompt the user can copy from.
      window.prompt("Copy this link:", u);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const dim = size === "xs" ? "h-3 w-3" : "h-3.5 w-3.5";
  const pad = size === "xs" ? "p-1" : "p-1.5";
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`relative ${pad} rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 ${className}`}
    >
      <Link className={dim} />
      {copied && (
        <span className="pointer-events-none absolute -top-6 right-0 whitespace-nowrap rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-200 shadow">
          Link copied
        </span>
      )}
    </button>
  );
}
