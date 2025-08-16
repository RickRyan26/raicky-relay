import { base64ToBytes, base64UrlToBytes } from "./base64";
import type { Env } from "../config/env";
import { rackyLog } from "./log";

export function sanitizeToken(raw: string | null): string | null {
  if (!raw) return null;
  const stopChars = ['?', '&', '#'];
  let token = raw;
  for (const ch of stopChars) {
    const idx = token.indexOf(ch);
    if (idx >= 0) token = token.slice(0, idx);
  }
  token = token.replace(/[^A-Za-z0-9_-]/g, '');
  return token.length ? token : null;
}

export function getAuthToken(url: URL): string | null {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length >= 2 && (parts[0] === 'token' || parts[0] === 'auth')) {
    return sanitizeToken(parts[1]);
  }
  return sanitizeToken(url.searchParams.get('auth'));
}

async function decryptAesGcm(data: Uint8Array, keyBytes: Uint8Array): Promise<Uint8Array> {
  if (data.length < 33) throw new Error("invalid data");
  const iv = data.slice(0, 16);
  const authTag = data.slice(data.length - 16);
  const ciphertext = data.slice(16, data.length - 16);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext, 0);
  combined.set(authTag, ciphertext.length);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
    cryptoKey,
    combined.buffer as ArrayBuffer
  );
  return new Uint8Array(plain);
}

export async function validateAuth(
  authParam: string | null,
  env: Env,
  expectedOrigin: "twilio" | "client"
): Promise<boolean> {
  try {
    if (!authParam) {
      rackyLog("[auth] missing token");
      return false;
    }
    if (!env.ENCRYPTION_KEY) {
      rackyLog("[auth] missing ENCRYPTION_KEY");
      return false;
    }
    const key = base64ToBytes(env.ENCRYPTION_KEY);
    const encrypted = base64UrlToBytes(authParam);
    const plaintext = await decryptAesGcm(encrypted, key);
    const decoded = JSON.parse(new TextDecoder().decode(plaintext)) as {
      iat: number;
      exp: number;
      origin: string;
      nonce: string;
    };
    const now = Date.now();
    if (decoded.exp < now) {
      rackyLog("[auth] token expired", { exp: decoded.exp, now });
      return false;
    }
    if (decoded.iat > now + 30_000) {
      rackyLog("[auth] token iat too far in future", { iat: decoded.iat, now });
      return false;
    }
    if (decoded.origin !== expectedOrigin) {
      rackyLog("[auth] origin mismatch", { expected: expectedOrigin, got: decoded.origin });
      return false;
    }
    return true;
  } catch {
    rackyLog("[auth] token decrypt/parse failed");
    return false;
  }
}


