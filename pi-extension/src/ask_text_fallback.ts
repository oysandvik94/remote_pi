// Fork-local: plain-text fallback for @eko24ive/pi-ask questions.
//
// App builds that predate `extension_ui_request` cannot render the ask_user
// form. While a pi-ask flow is open, this module also posts the questions as
// an ordinary assistant chat bubble (`agent_message`, understood by every app
// build) and turns the user's next chat reply into a pi-ask submit. The rich
// bridge in extension_ui_bridge.ts keeps working for app builds that support
// forms; whichever answer arrives first resolves the flow.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "./protocol/types.js";

const PI_ASK_STARTED = "@eko24ive/pi-ask:started";
const PI_ASK_COMPLETED = "@eko24ive/pi-ask:completed";
const PI_ASK_SUBMIT = "@eko24ive/pi-ask:submit";
const PI_ASK_SUBMIT_RESULT = "@eko24ive/pi-ask:submit-result";

type EventBus = ExtensionAPI["events"];

export interface TextOption {
  value: string;
  label: string;
  description?: string;
}

export interface TextQuestion {
  id: string;
  prompt: string;
  multi: boolean;
  options: TextOption[];
}

interface TextFlow {
  flowId: string;
  title?: string;
  questions: TextQuestion[];
}

export type TextAnswer = { values?: string[]; customText?: string };

export type ParsedReply =
  | { kind: "cancel" }
  | { kind: "answer"; answers: Record<string, TextAnswer> }
  | { kind: "error"; message: string };

export interface AskTextFallback {
  /** True when `text` was consumed as an answer (or an answer error) for an open flow. */
  answerFromText(text: string): boolean;
  dispose(): void;
}

export function createAskTextFallback(
  pi: ExtensionAPI,
  broadcast: (msg: ServerMessage) => void,
): AskTextFallback | null {
  const events = (pi as { events?: EventBus }).events;
  if (!events || typeof events.on !== "function" || typeof events.emit !== "function") {
    return null;
  }
  const bus: EventBus = events;
  const flows = new Map<string, TextFlow>();
  let bubbleSeq = 0;
  let requestSeq = 0;

  function bubble(flowId: string, text: string): void {
    bubbleSeq += 1;
    broadcast({ type: "agent_message", in_reply_to: `ask-text:${flowId}:${bubbleSeq}`, text });
  }

  const unsubStarted = bus.on(PI_ASK_STARTED, (raw: unknown) => {
    const flow = parseStarted(raw);
    if (!flow || flows.has(flow.flowId)) return;
    flows.set(flow.flowId, flow);
    bubble(flow.flowId, formatQuestions(flow));
  });

  const unsubCompleted = bus.on(PI_ASK_COMPLETED, (raw: unknown) => {
    const flowId = isRecord(raw) && typeof raw.flowId === "string" ? raw.flowId : undefined;
    if (flowId) flows.delete(flowId);
  });

  const unsubResult = bus.on(PI_ASK_SUBMIT_RESULT, (raw: unknown) => {
    if (!isRecord(raw) || raw.ok === true) return;
    if (typeof raw.requestId !== "string" || !raw.requestId.startsWith("ask-text-")) return;
    const flowId = typeof raw.flowId === "string" ? raw.flowId : "unknown";
    const message = typeof raw.message === "string" ? raw.message : "The answer was not accepted.";
    bubble(flowId, `⚠️ ${message} Reply again, or answer on the desktop.`);
  });

  function answerFromText(text: string): boolean {
    const flow = [...flows.values()].at(-1);
    if (!flow) return false;
    const parsed = parseReply(text, flow.questions);
    if (parsed.kind === "error") {
      bubble(flow.flowId, `⚠️ ${parsed.message}`);
      return true;
    }
    requestSeq += 1;
    try {
      bus.emit(PI_ASK_SUBMIT, {
        version: 1,
        requestId: `ask-text-${Date.now()}-${requestSeq}`,
        flowId: flow.flowId,
        response:
          parsed.kind === "cancel"
            ? { kind: "cancel" }
            : { kind: "answer", mode: "submit", answers: parsed.answers },
      });
    } catch {
      bubble(flow.flowId, "⚠️ Could not pass the answer to the question. Answer on the desktop.");
    }
    return true;
  }

  return {
    answerFromText,
    dispose() {
      unsubStarted();
      unsubCompleted();
      unsubResult();
      flows.clear();
    },
  };
}

export function formatQuestions(flow: { title?: string; questions: TextQuestion[] }): string {
  const lines: string[] = [];
  lines.push(`❓ **${flow.title ?? "Question"}**`);
  const many = flow.questions.length > 1;
  flow.questions.forEach((q, qi) => {
    lines.push("");
    const hint = q.multi ? " _(one or more, e.g. 1+3)_" : "";
    lines.push(`**${many ? `${qi + 1}. ` : ""}${q.prompt}**${hint}`);
    q.options.forEach((o, oi) => {
      lines.push(`  ${oi + 1}) ${o.label}${o.description ? ` — ${o.description}` : ""}`);
    });
  });
  lines.push("");
  if (many) {
    const example = flow.questions.map((_, i) => String((i % 2) + 1)).join("; ");
    lines.push(`Reply with one answer per question, separated by \`;\` (e.g. \`${example}\`). You can write text instead of a number. Reply \`cancel\` to cancel.`);
  } else {
    lines.push("Reply with the number, or write your own answer. Reply `cancel` to cancel.");
  }
  return lines.join("\n");
}

export function parseReply(text: string, questions: TextQuestion[]): ParsedReply {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "error", message: "Empty answer. Reply again." };
  if (/^cancel$/i.test(trimmed)) return { kind: "cancel" };

  let parts: string[];
  if (questions.length === 1) {
    parts = [trimmed];
  } else {
    parts = trimmed.split(/\s*(?:;|\n)\s*/).filter((p) => p.length > 0);
    if (parts.length !== questions.length && /^\d+(?:\s+\d+)+$/.test(trimmed)) {
      parts = trimmed.split(/\s+/);
    }
    if (parts.length !== questions.length) {
      return {
        kind: "error",
        message: `Expected ${questions.length} answers separated by \`;\`, got ${parts.length}. Reply again.`,
      };
    }
  }

  const answers: Record<string, TextAnswer> = {};
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    const part = parts[i]!;
    const numbers = q.multi ? /^\d+(?:\s*[+,]\s*\d+)*$/ : /^\d+$/;
    if (q.options.length > 0 && numbers.test(part)) {
      const picks = [...new Set(part.split(/\s*[+,]\s*/).map((n) => Number(n)))];
      const bad = picks.find((n) => n < 1 || n > q.options.length);
      if (bad !== undefined) {
        return {
          kind: "error",
          message: `Option ${bad} does not exist for "${q.prompt}" (1–${q.options.length}). Reply again.`,
        };
      }
      answers[q.id] = { values: picks.map((n) => q.options[n - 1]!.value) };
    } else {
      answers[q.id] = { customText: part };
    }
  }
  return { kind: "answer", answers };
}

function parseStarted(raw: unknown): TextFlow | null {
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.flowId !== "string") return null;
  if (!Array.isArray(raw.questions) || raw.questions.length === 0) return null;
  const questions: TextQuestion[] = [];
  for (const q of raw.questions) {
    if (!isRecord(q) || typeof q.id !== "string" || typeof q.prompt !== "string") return null;
    const options: TextOption[] = [];
    for (const o of Array.isArray(q.options) ? q.options : []) {
      if (!isRecord(o)) return null;
      // A freeform option means "type your answer"; free text covers it.
      if (o.freeform === true) continue;
      const value = typeof o.value === "string" ? o.value : typeof o.label === "string" ? o.label : undefined;
      const label = typeof o.label === "string" ? o.label : value;
      if (!value || !label) return null;
      options.push({ value, label, ...(typeof o.description === "string" && o.description ? { description: o.description } : {}) });
    }
    questions.push({ id: q.id, prompt: q.prompt, multi: q.type === "multi", options });
  }
  return {
    flowId: raw.flowId,
    ...(typeof raw.title === "string" && raw.title ? { title: raw.title } : {}),
    questions,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
