import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, usePipelineState } from "@/lib/api";
import { humanize } from "@/lib/errors";
import type { PipelineState } from "@/lib/types";
import { useEffect, useRef, useState } from "react";

type SourceType = "video" | "url";

interface TypeOption {
  value: SourceType;
  label: string;
  inputPlaceholder: string;
  helper: string;
}

const TYPE_OPTIONS: TypeOption[] = [
  {
    value: "video",
    label: "YouTube VOD",
    inputPlaceholder: "Paste a YouTube URL (uploaded + indexed in batch)",
    helper: "Pre-recorded video. VideoDB ingests, transcodes, then indexes.",
  },
  {
    value: "url",
    label: "RTSP / RTMP URL",
    inputPlaceholder: "rtsp://… or rtmp://… (must be publicly reachable)",
    helper: "Live stream URL. Indexed in real time.",
  },
];

interface Preset {
  label: string;
  type: SourceType;
  src: string;
}

// Static presets. We keep VOD presets empty — the YouTube VOD path uses
// the live "/api/videos" catalog instead so users only see videos they've
// actually uploaded. The single RTSP preset below is VideoDB's public
// sample feed; it's the simplest way to demo the live-ingest path
// without a publicly-reachable feed of your own.
const PRESETS: Preset[] = [
  {
    label: "VideoDB sample · live RTSP feed",
    type: "url",
    src: "rtsp://samples.rts.videodb.io:8554/crib",
  },
];

function isDevMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.localStorage.getItem("datacaster_dev") === "1") return true;
  } catch { /* ignore */ }
  try {
    if (new URLSearchParams(window.location.search).get("dev") === "1") return true;
  } catch { /* ignore */ }
  return false;
}

function findPresetForState(state: PipelineState | null): Preset | null {
  if (!state?.source) return null;
  return PRESETS.find(p =>
    p.type === state.source_type && p.src === state.source,
  ) ?? null;
}

function truncateMiddle(s: string, max = 48): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

interface Props {
  onStartingChange?: (starting: boolean) => void;
}

export function SourceControl({ onStartingChange }: Props = {}) {
  const state = usePipelineState(3000);
  const [type, setType] = useState<SourceType>("video");
  // Catalog of previously-uploaded videos (fetched from /api/videos when
  // the YouTube VOD source type is selected). Lets the user re-run an
  // already-indexed video without paying the upload cost again.
  const [videoCatalog, setVideoCatalog] = useState<
    Array<{ id: string; name: string; length: number | null }>
  >([]);
  const [src, setSrc] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const isLive = !!state?.started_at;
  const collapsedView = isLive && !editing;

  // Auto-sync local form from server state, but never while the user is
  // explicitly editing — we don't want to clobber their in-progress changes.
  useEffect(() => {
    if (editing) return;
    if (state?.source) {
      const st: SourceType = state.source_type === "video" ? "video" : "url";
      setType(st);
      setSrc(state.source);
    }
  }, [state?.rtstream_id, state?.video_id, editing, state?.source, state?.source_type]);

  // Fetch the catalog of previously-uploaded videos when the user picks the
  // YouTube VOD source type, so they can pick an existing video and skip
  // re-uploading. Refreshes whenever the type flips back to "video" so the
  // list is current after a fresh upload.
  useEffect(() => {
    if (type !== "video") return;
    let alive = true;
    api.videos()
      .then(r => { if (alive) setVideoCatalog(r.videos); })
      .catch(() => { if (alive) setVideoCatalog([]); });
    return () => { alive = false; };
  }, [type, state?.video_id]);

  const start = async () => {
    if (!src.trim()) {
      setErr("Paste a URL (or pick a preset) before starting.");
      return;
    }
    setBusy(true); onStartingChange?.(true); setErr(null);
    try {
      if (editing && isLive) {
        await api.stop();
      }
      // content_type is locked to "football" — the manual mode dropdown was
      // dropped from the UI; the backend still accepts both modes via the
      // API surface for the test runner.
      await api.start(type, src.trim(), "football");
      setEditing(false);
    } catch (e) {
      const h = humanize(e);
      setErr(`${h.title} — ${h.body}`);
    } finally { setBusy(false); onStartingChange?.(false); }
  };

  const stop = async () => {
    setBusy(true); onStartingChange?.(true); setErr(null);
    try {
      await api.stop();
    } catch (e) {
      const h = humanize(e);
      setErr(`${h.title} — ${h.body}`);
    } finally { setBusy(false); onStartingChange?.(false); }
  };

  const onTypeChange = (next: SourceType) => {
    setType(next);
    // If the input still holds a value from another type, clear it so the
    // user isn't confused about which type the URL belongs to.
    setSrc("");
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // Merge static presets with the user's previously-uploaded videos so the
  // preset dropdown for "YouTube VOD" doubles as a "pick from your library".
  // Each catalog entry uses the videodb id as the src — the backend's
  // upload_vod() takes the m-prefixed id as a fast-path and skips re-upload.
  const catalogPresets: Preset[] = type === "video"
    ? videoCatalog.map(v => ({
        label: `📁 ${v.name}` + (v.length ? ` · ${Math.round(v.length / 60)}min` : ""),
        type: "video" as const,
        src: v.id,
      }))
    : [];

  const presetsForType: Preset[] = type === "video"
    ? [...PRESETS.filter(p => p.type === "video"), ...catalogPresets]
    : PRESETS.filter(p => p.type === type);

  const matchedPresetLabel =
    presetsForType.find(p => p.src === src)?.label ?? "";

  const onPresetChoose = (label: string) => {
    if (!label) return;
    const p = presetsForType.find(x => x.label === label);
    if (!p) return;
    setType(p.type);
    setSrc(p.src);
  };

  const activeTypeOption = TYPE_OPTIONS.find(o => o.value === type) ?? TYPE_OPTIONS[0];

  const dev = isDevMode();

  if (collapsedView) {
    const preset = findPresetForState(state);
    const typeOption = TYPE_OPTIONS.find(o => o.value === state?.source_type);
    const label = preset?.label ?? typeOption?.label ?? "Custom source";
    const url = state?.source ?? "";

    return (
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-[11px] uppercase tracking-wider text-emerald-300">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
          {state?.source_type === "video" ? "VOD" : "LIVE"}
        </span>

        <span className="flex min-w-0 flex-1 items-center gap-2 text-xs">
          <span className="truncate text-zinc-200">{label}</span>
          <span className="truncate font-mono text-zinc-500">
            — {truncateMiddle(url)}
          </span>
        </span>

        <Button
          onClick={() => { setEditing(true); setErr(null); }}
          variant="ghost"
          size="sm"
          className="h-7"
        >
          Edit
        </Button>
        <Button
          onClick={stop}
          disabled={busy}
          variant="destructive"
          size="sm"
          className="h-7"
        >
          ■ Stop
        </Button>

        {dev && state?.rtstream_id && (
          <span className="ml-2 font-mono text-[10px] text-zinc-500">
            rt={state.rtstream_id.slice(0, 18)}…
          </span>
        )}

        {err && (
          <div className="basis-full text-xs text-red-400">{err}</div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2">
      {/* Type selector */}
      <select
        value={type}
        onChange={(e) => onTypeChange(e.target.value as SourceType)}
        className="h-8 rounded border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-700"
        title={activeTypeOption.helper}
      >
        {TYPE_OPTIONS.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {/* URL / path input */}
      <Input
        ref={inputRef}
        value={src}
        onChange={(e) => setSrc(e.target.value)}
        placeholder={activeTypeOption.inputPlaceholder}
        className="h-8 flex-1 min-w-[260px] border-zinc-800 bg-zinc-950 text-xs"
        onKeyDown={(e) => { if (e.key === "Enter") start(); }}
      />

      {/* Preset selector. For YouTube VOD it merges the static (none) with
          the live "/api/videos" catalog so users pick previously-uploaded
          videos and skip re-upload. For RTSP/RTMP it lists the static
          public-sample preset(s). */}
      {presetsForType.length > 0 && (
        <select
          value={matchedPresetLabel}
          onChange={(e) => onPresetChoose(e.target.value)}
          className="h-8 max-w-[260px] rounded border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-300 disabled:opacity-40 focus:outline-none focus:ring-1 focus:ring-zinc-700"
          title={
            type === "video"
              ? "Pick a previously-uploaded video to skip re-upload"
              : "Pick a sample RTSP/RTMP feed"
          }
        >
          <option value="">
            {type === "video"
              ? `Your videos (${presetsForType.length})…`
              : `Sample feeds (${presetsForType.length})…`}
          </option>
          {presetsForType.map(p => (
            <option key={p.label + p.src} value={p.label}>{p.label}</option>
          ))}
        </select>
      )}

      {/* Start button */}
      <Button onClick={start} disabled={busy} size="sm" className="h-8 px-4">
        {busy ? "Starting…" : "Start"}
      </Button>

      {dev && state?.rtstream_id && (
        <span className="ml-1 font-mono text-[10px] text-zinc-500">
          rt={state.rtstream_id.slice(0, 18)}…
        </span>
      )}

      {err && (
        <div className="basis-full text-xs text-red-400">{err}</div>
      )}
    </div>
  );
}
