import type { Env } from "../config/env";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function encryptAesGcm(data: Uint8Array, keyBytes: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
    cryptoKey,
    data.buffer as ArrayBuffer
  );
  const encBytes = new Uint8Array(encrypted);
  if (encBytes.length < 17) throw new Error("encrypt failed");
  const tag = encBytes.slice(encBytes.length - 16);
  const ciphertext = encBytes.slice(0, encBytes.length - 16);
  const result = new Uint8Array(16 + ciphertext.length + 16);
  result.set(iv, 0);
  result.set(ciphertext, 16);
  result.set(tag, 16 + ciphertext.length);
  return result;
}

export async function generateRelayAuthToken(env: Env, origin: "twilio" | "client"): Promise<string> {
  const now = Date.now();
  const payload = { iat: now, exp: now + 5 * 60 * 1000, origin, nonce: crypto.randomUUID() };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(payload));
  const keyBytes = base64ToBytes(env.ENCRYPTION_KEY);
  const encrypted = await encryptAesGcm(jsonBytes, keyBytes);
  const b64 = btoa(String.fromCharCode(...encrypted));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}


