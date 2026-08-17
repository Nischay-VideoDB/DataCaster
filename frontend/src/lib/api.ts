import { useEffect, useRef, useState } from "react";
import type {
  AskAnswer, BusMessage, CommentaryItem, DataCasterEvent,
  PipelineState, SearchShot,
} from "./types";

// Empty keeps the Docker nginx and Vite dev proxy path. Set this at build
// time when the static frontend is deployed separately from the API.
const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

async function jget<T>(path: string): Promise<T> {
  const r = await fetch(API_BASE + path);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}
async function jpost<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(API_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}


export const api = {
  health: () => jget<{ status: string; now: number; pipeline: PipelineState }>("/api/health"),
  videos: () => jget<{ videos: Array<{ id: string; name: string; length: number | null; thumbnail_url: string | null }> }>("/api/videos"),
  start: (
    source_type: "url" | "video",
    source: string,
    content_type: "football" | "describe" = "football",
  ) =>
    jpost<PipelineState>("/api/start", { source_type, source, content_type }),
  stop: () => jpost<{ status: string }>("/api/stop"),
  endSession: () => jpost<{ status: string }>("/api/end_session"),
  resyncEvents: () => jpost<{ status: string; video_id: string; cleared: number }>("/api/events/resync"),
  liveStream: () =>
    jpost<{ stream_url: string | null; player_url: string | null }>("/api/live_stream"),
  history: (limit = 200) => jget<{ events: DataCasterEvent[] }>(`/api/events/history?limit=${limit}`),
  stats: () => jget<{ counts: Record<string, number>; total: number }>("/api/stats"),
  search: (q: string, kind = "visual", threshold = 10) =>
    jget<{ q: string; kind: string; shots: SearchShot[] }>(
      `/api/search?q=${encodeURIComponent(q)}&kind=${kind}&threshold=${threshold}`,
    ),
  generateCommentary: (event_id: number, style = "excited") =>
    jpost(`/api/commentary?event_id=${event_id}&style=${style}`),
  commentaryTrack: (limit = 50) =>
    jget<{
      items: CommentaryItem[];
      voice?: { available: boolean; consecutive_failures: number; backoff_remaining_s: number };
    }>(`/api/commentary/track?limit=${limit}`),
  highlights: (limit = 25) =>
    jget<{ items: any[] }>(`/api/highlights?limit=${limit}`),
  highlightStream: () =>
    jget<{ mode: string; stream_url: string | null; summary?: string }>(
      `/api/highlights/stream`,
    ),
  /**
   * Compose a 9:16 highlight reel from the most-recent N events on the
   * active video. Optionally posts the reel + auto-generated 30s recap
   * caption to Telegram (requires TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
   * in the backend env). Returns reel URL + caption either way so the
   * UI can show a copy-able artifact even when delivery is skipped.
   */
  makeReel: (
    n: number = 3,
    aspect: "vertical" | "square" | "landscape" = "vertical",
    deliver: "telegram" | "none" = "telegram",
  ) =>
    jpost<{
      reel_url: string | null;
      caption: string;
      aspect: string;
      n: number;
      events_used: number;
      delivered_to: "telegram" | null;
      telegram_message_id: number | null;
      telegram_configured: boolean;
    }>("/api/highlights/reel", { n, aspect, deliver }),
  ask: (q: string, threshold = 6) =>
    jpost<AskAnswer>("/api/ask", { q, threshold }),
};

/** Subscribe to /api/events SSE. Reconnects on close. */
export function useEventStream(onMessage: (m: BusMessage) => void) {
  const cbRef = useRef(onMessage);
  cbRef.current = onMessage;

  useEffect(() => {
    let alive = true;
    let es: EventSource | null = null;
    let backoff = 1000;

    const connect = () => {
      if (!alive) return;
      es = new EventSource(`${API_BASE}/api/events`);
      const dispatch = (e: MessageEvent) => {
        try { cbRef.current(JSON.parse(e.data) as BusMessage); }
        catch { /* skip */ }
      };
      es.addEventListener("event", dispatch as EventListener);
      es.addEventListener("commentary", dispatch as EventListener);
      es.addEventListener("transcript", dispatch as EventListener);
      // Bus-broadcast lifecycle messages so listeners can clear local
      // state without needing a separate API poll.
      es.addEventListener("session_ended", dispatch as EventListener);
      es.addEventListener("resync", dispatch as EventListener);
      es.addEventListener("cleared", dispatch as EventListener);
      // VOD scene-poll progress beacon — drives the indexing ETA bar.
      es.addEventListener("vod_progress", dispatch as EventListener);
      es.addEventListener("ping", () => { /* heartbeat */ });
      es.onerror = () => {
        es?.close();
        if (alive) {
          setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 15000);
        }
      };
      es.onopen = () => { backoff = 1000; };
    };
    connect();
    return () => { alive = false; es?.close(); };
  }, []);
}

/** Local helper: clamp + sort an event list by ts desc. */
export function mergeEvents(prev: DataCasterEvent[], incoming: DataCasterEvent): DataCasterEvent[] {
  if (prev.some(e => e.id === incoming.id)) return prev;
  return [incoming, ...prev].slice(0, 500);
}

/** Hook: fetch + maintain rolling pipeline state. */
export function usePipelineState(intervalMs = 5000) {
  const [state, setState] = useState<PipelineState | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const h = await api.health();
        if (alive) setState(h.pipeline);
      } catch { /* ignore */ }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [intervalMs]);
  return state;
}

/** Hook: fetch + maintain stats counts. */
export function useStats(intervalMs = 5000) {
  const [stats, setStats] = useState<{ counts: Record<string, number>; total: number } | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try { const s = await api.stats(); if (alive) setStats(s); } catch { /* ignore */ }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [intervalMs]);
  return stats;
}
