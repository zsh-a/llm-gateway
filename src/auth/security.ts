import { timingSafeEqual } from "node:crypto";

/** Compare fixed secrets without leaking an early character mismatch. */
export function secretsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

