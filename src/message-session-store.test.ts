import { describe, it, expect } from "vitest";
import { MessageSessionStore } from "./message-session-store.js";

const DAY = 24 * 60 * 60 * 1000;

function createStore(options: { ttlDays?: number; maxEntries?: number } = {}) {
  const clock = { now: 1_000_000_000_000 };
  const store = new MessageSessionStore({
    ttlDays: options.ttlDays ?? 7,
    maxEntries: options.maxEntries,
    file: null,
    now: () => clock.now,
  });
  return { store, clock };
}

describe("MessageSessionStore", () => {
  it("記録したメッセージ ID からセッションを引ける", () => {
    const { store } = createStore();
    store.record(["m1", "m2"], "s1", "ch1");

    expect(store.lookup("m1")).toMatchObject({ sessionId: "s1", channelId: "ch1", expired: false });
    expect(store.lookup("m2")).toMatchObject({ sessionId: "s1", expired: false });
    expect(store.lookup("unknown")).toBeUndefined();
  });

  it("TTL 内は有効、TTL を過ぎると expired、TTL*2 を過ぎると見つからない", () => {
    const { store, clock } = createStore({ ttlDays: 7 });
    store.record(["m1"], "s1", "ch1");

    clock.now += 7 * DAY;
    expect(store.lookup("m1")?.expired).toBe(false);

    clock.now += 1;
    expect(store.lookup("m1")?.expired).toBe(true);

    clock.now += 7 * DAY;
    expect(store.lookup("m1")).toBeUndefined();
  });

  it("prune で TTL*2 を過ぎたエントリだけが削除される", () => {
    const { store, clock } = createStore({ ttlDays: 7 });
    store.record(["old"], "s1", "ch1");
    clock.now += 10 * DAY;
    store.record(["new"], "s2", "ch1");
    clock.now += 5 * DAY; // old: 15日, new: 5日

    expect(store.prune()).toBe(1);
    expect(store.size).toBe(1);
    expect(store.lookup("new")?.expired).toBe(false);
  });

  it("touch で同じセッションの全エントリの期限が延びる", () => {
    const { store, clock } = createStore({ ttlDays: 7 });
    store.record(["m1"], "s1", "ch1");
    clock.now += 3 * DAY;
    store.record(["m2"], "s1", "ch1");
    store.record(["other"], "s2", "ch1");

    clock.now += 6 * DAY; // m1: 9日, m2: 6日
    expect(store.lookup("m1")?.expired).toBe(true);

    store.touch("s1");
    expect(store.lookup("m1")?.expired).toBe(false);
    expect(store.lookup("m2")?.expired).toBe(false);

    clock.now += 7 * DAY + 1;
    expect(store.lookup("m1")?.expired).toBe(true);
    // touch していない別セッションは延長されない (13日経過)
    expect(store.lookup("other")?.expired).toBe(true);
  });

  it("deleteSession で該当セッションのエントリがすべて消える", () => {
    const { store } = createStore();
    store.record(["m1", "m2"], "s1", "ch1");
    store.record(["m3"], "s2", "ch1");

    store.deleteSession("s1");
    expect(store.lookup("m1")).toBeUndefined();
    expect(store.lookup("m2")).toBeUndefined();
    expect(store.lookup("m3")).toBeDefined();
  });

  it("上限件数を超えると古いものから削除される", () => {
    const { store, clock } = createStore({ maxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      store.record([`m${i}`], `s${i}`, "ch1");
      clock.now += 1000;
    }

    expect(store.size).toBe(3);
    expect(store.lookup("m0")).toBeUndefined();
    expect(store.lookup("m1")).toBeUndefined();
    expect(store.lookup("m4")).toBeDefined();
  });
});
