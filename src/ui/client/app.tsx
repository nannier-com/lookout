import "@nannier-com/canvas/styles/canvas.css";
import "./app.css";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Alert, AlertDialog, Badge, Button, Column, Drawer, Icon, Image, OverlayProvider, Row, ScrollView, ThemeProvider, Typography, useFormFactor, useTheme, useWindowDimensions, View } from "@nannier-com/canvas";
import type { BoardShot } from "../../report/board-types.js";
import { IssuesBoard } from "./react-board.js";
import { JudgePanel } from "./react-judge.js";
import { LearningPanel } from "./react-learning.js";
import { SettingsPanel } from "./react-settings.js";
import { ShotInspector, type OpenShot } from "./react-shot.js";
import { post, storedJudgeFold, storedTools, useLookoutData, type Area, type Filter } from "./react-state.js";
import { RunClock } from "./react-time.js";
import { project, type SvSidecar } from "./shot-project.js";

/**
 * A tool's mark, as something an `<img>` can load.
 *
 * The mark is inline SVG, and an image element loads it as a standalone
 * document rather than as markup in this page. Nothing there inherits from the
 * page, so a mark drawn in `currentColor` would resolve to black and vanish on
 * a dark background. The colour it asked to borrow is resolved here, where the
 * live theme is known, and baked in before the document is encoded.
 */
function markSource(mark: string, color: string): { uri: string } {
  const painted = mark.replaceAll("currentColor", color);
  return { uri: `data:image/svg+xml,${encodeURIComponent(painted)}` };
}

function AppFrame(): React.JSX.Element {
  const data = useLookoutData();
  const { tokens, scheme } = useTheme();
  // Canvas resolves the scheme in React and paints its own components from it,
  // but its CSS token layer keys off a `.dark` class on the root and the kit
  // does not put it there: reaching into the DOM is a thing Canvas forbids
  // itself, so applying it is the consuming app's job. Without this the page
  // ran Canvas's LIGHT custom properties under its dark components, which is
  // why the document behind them was painted white.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", scheme === "dark");
  }, [scheme]);
  const phone = useFormFactor() === "phone";
  const viewport = useWindowDimensions();
  const [selectedTools, setSelectedTools] = useState<string[]>(storedTools);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [area, setArea] = useState<Area>("issues");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [judgeShut, setJudgeShut] = useState(storedJudgeFold);
  const [shot, setShot] = useState<OpenShot | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const shotOpener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setSelectedTools((current) => {
      const kept = current.filter((key) => data.tools.some((tool) => tool.key === key));
      return kept.length ? kept : data.tools[0] ? [data.tools[0].key] : [];
    });
  }, [data.tools]);
  useEffect(() => { if (area === "learning") void data.loadLearning(); }, [area, data.loadLearning, data.status?.status.learning]);
  useEffect(() => {
    const failure = data.status?.lastFailure;
    if (failure) setNotice(`${failure.message}${failure.code ? ` (exit ${failure.code})` : ""}`);
  }, [data.status?.lastFailure]);
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (confirmReset) { setConfirmReset(false); setSettingsOpen(true); }
      else if (shot) setShot(null);
      else if (settingsOpen) setSettingsOpen(false);
      else if (filter) setFilter(null);
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [confirmReset, filter, settingsOpen, shot]);

  const applySettings = async (path: string, body?: object): Promise<void> => {
    const response = await post(path, body);
    const payload = await response.json() as import("../project.js").SettingsView & { error?: string; cancelled?: boolean };
    if (payload.cancelled) return;
    if (!response.ok || payload.error) {
      setNotice(payload.error ?? `Request failed with status ${response.status}`);
      return;
    }
    setNotice(null);
    await data.refreshSettings();
    await data.refresh();
  };
  const toggleTool = (key: string): void => {
    setSelectedTools((current) => {
      if (current.includes(key) && current.length === 1) return current;
      const next = current.includes(key) ? current.filter((item) => item !== key) : data.tools.filter((tool) => current.includes(tool.key) || tool.key === key).map((tool) => tool.key);
      try { localStorage.setItem("lookout.tools", JSON.stringify(next)); } catch { /* Session state still works. */ }
      return next;
    });
  };
  const openShot = async (next: BoardShot): Promise<void> => {
    shotOpener.current = document.activeElement as HTMLElement | null;
    const base: OpenShot = { shot: next, boxes: [], hint: next.provenance ? "Loading element provenance" : "no provenance recorded for this shot" };
    setShot(base);
    if (!next.provenance) return;
    try {
      const response = await fetch(`/evidence/${encodeURIComponent(next.provenance)}`);
      const sidecar = await response.json() as SvSidecar;
      const boxes = project(sidecar);
      setShot({ shot: next, boxes, aspectRatio: sidecar.image.width / sidecar.image.height, hint: boxes.length ? `${boxes.length} element(s): select one to read its source` : "no elements recorded for this shot" });
    } catch {
      setShot({ ...base, hint: "no provenance recorded for this shot" });
    }
  };
  const closeShot = (): void => {
    setShot(null);
    requestAnimationFrame(() => shotOpener.current?.focus());
  };
  const toggleJudge = (): void => {
    setJudgeShut((current) => {
      const next = !current;
      try { localStorage.setItem("lookout.judge", next ? "shut" : "open"); } catch { /* Session state still works. */ }
      return next;
    });
  };

  const status = data.status?.status;
  const walked = data.status?.events.filter((event) => event.kind === "note" && typeof event.data?.checked === "number").at(-1);
  const runNote = walked?.data?.found ? `Stopped at ${String(walked.data.route)} after looking at ${String(walked.data.checked)} of ${String(walked.data.of)} routes. Fix these, then run again for the next route.` : null;
  const queued = useMemo(() => new Set(status?.queue.map((item) => item.issue) ?? []), [status?.queue]);
  const stats = status ? [
    { kind: "state" as const, value: "open", label: "open", count: status.issues.open + status.issues.verifying },
    { kind: "state" as const, value: "blocked", label: "blocked", count: status.issues.blocked },
    { kind: "state" as const, value: "done", label: "done", count: status.issues.done },
    { kind: "state" as const, value: "archived", label: "archived", count: status.issues.archived },
    { kind: "severity" as const, value: "critical", label: "critical", count: status.findings.critical },
    { kind: "severity" as const, value: "high", label: "high", count: status.findings.high },
    { kind: "severity" as const, value: "medium", label: "medium", count: status.findings.medium },
    { kind: "severity" as const, value: "low", label: "low", count: status.findings.low },
    { kind: "state" as const, value: "shots", label: "shots", count: status.shots, static: true as const },
  ] : [];
  const statControls = area === "issues" ? stats.map((item) => <View key={`${item.kind}-${item.value}`}>{"static" in item ? <Badge outline testID="stat-shots">{item.count} {item.label}</Badge> : <Button small outline testID={`stat-${item.value}`} disabled={!item.count} onPress={() => setFilter({ kind: item.kind, value: item.value, label: item.label })}>{item.count} {item.label}</Button>}</View>) : null;

  const railWidth = phone ? 56 : 64;
  const runHint = status?.checkStopping
    ? "Stopping: the run and judge are being shut down"
    : status?.checkRunning
      ? `Stop the run: it is checking ${data.status?.projectDir ?? "this project"}. This also stops the judge it started.`
      : data.status?.configured
        ? `Find and fix: one check of ${data.status.projectDir}, stopping at the first issue.${data.settings?.navigation ? " Calls to action are ON: it will click this project's buttons and links, destructive ones included." : ""}`
        : "Open settings and choose a project first";
  return <View style={{ minHeight: "100vh", height: "100vh", flexDirection: "row", backgroundColor: tokens.background }}>
    <View accessibilityRole="none" style={{ width: railWidth, minWidth: railWidth, height: "100%", borderRightWidth: 1, borderRightColor: tokens.border }} {...({ role: "navigation", "aria-label": "Areas" } as object)}><Column between grow alignCenter padTight><Column snug alignCenter><View {...({ "aria-current": area === "issues" ? "page" : undefined } as object)}><Button ghost icon testID="area-issues" accessibilityLabel="Issues" onPress={() => setArea("issues")} iconLeft={<Icon layoutDashboard primary={area === "issues"} muted={area !== "issues"} decorative />} /></View><View {...({ "aria-current": area === "learning" ? "page" : undefined, title: status?.learning.running ? "lookout is working on itself right now" : status?.learning.proposed ? "an amendment lookout wrote is waiting to be read" : "What lookout has changed about itself" } as object)}><Button ghost icon testID="area-learning" accessibilityLabel="What lookout has changed about itself" onPress={() => setArea("learning")} iconLeft={<Icon sparkles primary={area === "learning"} muted={area !== "learning"} decorative />} />{status?.learning.running || status?.learning.proposed ? <Badge {...(status.learning.running ? { primary: true } : { warning: true })}>{status.learning.running ? "live" : "new"}</Badge> : null}</View></Column><View nativeID="cog"><Button ghost icon testID="settings-button" accessibilityLabel={settingsOpen ? "Close settings" : "Settings"} expanded={settingsOpen} onPress={() => setSettingsOpen((open) => !open)} iconLeft={<Icon settings decorative />} /></View></Column></View>
    <View nativeID="workspace" style={{ minWidth: 0, height: "100%", flex: 1 }}>
      <View style={{ padding: phone ? 12 : 16, borderBottomWidth: 1, borderBottomColor: tokens.border }} {...({ role: "banner" } as object)}><Column snug>
        <Row between alignCenter wrap snug><Column tight><Typography h1 tightLeading>{data.status?.project ? `lookout · ${data.status.project}` : "lookout"}</Typography><Row snug><Typography tiny muted>{status?.runId ? status.phase : "no run recorded yet"}</Typography>{status?.startedAt ? <RunClock startedAt={status.startedAt} endedAt={status.endedAt} running={status.running} lastEventAt={status.lastEventAt} /> : null}</Row></Column>
          <Row snug alignCenter wrap><View nativeID="toolToggle"><Row tight>{data.tools.map((tool) => { const selected = selectedTools.includes(tool.key); const hint = tool.installed ? `Work issues in ${tool.label}; select both and they take turns on the same issue` : `${tool.bin} is not on PATH; the command is shown so you can run it yourself`; return <View key={tool.key} testID="tool-choice" {...({ title: hint, dataSet: { tool: tool.key, selected: String(selected), missing: String(!tool.installed) } } as object)}><Button small secondary={selected} ghost={!selected} testID={`tool-${tool.key}`} accessibilityLabel={`${tool.label}, ${selected ? "selected" : "not selected"}`} onPress={() => toggleTool(tool.key)} iconLeft={<Image source={markSource(tool.mark, selected ? tokens["secondary-foreground"] : tokens.foreground)} width={16} height={16} contain alt="" />}>{tool.label}</Button></View>; })}</Row></View>
            <View nativeID="findfix"><Button primary icon accessibilityLabel={runHint} testID="find-fix" disabled={status?.checkStopping || !data.status?.configured} onPress={() => void post(status?.checkRunning ? "/api/stop" : "/api/check").then(data.refresh)} iconLeft={<Icon primaryForeground decorative {...(status?.checkRunning ? { square: true } : { play: true })} />} /></View>
          </Row>
        </Row>
        <Row between alignCenter wrap snug><View nativeID="stats" style={{ minWidth: 0, ...(phone ? { width: "100%" } : {}) }}>{phone ? <ScrollView horizontal><Row snug>{statControls}{filter ? <Button small ghost testID="clear-filter" onPress={() => setFilter(null)}>Clear</Button> : null}</Row></ScrollView> : <Row snug wrap>{statControls}{filter ? <Button small ghost testID="clear-filter" onPress={() => setFilter(null)}>Clear</Button> : null}</Row>}</View><View nativeID="where" style={{ minWidth: 0, maxWidth: "100%", overflow: "hidden" }} {...({ title: notice ? `${notice}\n\n${data.status?.projectDir ?? ""}` : data.status?.projectDir ?? "", dataSet: { notice: String(!!notice) } } as object)}>{notice ? <Alert destructive description={notice} /> : <Typography tiny muted style={{ flexShrink: 1 }}>{data.status?.projectDir ?? ""}</Typography>}</View></Row>
        {runNote ? <Alert warning title="Run stopped at the first issue" description={runNote} /> : null}
      </Column></View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: phone ? 12 : 20 }} {...({ role: "main", tabIndex: 0 } as object)}>{area === "issues" ? <IssuesBoard entries={status?.board ?? []} filter={filter} queued={queued} tools={selectedTools} attemptCap={status?.attemptCap ?? 2} refresh={data.refresh} onOpenShot={(next) => void openShot(next)} /> : <LearningPanel value={data.learning} />}</ScrollView>
    </View>
    <JudgePanel payload={data.status} lines={data.narration} shut={judgeShut} phone={phone} onToggle={toggleJudge} onClear={() => void post("/api/narration/clear").then(() => data.clearNarration())} refresh={data.refresh} />
    <View style={{ position: "absolute", left: 0, top: 0, width: 0, height: 0 }}>
      <Drawer open={settingsOpen} onOpenChange={setSettingsOpen} left width={Math.min(560, viewport.width)} accessibilityLabel="Lookout settings" testID="settings-drawer">{data.settings ? <SettingsPanel settings={data.settings} onClose={() => setSettingsOpen(false)} onApply={applySettings} onReset={() => { setSettingsOpen(false); setConfirmReset(true); }} /> : null}</Drawer>
      <AlertDialog open={confirmReset} onOpenChange={(open) => { setConfirmReset(open); if (!open) setSettingsOpen(true); }} overlay destructive title="Delete everything lookout found?" description="This permanently removes this project's backlog, evidence, issue folders, and fix queue. It does not change the application being checked or its source files." confirmLabel="Delete" cancelLabel="Cancel" testID="confirm" onConfirm={() => void post("/api/reset").then(async () => { setConfirmReset(false); setSettingsOpen(true); await data.refresh(); })} />
      {shot ? <ShotInspector value={shot} onClose={closeShot} onSelect={(hint) => setShot((current) => current ? { ...current, hint } : current)} /> : null}
    </View>
  </View>;
}

function App(): React.JSX.Element {
  return <ThemeProvider solid><OverlayProvider><AppFrame /></OverlayProvider></ThemeProvider>;
}

const root = document.getElementById("root");
if (!root) throw new Error("lookout UI root is missing");
createRoot(root).render(<App />);
