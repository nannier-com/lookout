import { useCallback, useEffect, useState } from "react";
import type { ToolChoice } from "../../report/handoff.js";
import type { Learning } from "../../report/learning.js";
import type { NarrationFrame } from "../narration.js";
import type { StatusPayload } from "../payload.js";
import type { SettingsView } from "../project.js";

export type Area = "issues" | "learning";
export interface Filter {
  kind: "state" | "severity";
  value: string;
  label: string;
}

export async function post(path: string, body?: object): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

export function storedTools(): string[] {
  try {
    const many = localStorage.getItem("lookout.tools");
    if (many) {
      const parsed = JSON.parse(many) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
    }
    const one = localStorage.getItem("lookout.tool");
    return one ? [one] : [];
  } catch {
    return [];
  }
}

export function storedJudgeFold(): boolean {
  try {
    return localStorage.getItem("lookout.judge") === "shut";
  } catch {
    return false;
  }
}

export interface LookoutData {
  status: StatusPayload | null;
  settings: SettingsView | null;
  tools: ToolChoice[];
  narration: NarrationFrame["lines"];
  learning: Learning | null;
  refresh: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  loadLearning: () => Promise<void>;
  clearNarration: () => void;
}

export function useLookoutData(): LookoutData {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [tools, setTools] = useState<ToolChoice[]>([]);
  const [narration, setNarration] = useState<NarrationFrame["lines"]>([]);
  const [learning, setLearning] = useState<Learning | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/status");
    if (response.ok) setStatus(await response.json() as StatusPayload);
  }, []);
  const refreshSettings = useCallback(async () => {
    const response = await fetch("/api/settings");
    if (response.ok) setSettings(await response.json() as SettingsView);
  }, []);
  const loadLearning = useCallback(async () => {
    const response = await fetch("/api/learning");
    if (response.ok) setLearning(await response.json() as Learning);
  }, []);

  useEffect(() => {
    void Promise.all([
      refresh(),
      refreshSettings(),
      fetch("/api/tools").then((response) => response.json() as Promise<ToolChoice[]>).then(setTools),
      fetch("/api/narration").then((response) => response.json() as Promise<NarrationFrame>).then((frame) => setNarration(frame.lines)),
    ]);
  }, [refresh, refreshSettings]);

  useEffect(() => {
    let active = true;
    let socket: WebSocket | null = null;
    let retry = 400;
    let timer: number | null = null;
    const connect = (): void => {
      if (!active) return;
      socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live`);
      socket.onopen = () => { retry = 400; };
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as
            | { kind: "status"; body: StatusPayload }
            | { kind: "narration"; body: NarrationFrame };
          if (frame.kind === "status") setStatus(frame.body);
          else setNarration((current) => frame.body.reset ? frame.body.lines : [...current, ...frame.body.lines]);
        } catch {
          // A frame from another protocol version does not take down the page.
        }
      };
      socket.onclose = () => {
        if (!active) return;
        timer = window.setTimeout(connect, retry);
        retry = Math.min(retry * 2, 8000);
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    const fallback = window.setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) void refresh();
    }, 5000);
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
      window.clearInterval(fallback);
      socket?.close();
    };
  }, [refresh]);

  return {
    status,
    settings,
    tools,
    narration,
    learning,
    refresh,
    refreshSettings,
    loadLearning,
    clearNarration: () => setNarration([]),
  };
}
