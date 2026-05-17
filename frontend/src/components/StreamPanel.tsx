import Hls from "hls.js";
import { useEffect, useRef, useState } from "react";
import { registerPlayerSeeker } from "@/lib/playerControl";

interface Props {
  /** Optional override URL. When unset, panel shows a passive placeholder. */
  url?: string | null;
  poster?: string | null;
}

export function StreamPanel({ url, poster }: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    registerPlayerSeeker((seconds: number) => {
      const v = ref.current;
      if (!v) return false;
      try {
        v.currentTime = Math.max(0, seconds);
        if (v.paused) {
          // Best-effort resume; ignore promise rejection (autoplay rules).
          void v.play().catch(() => undefined);
        }
        return true;
      } catch {
        return false;
      }
    });
    return () => registerPlayerSeeker(null);
  }, []);

  useEffect(() => {
    setErr(null);
    const v = ref.current;
    if (!v || !url) return;

    if (url.endsWith(".m3u8") || url.includes("/manifests/")) {
      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          // Live streams: VideoDB needs ~30s to package segments after rtstream
          // start, so the manifest may briefly have zero levels. Retry instead
          // of giving up.
          manifestLoadPolicy: {
            default: {
              maxTimeToFirstByteMs: 10000,
              maxLoadTimeMs: 20000,
              timeoutRetry: { maxNumRetry: 8, retryDelayMs: 2000, maxRetryDelayMs: 8000 },
              errorRetry: { maxNumRetry: 8, retryDelayMs: 2000, maxRetryDelayMs: 8000 },
            },
          },
        });
        hls.loadSource(url);
        hls.attachMedia(v);
        hls.on(Hls.Events.ERROR, (_e, data) => {
          // levelEmptyError is recoverable — VideoDB hasn't packaged segments
          // yet. Try again instead of surfacing it as a fatal error.
          if (data.details === "levelEmptyError") {
            setTimeout(() => hls.loadSource(url), 2000);
            return;
          }
          if (data.fatal) {
            if (data.type === "networkError") {
              setErr(`HLS network: ${data.details} (retrying...)`);
              hls.startLoad();
            } else {
              setErr(`HLS: ${data.details}`);
            }
          }
        });
        return () => hls.destroy();
      } else if (v.canPlayType("application/vnd.apple.mpegurl")) {
        v.src = url;
      } else {
        setErr("HLS not supported in this browser");
      }
    } else {
      v.src = url;
    }
  }, [url]);

  return (
    <div className="relative aspect-video w-full overflow-hidden bg-zinc-950">
      {url ? (
        <video
          ref={ref}
          poster={poster ?? undefined}
          className="h-full w-full"
          autoPlay muted playsInline controls
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-600">
          no stream — start a source from the top bar
        </div>
      )}
      {err && (
        <div className="absolute bottom-2 left-2 rounded bg-red-900/80 px-2 py-1 text-xs text-red-100">
          {err}
        </div>
      )}
    </div>
  );
}
