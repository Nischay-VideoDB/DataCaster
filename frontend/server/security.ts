import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

function isPrivateAddress(address: string): boolean {
  if (address === "::1" || address === "0:0:0:0:0:0:0:1") return true;
  if (address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true;
  if (!isIP(address) || address.includes(":")) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

export async function validatePublicMediaUrl(raw: string): Promise<string> {
  if (raw.length > 2048) throw new Error("URL is too long");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Enter a valid HTTPS media or YouTube URL"); }
  if (url.protocol !== "https:") throw new Error("Only HTTPS media URLs are accepted");
  if (url.username || url.password) throw new Error("URLs containing credentials are not accepted");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Private network URLs are not accepted");
  }
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("The media host must resolve only to public addresses");
  }
  url.hash = "";
  return url.toString();
}

export function clientHash(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || request.headers.get("x-real-ip") || "unknown";
  const secret = process.env.JOB_HASH_SECRET;
  if (!secret) throw new Error("JOB_HASH_SECRET is not configured");
  return createHash("sha256").update(`${secret}:${ip}`).digest("hex");
}

export function defaultIdempotencyKey(sourceUrl: string, mode: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return createHash("sha256").update(`${day}:${mode}:${sourceUrl}`).digest("hex");
}

export function safeProviderError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/api[_ -]?key|token|authorization|credential/i.test(raw)) {
    return "The media provider rejected this run. Please try again later.";
  }
  return raw.replace(/https?:\/\/[^\s]+/g, "the submitted media URL").slice(0, 300);
}
