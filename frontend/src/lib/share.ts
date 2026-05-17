/** Read ?event= and ?t= from window.location for deep-linking on app boot.
 * Used by App.tsx (in a later step) to auto-select an event after a shared link
 * is opened. Returns null if no event id is present.
 */
export function readShareLink(): { eventId: number; t: number | null } | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const ev = url.searchParams.get("event");
  if (!ev) return null;
  const id = Number(ev);
  if (!Number.isFinite(id)) return null;
  const tRaw = url.searchParams.get("t");
  const t = tRaw && Number.isFinite(Number(tRaw)) ? Number(tRaw) : null;
  return { eventId: id, t };
}
