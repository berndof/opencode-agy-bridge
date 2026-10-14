import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultConversationsDir(): string {
  return join(homedir(), ".gemini", "antigravity-cli", "conversations");
}

export async function snapshot(dir: string): Promise<Set<string>> {
  try {
    const entries = await readdir(dir);
    const stems = new Set<string>();
    for (const entry of entries) {
      // agy CLI creates .db files (SQLite databases) for conversations
      if (entry.endsWith(".db")) {
        stems.add(entry.slice(0, -3));
      }
    }
    return stems;
  } catch {
    return new Set();
  }
}

export async function findNewConversation(
  before: Set<string>,
  dir: string,
): Promise<string | null> {
  const after = await snapshot(dir);
  const created: string[] = [];
  for (const stem of after) {
    if (!before.has(stem)) {
      created.push(stem);
    }
  }

  if (created.length === 0) {
    return null;
  }

  if (created.length > 1) {
    return null;
  }

  return created[0];
}
