import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Run } from "./domain.js";

const journalPath = fileURLToPath(new URL("../../../.faultline/runs.json", import.meta.url));
let queued = Promise.resolve();

export async function loadJournal():Promise<Run[]> {
  try {
    const raw = await readFile(journalPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, 100) as Run[] : [];
  } catch { return []; }
}

export function persistJournal(runs:Run[]):Promise<void> {
  const snapshot = JSON.stringify(runs.slice(0, 100), null, 2);
  queued = queued.then(async () => {
    await mkdir(dirname(journalPath), { recursive:true });
    const temporary = join(dirname(journalPath), `runs-${process.pid}.tmp`);
    await writeFile(temporary, snapshot, "utf8");
    await rename(temporary, journalPath);
  }).catch(() => undefined);
  return queued;
}
