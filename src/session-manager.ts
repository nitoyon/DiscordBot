import { readFileSync, writeFileSync } from "fs";

const SESSION_FILE = ".sessions.json";

export class SessionManager {
  private sessions: Map<string, string>;

  constructor() {
    this.sessions = new Map();
    this.load();
  }

  getSessionId(channelId: string): string | undefined {
    return this.sessions.get(channelId);
  }

  setSessionId(channelId: string, sessionId: string): void {
    this.sessions.set(channelId, sessionId);
    this.save();
  }

  deleteSessionId(channelId: string): void {
    this.sessions.delete(channelId);
    this.save();
  }

  private load(): void {
    try {
      const raw = readFileSync(SESSION_FILE, "utf-8");
      const data = JSON.parse(raw) as Record<string, string>;
      for (const [k, v] of Object.entries(data)) {
        this.sessions.set(k, v);
      }
    } catch {
      // File doesn't exist yet — start fresh
    }
  }

  private save(): void {
    const obj: Record<string, string> = {};
    for (const [k, v] of this.sessions) {
      obj[k] = v;
    }
    writeFileSync(SESSION_FILE, JSON.stringify(obj, null, 2) + "\n");
  }
}
