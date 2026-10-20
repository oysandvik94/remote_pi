import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createAskTextFallback, parseReply, type TextQuestion } from "./ask_text_fallback.js";
import type { ServerMessage } from "./protocol/types.js";

function fakeBus() {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  const emitted: Array<{ name: string; data: any }> = [];
  return {
    on(name: string, cb: (d: unknown) => void) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(cb);
      return () => handlers.get(name)?.delete(cb);
    },
    emit(name: string, data: unknown) {
      emitted.push({ name, data });
      handlers.get(name)?.forEach((cb) => cb(data));
    },
    emitted,
  };
}

const drink: TextQuestion = { id: "drink", prompt: "Drink?", multi: false, options: [
  { value: "coffee", label: "Coffee" }, { value: "tea", label: "Tea" }] };
const extras: TextQuestion = { id: "extras", prompt: "Extras?", multi: true, options: [
  { value: "milk", label: "Milk" }, { value: "sugar", label: "Sugar" }, { value: "ice", label: "Ice" }] };

describe("parseReply", () => {
  it("maps a number to the option value", () => {
    expect(parseReply(" 2 ", [drink])).toEqual({ kind: "answer", answers: { drink: { values: ["tea"] } } });
  });
  it("treats non-numbers as custom text", () => {
    expect(parseReply("oat latte", [drink])).toEqual({ kind: "answer", answers: { drink: { customText: "oat latte" } } });
  });
  it("handles several questions and multi-select", () => {
    expect(parseReply("1; 1+3", [drink, extras])).toEqual({ kind: "answer", answers: {
      drink: { values: ["coffee"] }, extras: { values: ["milk", "ice"] } } });
    expect(parseReply("2 3", [drink, extras])).toEqual({ kind: "answer", answers: {
      drink: { values: ["tea"] }, extras: { values: ["ice"] } } });
  });
  it("rejects out-of-range numbers and wrong answer counts", () => {
    expect(parseReply("5", [drink]).kind).toBe("error");
    expect(parseReply("1", [drink, extras]).kind).toBe("error");
  });
  it("supports cancel", () => {
    expect(parseReply("Cancel", [drink])).toEqual({ kind: "cancel" });
  });
});

describe("createAskTextFallback", () => {
  it("posts a chat bubble on start and turns a reply into a pi-ask submit", () => {
    const bus = fakeBus();
    const sent: ServerMessage[] = [];
    const fb = createAskTextFallback({ events: bus } as unknown as ExtensionAPI, (m) => sent.push(m))!;
    expect(fb.answerFromText("1")).toBe(false);

    bus.emit("@eko24ive/pi-ask:started", { version: 1, flowId: "f1", title: "Test", questions: [
      { id: "drink", prompt: "Drink?", type: "single", options: [{ value: "coffee", label: "Coffee" }, { value: "tea", label: "Tea" }] }] });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe("agent_message");
    expect((sent[0] as { text: string }).text).toContain("1) Coffee");

    expect(fb.answerFromText("2")).toBe(true);
    const submit = bus.emitted.find((e) => e.name === "@eko24ive/pi-ask:submit")!;
    expect(submit.data.flowId).toBe("f1");
    expect(submit.data.response).toEqual({ kind: "answer", mode: "submit", answers: { drink: { values: ["tea"] } } });

    bus.emit("@eko24ive/pi-ask:completed", { version: 1, flowId: "f1" });
    expect(fb.answerFromText("2")).toBe(false);
  });

  it("reports a parse error in chat without submitting", () => {
    const bus = fakeBus();
    const sent: ServerMessage[] = [];
    const fb = createAskTextFallback({ events: bus } as unknown as ExtensionAPI, (m) => sent.push(m))!;
    bus.emit("@eko24ive/pi-ask:started", { version: 1, flowId: "f1", questions: [
      { id: "drink", prompt: "Drink?", options: [{ value: "coffee", label: "Coffee" }] }] });
    expect(fb.answerFromText("9")).toBe(true);
    expect(sent).toHaveLength(2);
    expect(bus.emitted.some((e) => e.name === "@eko24ive/pi-ask:submit")).toBe(false);
  });
});
