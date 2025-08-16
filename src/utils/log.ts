import { DEBUG } from "../config/config";

export function owrLog(...args: unknown[]): void {
  if (DEBUG) {
    console.log("[owr]", ...args);
  }
}

export function owrError(...args: unknown[]): void {
  console.error("[owr error]", ...args);
}


