/**
 * errors.ts — Friendly error copy for DataCaster v2.
 *
 * Maps known DataCaster + browser errors (HLS.js, fetch, backend) into
 * short, human-readable HumanError objects suitable for toast notifications,
 * inline banners, and modal bodies.
 *
 * The single export `humanize(err)` accepts `unknown` and never throws.
 */

export interface HumanError {
  /** Short headline, < 40 chars, sentence case. */
  title: string;
  /** 1-2 sentences of plain English explanation. */
  body: string;
  /** Optional next-step CTA label, e.g. "Try again". */
  action?: string;
  /** Optional retry hint for callers that can auto-recover. */
  retry?: {
    /** Suggested interval before retrying, in milliseconds. */
    afterMs: number;
    /** If true, caller should silently auto-retry without user input. */
    autoRetry: boolean;
  };
}

/**
 * Coerce an unknown error value to a string we can pattern-match on.
 * Prefers `Error.message` when available, falls back to `String(err)`.
 */
function toMessage(err: unknown): string {
  if (err instanceof Error) {
    // Some errors stash the useful text in .message, some in .toString().
    // Concatenate both so our patterns hit either way.
    const fromString = String(err);
    return err.message && err.message !== fromString
      ? `${err.message} ${fromString}`
      : err.message || fromString;
  }
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  try {
    return String(err);
  } catch {
    return "Unknown error";
  }
}

/** Truncate a string to `n` chars, appending an ellipsis if it was clipped. */
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)).trimEnd() + "…";
}

/**
 * Map a known or unknown error to a friendly HumanError.
 *
 * Never throws. If nothing matches, returns a generic "Something went wrong"
 * with the (truncated) original message in the body.
 */
export function humanize(err: unknown): HumanError {
  let msg: string;
  try {
    msg = toMessage(err);
  } catch {
    msg = "Unknown error";
  }

  const lower = msg.toLowerCase();

  // --- HLS.js: stream not yet packaged. ---
  if (msg.includes("levelEmptyError") || lower.includes("levelemptyerror")) {
    return {
      title: "Stream is buffering",
      body: "The live stream isn't packaged yet. We'll retry automatically in a few seconds.",
      retry: { afterMs: 5000, autoRetry: true },
    };
  }

  // --- HLS.js: bad manifest URL. ---
  if (
    msg.includes("manifestParseError") ||
    msg.includes("manifestLoadError") ||
    lower.includes("manifestparseerror") ||
    lower.includes("manifestloaderror")
  ) {
    return {
      title: "Stream URL is invalid",
      body: "We couldn't read the playlist for this video. Double-check the URL.",
      action: "Edit the URL",
    };
  }

  // --- Backend unreachable: fetch failed at the network layer. ---
  // Order matters: check this before generic 4xx/5xx since these errors
  // typically have no HTTP status at all.
  if (
    msg.includes("Failed to fetch") ||
    msg.includes("NetworkError") ||
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("network request failed")
  ) {
    return {
      title: "Backend is unreachable",
      body: "Couldn't reach the DataCaster server on :8000. Make sure it's running.",
      action: "Refresh after starting the server",
    };
  }

  // --- Pipeline conflict: VideoDB rt.start() already-connected tolerance. ---
  if (lower.includes("already connected")) {
    return {
      title: "A pipeline is already live",
      body: "Stop the current stream before starting a new one.",
      action: "Stop and try again",
    };
  }

  // --- VideoDB rejects localhost / private RTSP/RTMP URLs. ---
  if (lower.includes("local streams are not supported")) {
    return {
      title: "Local URLs aren't supported",
      body: "VideoDB only ingests publicly reachable streams. Use a public RTSP/RTMP URL.",
    };
  }

  // --- Empty search/index result. ---
  if (lower.includes("no results found")) {
    return {
      title: "No matches yet",
      body: "We haven't indexed anything that matches this query. Try a broader term.",
    };
  }

  // --- Sandbox provisioning timeout. ---
  if (lower.includes("sandbox") && lower.includes("timeout")) {
    return {
      title: "Sandbox is taking longer than usual",
      body: "VideoDB sandbox is provisioning. This can take 1–2 minutes.",
      retry: { afterMs: 10000, autoRetry: true },
    };
  }

  // --- HTTP status surfaced by the api.ts wrapper, e.g. "POST /foo → 404". ---
  // We look for "→ 4xx" or "→ 5xx" patterns, plus loose "status: 4xx" forms.
  const statusMatch = msg.match(/(?:→|->|status[:\s]+|HTTP\s+)\s*(\d{3})/i);
  if (statusMatch) {
    const code = parseInt(statusMatch[1], 10);
    if (code >= 400 && code < 500) {
      return {
        title: "Request was rejected",
        body: "The server didn't accept this request. Try again with different inputs.",
      };
    }
    if (code >= 500 && code < 600) {
      // Pull `detail` out of the JSON body the FastAPI wrapper appends after
      // the HTTP code so the user sees the actual cause instead of the
      // generic "something broke" line.
      const detailMatch = msg.match(/"detail"\s*:\s*"([^"]+)"/);
      const detail = detailMatch?.[1] ?? "";
      const detailLower = detail.toLowerCase();

      if (detailLower.includes("stuck on processing")) {
        return {
          title: "VideoDB is still warming up",
          body: "The previous upload hasn't finished transcoding. Wait ~30s and click Start again.",
          retry: { afterMs: 30000, autoRetry: false },
        };
      }
      if (detailLower.includes("rate limit") || detailLower.includes("quota")) {
        return {
          title: "VideoDB rate limit hit",
          body: "Too many recent calls to VideoDB. Wait ~60s and try again.",
        };
      }
      if (detailLower.includes("upload failed") || detailLower.includes("yt-dlp")) {
        return {
          title: "Upload failed",
          body: "VideoDB couldn't ingest this video. Check the URL is reachable and try again.",
        };
      }
      // VideoDB's upload error for unreachable / age-gated / region-locked
      // YouTube URLs, removed videos, or temporary CDN failures.
      if (detailLower.includes("download failed")) {
        return {
          title: "VideoDB couldn't download this video",
          body: "The URL may be private, age-gated, region-locked, or the video has been removed. Try a different YouTube URL or RTSP stream.",
        };
      }
      return {
        title: "Server error",
        body: detail
          ? truncate(detail, 220)
          : "Something broke on the backend. Check `make logs-backend` for details.",
      };
    }
  }

  // --- Fallback: pass the original message through, truncated. ---
  return {
    title: "Something went wrong",
    body: truncate(msg || "Unknown error", 140),
  };
}

// example: const {title, body} = humanize(e);
// example: toast.error(title, { description: body });
// example: if (humanize(e).retry?.autoRetry) setTimeout(refetch, humanize(e).retry!.afterMs);
