import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { dirname } from "node:path";

/** Read a JSON document without allowing a corrupt optional file to crash startup. */
export function readJsonFile(file: string): unknown | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Persist a small local document with a same-directory atomic replacement. */
export function writeJsonFileAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36).slice(2, 8)}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      chmodSync(temporary, 0o600);
      writeSync(fd, `${JSON.stringify(value)}\n`);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } finally {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // Best-effort cleanup must not hide the original write error.
    }
  }
}

export function removeFile(file: string): void {
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    // Optional cache cleanup must not prevent the next request/auth attempt.
  }
}
