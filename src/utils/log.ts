import { DEBUG } from "../config/config";

export function rackyLog(...args: unknown[]): void {
  if (DEBUG) {
    console.log("[owr]", ...args);
  }
}

export function rackyError(...args: unknown[]): void {
  console.error("[owr error]", ...args);
}


