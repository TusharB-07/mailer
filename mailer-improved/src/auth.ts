// Password auth: sign-in sets an HMAC-signed cookie; all /api/* routes
// (except /api/login and the Resend webhook) require a valid cookie.
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "./types";
import { timingSafeEqual } from "./util";

const COOKIE = "mailer_session";

// Payload = expiry (unix sec). Token = base64url(exp).base64url(hmac).
function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return b64url(sig);
}

export async function issueSession(c: Context, env: Env): Promise<string> {
  const ttlH = parseInt(env.SESSION_TTL_HOURS || "168", 10);
  const exp = Math.floor(Date.now() / 1000) + ttlH * 3600;
  const payload = b64url(new TextEncoder().encode(String(exp)));
  const sig = await hmac(env.SESSION_SECRET, payload);
  const token = `${payload}.${sig}`;
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: ttlH * 3600,
  });
  return token;
}

export function clearSession(c: Context): void {
  deleteCookie(c, COOKIE, { path: "/" });
}

export async function verifySession(c: Context, env: Env): Promise<boolean> {
  const token = getCookie(c, COOKIE);
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  let exp: number;
  try {
    exp = parseInt(new TextDecoder().decode(b64urlDecode(payload)), 10);
  } catch {
    return false;
  }
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmac(env.SESSION_SECRET, payload);
  return timingSafeEqual(sig, expected);
}

// Middleware: reject unless a valid session cookie is present.
export const requireAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (!(await verifySession(c, c.env))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
};

// Constant-time password check.
export async function checkPassword(env: Env, given: string): Promise<boolean> {
  const expected = env.AUTH_PASSWORD || "";
  if (!expected) return false;
  return timingSafeEqual(given || "", expected);
}
