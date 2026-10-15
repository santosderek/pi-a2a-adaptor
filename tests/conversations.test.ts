import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { ConversationStore, conversationKey, namedScope } from "../src/conversations.js";
import { TaskManager } from "../src/task-manager.js";

const URL_A = "http://hermes.lakewind:10000";
let file: string;

beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "a2a-conv-")), "conversations.json");
});

describe("ConversationStore", () => {
  it("isolates two pi sessions talking to the same agent", () => {
    const s1 = new ConversationStore(file); s1.load();
    const s2 = new ConversationStore(file); s2.load();
    const k1 = conversationKey(URL_A, "pi-1");
    const k2 = conversationKey(URL_A, "pi-2");
    s1.create(k1, "ctx-one", "hello");
    s2.create(k2, "ctx-two", "hi");
    expect(s1.resolve(k1)).toBe("ctx-one");
    expect(s2.resolve(k2)).toBe("ctx-two");
    // fresh process sees both: neither write clobbered the other
    const s3 = new ConversationStore(file); s3.load();
    expect(s3.resolve(k1)).toBe("ctx-one");
    expect(s3.resolve(k2)).toBe("ctx-two");
  });

  it("persists across restart and removes only its own key", () => {
    const a = new ConversationStore(file); a.load();
    const k = conversationKey(URL_A, "pi-1");
    a.create(k, "ctx-one", "m");
    const b = new ConversationStore(file); b.load();
    expect(b.resolve(k)).toBe("ctx-one");
    b.create(conversationKey(URL_A, "pi-2"), "ctx-two", "m");
    a.remove(k);
    const c = new ConversationStore(file); c.load();
    expect(c.resolve(k)).toBeNull();
    expect(c.resolve(conversationKey(URL_A, "pi-2"))).toBe("ctx-two");
  });

  it("expires idle entries and prunes them on load", () => {
    let t = 1_000;
    const a = new ConversationStore(file, 100, () => t); a.load();
    const k = conversationKey(URL_A, "pi-1");
    a.create(k, "ctx-one", "m");
    t += 101;
    expect(a.resolve(k)).toBeNull();
    const b = new ConversationStore(file, 100, () => t); b.load();
    expect(b.get(k)).toBeUndefined();
  });

  it("named contexts use their own key and can be shared", () => {
    const a = new ConversationStore(file); a.load();
    const k = conversationKey(URL_A, namedScope("ctx-shared"));
    a.create(k, "ctx-shared", "m");
    const b = new ConversationStore(file); b.load();
    expect(b.resolve(k)).toBe("ctx-shared");
  });

  it("tolerates a corrupt file", () => {
    fs.writeFileSync(file, "{not json");
    const a = new ConversationStore(file); a.load();
    expect(a.all()).toEqual({});
    a.create("k", "c", "m");
    expect(JSON.parse(fs.readFileSync(file, "utf-8")).k.contextId).toBe("c");
  });
});

describe("TaskManager contextId propagation", () => {
  it("sends the supplied contextId in the message (reuse) and none otherwise", async () => {
    const sent: any[] = [];
    const client: any = {
      sendMessage: async (_a: any, m: any) => { sent.push(m); return { id: "t", contextId: m.contextId, status: { state: "completed" } }; },
    };
    const tm = new TaskManager(client, {} as any);
    await tm.sendTask({ url: URL_A } as any, "x", { contextId: "ctx-keep" });
    await tm.sendTask({ url: URL_A } as any, "y", { contextId: null });
    expect(sent[0].contextId).toBe("ctx-keep");
    expect("contextId" in sent[1]).toBe(false);
  });
});
