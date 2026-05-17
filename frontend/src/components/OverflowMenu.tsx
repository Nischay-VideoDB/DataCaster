import { Download, Info, MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface MenuItem {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  divider?: boolean;
}

interface Props {
  /** Kept on the prop type for backward compatibility with App.tsx; the menu
   *  no longer surfaces a dev-panel toggle, but App still passes the flag in
   *  case other consumers want to hang a future control off it. */
  isDevMode?: boolean;
  onToggleDevMode?: () => void;
}

const downloadFile = (path: string) => {
  // Trigger a browser download via a hidden anchor — simpler than fetch+blob
  // since the export endpoints already set Content-Disposition.
  const a = document.createElement("a");
  a.href = path;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
};

/** Header overflow menu — minimal: events export + about-the-project link.
 *  Keeps the header clean. The previous dev-panel toggle and per-data-shape
 *  exports were dropped per UX feedback ("only Export events + About"). */
export function OverflowMenu(_: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const items: MenuItem[] = [
    {
      label: "Export events (JSON)",
      icon: <Download className="h-3.5 w-3.5" />,
      onClick: () => { downloadFile("/api/export/events"); setOpen(false); },
    },
    {
      label: "About DataCaster",
      icon: <Info className="h-3.5 w-3.5" />,
      onClick: () => {
        window.open(
          "https://github.com/sahil-sharma-50/DataCaster",
          "_blank",
          "noopener,noreferrer",
        );
        setOpen(false);
      },
    },
  ];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex h-7 w-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        aria-label="More options"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      {open && (
        <div className="absolute right-0 top-9 z-50 w-56 rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-2xl">
          {items.map((item, i) => (
            <div key={item.label}>
              <button
                onClick={item.onClick}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800"
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
              {item.divider && i < items.length - 1 && (
                <div className="my-1 border-t border-zinc-800" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
