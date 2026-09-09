/**
 * The tool server for one navigation session, spoken over stdio to the AI's
 * CLI. It reads the session, opens the driver the session's platform needs,
 * exposes that platform's tools, and leaves its record in the session file
 * when the conversation ends.
 *
 * Two rules keep it honest. A refusal is a tool result the model reads and
 * chooses differently on, never a protocol error that ends the conversation.
 * And the server outlives nothing: it exits when its stdin closes, when its
 * parent is gone, on SIGTERM, and when the invocation has run past its limit,
 * closing the browser and writing the result first.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { basename, join } from "node:path";
import { evidenceDir, loadConfig } from "../config.js";
import { NavSkip, NavStateError } from "../navigate/execute.js";
import { EventLog } from "../report/events.js";
import { LookoutError } from "../types.js";
import { nowIso } from "../util.js";
import { ToolRefusal, type Driver } from "./driver.js";
import { DeviceDriver } from "./driver-device.js";
import { WebDriver } from "./driver-web.js";
import { emptyResult, readNavSession, writeNavResult, type NavResult } from "./session.js";
import type { ToolState } from "./tool.js";
import { toolsFor } from "./tools.js";

const EXIT_GRACE_MS = 60_000;
const PARENT_POLL_MS = 2000;

function driverFor(state: Pick<ToolState, "session" | "log">, resolved: Awaited<ReturnType<typeof loadConfig>>, targetName: string): Driver {
  const target = resolved.config.targets.find((t) => t.name === targetName);
  if (!target) throw new LookoutError(`unknown target "${targetName}"`);
  const ctx = { session: state.session, resolved, target, log: state.log };
  return state.session.platform === "web" ? new WebDriver(ctx) : new DeviceDriver(ctx);
}

function resultOf(state: ToolState, note: string): NavResult {
  const lastLook = state.lastLook ? { lastLook: state.lastLook } : {};
  if (!state.arrived) return { ...emptyResult(state.calls, note), actions: state.actions, ...lastLook };
  return {
    arrived: true,
    at: nowIso(),
    actions: state.actions,
    arrival: state.arrived.arrival,
    shots: state.arrived.shots,
    failures: state.arrived.failures,
    calls: state.calls,
    note,
    ...lastLook,
  };
}

/** Run one session's server until the conversation ends. Resolves when everything is closed. */
export async function serveSession(sessionPath: string, io?: { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream }): Promise<void> {
  const session = await readNavSession(sessionPath);
  const resolved = await loadConfig({ configPath: session.configPath });
  const log = EventLog.attach(resolved, session.runId);
  const base = { session, log };
  const lookRel = `navigate/${basename(sessionPath, ".json")}`;
  const state: ToolState = {
    ...base,
    driver: driverFor(base, resolved, session.target),
    actions: [],
    snapshot: null,
    calls: [],
    arrived: null,
    lookDir: { abs: join(evidenceDir(resolved), lookRel), rel: lookRel },
    lastLook: null,
  };

  const server = new McpServer({ name: "lookout", version: "1" });
  for (const def of toolsFor(session.platform)) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.input }, async (args) => {
      const started = Date.now();
      const call = { method: "tools/call", tool: def.name, at: nowIso(), ok: false, ms: 0 };
      state.calls.push(call);
      try {
        const reply = await withTimeout(
          def.run(args as never, state),
          def.name === "arrive" ? 10 * 60_000 : session.limits.toolTimeoutMs,
          `${def.name} took longer than allowed`,
        );
        call.ok = true;
        if (def.name === "arrive") await writeNavResult(sessionPath, resultOf(state, "")).catch(() => {});
        return {
          content: [
            { type: "text" as const, text: reply.text },
            ...(reply.image ? [{ type: "image" as const, data: reply.image.toString("base64"), mimeType: "image/jpeg" }] : []),
          ],
        };
      } catch (e) {
        // A refusal, a control that is not there, a screen that is not the
        // one recorded: all of them are answers the model can act on. So is
        // anything else that went wrong; a crash would end the conversation
        // with nothing written down.
        const reason = e instanceof ToolRefusal || e instanceof NavSkip || e instanceof NavStateError
          ? e.message
          : `${def.name} failed: ${e instanceof Error ? e.message : String(e)}`;
        return { content: [{ type: "text" as const, text: reason }], isError: true };
      } finally {
        call.ms = Date.now() - started;
      }
    });
  }

  let finishing: Promise<void> | null = null;
  const finish = (note: string): Promise<void> => {
    finishing ??= (async () => {
      await writeNavResult(sessionPath, resultOf(state, note)).catch(() => {});
      await state.driver.close().catch(() => {});
      await server.close().catch(() => {});
    })();
    return finishing;
  };

  const transport = new StdioServerTransport(io?.stdin as never, io?.stdout as never);
  transport.onclose = () => void finish("the conversation ended");
  const parent = process.ppid;
  const poll = setInterval(() => {
    if (process.ppid !== parent) void finish("the parent process went away");
  }, PARENT_POLL_MS);
  const deadline = setTimeout(() => void finish("the invocation ran past its limit"), session.limits.invocationMs + EXIT_GRACE_MS);
  const onTerm = (): void => void finish("terminated");
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onTerm);

  state.calls.push({ method: "initialize", at: nowIso(), ok: true, ms: 0 });
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      if (finishing) {
        clearInterval(tick);
        void finishing.then(resolve);
      }
    }, 100);
  });
  clearInterval(poll);
  clearTimeout(deadline);
  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onTerm);
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolRefusal(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
