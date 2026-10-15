/**
 * Conversation (A2A contextId) store.
 *
 * A conversation is identified by (agentUrl, scope). `scope` is normally the id of the
 * calling pi session, so two pi sessions talking to the same agent get independent
 * contextIds (and therefore independent remote sessions that run in parallel), while one
 * pi session keeps reusing its own contextId across restarts.
 *
 * An explicit named context (`context_id` tool argument) is addressed directly and may
 * be shared deliberately between sessions.
 *
 * The backing file is shared by every pi process, so writes are read-merge-write per key
 * (never a blind overwrite of the whole map) and the rename is atomic.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ConversationEntry {
  contextId: string;
  topic: string;
  lastMessageAt: number;
  pendingAsyncTasks: string[];
}

export const DEFAULT_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function conversationKey(agentUrl: string, scope: string | undefined): string {
  return scope ? `${agentUrl}|${scope}` : agentUrl;
}

export function namedScope(contextId: string): string {
  return `named:${contextId}`;
}

export class ConversationStore {
  private entries: Record<string, ConversationEntry> = {};
  private dirty = new Set<string>();
  private seq = 0;

  constructor(
    private readonly file: string,
    private readonly idleTtlMs: number = DEFAULT_IDLE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  private readDisk(): Record<string, ConversationEntry> {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, "utf-8"));
        if (parsed && typeof parsed === "object") return parsed;
      }
    } catch { /* corrupt or unreadable: treat as empty */ }
    return {};
  }

  load(): void {
    this.entries = this.readDisk();
    for (const e of Object.values(this.entries)) {
      const m = e?.topic?.match(/^#(\d+)/);
      if (m) this.seq = Math.max(this.seq, parseInt(m[1], 10));
    }
    // Drop long-idle entries, including entries from pi sessions that no longer exist.
    for (const [k, e] of Object.entries(this.entries)) {
      if (!e || this.now() - e.lastMessageAt > this.idleTtlMs) {
        delete this.entries[k];
        this.dirty.add(k);
      }
    }
    if (this.dirty.size) this.flush();
  }

  /** Merge only the keys this process changed into the file other processes also write. */
  private flush(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const disk = this.readDisk();
      for (const k of this.dirty) {
        if (this.entries[k]) disk[k] = this.entries[k];
        else delete disk[k];
      }
      this.dirty.clear();
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(disk, null, 2));
      fs.renameSync(tmp, this.file);
    } catch { /* best effort */ }
  }

  get(key: string): ConversationEntry | undefined {
    return this.entries[key];
  }

  all(): Record<string, ConversationEntry> {
    return this.entries;
  }

  /** contextId to send for this key, or null when a new conversation should be started. */
  resolve(key: string): string | null {
    const e = this.entries[key];
    if (!e) return null;
    if (this.now() - e.lastMessageAt > this.idleTtlMs) return null;
    return e.contextId;
  }

  create(key: string, contextId: string, message: string): string {
    const num = ++this.seq;
    this.entries[key] = {
      contextId,
      topic: `#${num} ${message.slice(0, 50)}`,
      lastMessageAt: this.now(),
      pendingAsyncTasks: [],
    };
    this.dirty.add(key);
    this.flush();
    return `#${num}`;
  }

  touch(key: string): void {
    const e = this.entries[key];
    if (!e) return;
    e.lastMessageAt = this.now();
    this.dirty.add(key);
    this.flush();
  }

  remove(key: string): void {
    delete this.entries[key];
    this.dirty.add(key);
    this.flush();
  }

  addPending(key: string, taskId: string): void {
    const e = this.entries[key];
    if (!e) return;
    if (!e.pendingAsyncTasks.includes(taskId)) e.pendingAsyncTasks.push(taskId);
    e.lastMessageAt = this.now();
    this.dirty.add(key);
    this.flush();
  }

  completePending(key: string, taskId: string): void {
    const e = this.entries[key];
    if (!e) return;
    e.pendingAsyncTasks = e.pendingAsyncTasks.filter((id) => id !== taskId);
    this.dirty.add(key);
    this.flush();
  }
}
