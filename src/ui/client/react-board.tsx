import React, { useState } from "react";
import {
  Alert,
  Badge,
  BadgeGroup,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Column,
  Divider,
  Grid,
  Image,
  Row,
  ScrollView,
  Typography,
  useFormFactor,
  View,
} from "@nannier-com/canvas";
import type { BoardEntry, BoardShot } from "../../report/board-types.js";
import { post, type Filter } from "./react-state.js";
import { AgeText } from "./react-time.js";
import { issueDocumentHref } from "./dom.js";

export function issueMatches(entry: BoardEntry, filter: Filter | null): boolean {
  if (!filter) return entry.status !== "done" && entry.status !== "archived";
  if (filter.kind === "severity") return entry.severity === filter.value;
  if (filter.value === "open") return ["open", "verifying", "still-open"].includes(entry.status);
  return entry.status === filter.value;
}

function statusLabel(status: BoardEntry["status"]): string {
  return ({ open: "Open", verifying: "Verifying", "still-open": "Still open", blocked: "Needs a person", done: "Fixed", archived: "Archived" })[status];
}

function statusExplanation(entry: BoardEntry): string {
  const attempts = entry.attempt ? ` after ${entry.attempt} attempt${entry.attempt === 1 ? "" : "s"}` : "";
  if (entry.status === "verifying") return "lookout is re-judging this now.";
  if (entry.status === "still-open") return `A fix was reported, but lookout still sees the defect${attempts}.`;
  if (entry.status === "blocked") return `lookout ran out of attempts${attempts}. This one needs a person.`;
  if (entry.status === "done") return "lookout confirmed the defect is gone.";
  if (entry.status === "archived") return entry.archived?.reason === "fixed" ? "Fixed, and filed away." : "Adjudicated as intentional.";
  return "Open. Nothing has been ruled on yet.";
}

function pairKey(shot: BoardShot): string {
  return [shot.route, shot.platform ?? "web", shot.formFactor, shot.scheme, shot.state ?? ""].join("|");
}

/** A thumbnail that opens the inspector. `name` is for a tile standing under a
 *  column header that already names it: the tile is then the picture alone,
 *  sized by its column rather than fixed, and `name` is what a screen reader
 *  reads in place of the caption. */
function ShotTile({ shot, name, onOpen }: { shot: BoardShot; name?: string; onOpen: (shot: BoardShot) => void }): React.JSX.Element {
  const caption = [shot.platform !== "web" ? shot.platform : "", shot.formFactor, shot.scheme].filter(Boolean).join(" · ");
  // A named tile shares its row with the other half of the pair, so a fixed
  // width would overflow the column on a phone and butt the two frames
  // together. The box keeps the crop the captioned tile has.
  const box = name ? { width: "100%" as const, style: { aspectRatio: 144 / 88 } } : { width: 144, height: 88 };
  return <View {...({ dataSet: { shot: shot.path, ...(shot.provenance ? { prov: shot.provenance } : {}) } } as object)}>
    <Button
      ghost small block
      testID={shot.provenance ? "shot-prov" : "shot-bare"}
      {...(name ? { accessibilityLabel: name } : {})}
      href={`/evidence/${encodeURIComponent(shot.path)}`}
      hrefAttrs={{ target: "_blank", rel: "noopener" }}
      onPress={(event) => { event.preventDefault?.(); onOpen(shot); }}
      iconLeft={<Image source={{ uri: `/thumb/${encodeURIComponent(shot.path)}?w=${name ? 380 : 264}` }} {...box} radius="md" cover alt="" />}
    >{name ? undefined : caption || shot.route}</Button>
  </View>;
}

// A pair's two columns never render a frame wider than the thumbnail behind it,
// so a card with the judge's column folded away shows bigger evidence rather
// than upscaled evidence.
const pairCell = { maxWidth: 380 };

/** One line per view: the frame from before the fix on the left, the one from
 *  after it on the right, and the views stacked down the card so the halves of
 *  every pair stay in the same two columns. */
function ShotPairs({ pairs, ruled, onOpenShot }: {
  pairs: Array<[BoardShot | null, BoardShot | null]>;
  ruled: boolean;
  onOpenShot: (shot: BoardShot) => void;
}): React.JSX.Element {
  return <Column snug testID="shot-pairs">
    <Row tight>
      <Column fill style={pairCell}><Typography tiny muted>Pre-fix</Typography></Column>
      <Column fill style={pairCell}><Typography tiny muted>Post-fix</Typography></Column>
    </Row>
    {pairs.map(([before, after], index) => {
      const basis = before ?? after!;
      const label = [basis.route, basis.platform !== "web" ? basis.platform : "", basis.formFactor, basis.scheme, basis.state].filter(Boolean).join(" · ");
      return <Column key={`${pairKey(basis)}-${index}`} tight>
        <Typography tiny muted>{label}</Typography>
        <Row tight alignStart>
          <Column fill style={pairCell}>{before ? <ShotTile shot={before} name={`Pre-fix screenshot of ${label}`} onOpen={onOpenShot} /> : <Alert info description="no pre-fix screenshot kept" />}</Column>
          <Column fill style={pairCell}>{after ? <ShotTile shot={after} name={`Post-fix screenshot of ${label}`} onOpen={onOpenShot} /> : <Alert info description={ruled ? "no post-fix screenshot kept" : "no post-fix screenshot yet"} />}</Column>
        </Row>
      </Column>;
    })}
  </Column>;
}

function IssueCard({
  entry,
  queued,
  tools,
  attemptCap,
  refresh,
  onOpenShot,
}: {
  entry: BoardEntry;
  queued: boolean;
  tools: string[];
  attemptCap: number;
  refresh: () => Promise<void>;
  onOpenShot: (shot: BoardShot) => void;
}): React.JSX.Element {
  const phone = useFormFactor() === "phone";
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const mutate = async (path: string, body: object): Promise<void> => {
    setBusy(true);
    try {
      const response = await post(path, body);
      const payload = await response.json() as { error?: string; queue?: { issue: string }[] };
      if (!response.ok || payload.error) setResult(payload.error ?? `Request failed with status ${response.status}`);
      else if (path === "/api/archive") setResult(entry.status === "archived" ? "Back on the board." : "Filed away.");
      else if (path === "/api/queue/remove") setResult("Removed from the queue.");
      else { const at = payload.queue?.findIndex((item) => item.issue === entry.id) ?? -1; setResult(at === 0 ? "Handed to the selected tool." : `Queued, ${at + 1} in line.`); }
      await refresh();
    } catch (error) { setResult(String(error)); } finally { setBusy(false); }
  };
  const action = entry.status === "done"
    ? <Button small outline testID={`archive-${entry.id}`} onPress={() => void mutate("/api/archive", { issue: entry.id, archived: true })}>Archive</Button>
    : entry.status === "archived"
      ? <Button small outline testID={`restore-${entry.id}`} onPress={() => void mutate("/api/archive", { issue: entry.id, archived: false })}>Restore</Button>
      : entry.status === "blocked" || entry.attempt >= attemptCap
        ? null
        : <Button small primary={queued} outline={!queued} loading={busy} testID={queued ? `unqueue-${entry.id}` : `queue-${entry.id}`} onPress={() => void mutate(queued ? "/api/queue/remove" : "/api/queue", queued ? { issue: entry.id } : { issue: entry.id, tools })}>{queued ? "Queued" : "Queue"}</Button>;
  const shots = entry.before.length || entry.after.length ? [...entry.before, ...entry.after] : entry.shots;
  const pairs: Array<[BoardShot | null, BoardShot | null]> = [];
  const afterBy = new Map(entry.after.map((item) => [pairKey(item), item]));
  const seen = new Set<string>();
  for (const before of entry.before) { pairs.push([before, afterBy.get(pairKey(before)) ?? null]); seen.add(pairKey(before)); }
  for (const after of entry.after) if (!seen.has(pairKey(after))) pairs.push([null, after]);
  const ruled = entry.status === "done" || entry.status === "archived";
  const paths = [entry.dir, ...(entry.before.length || entry.after.length ? [...entry.before, ...entry.after] : entry.shots).map((item) => item.absPath)].filter(Boolean);
  const identity = <Column tight shrink>
    <Row snug alignCenter wrap>
      <Badge status {...(entry.status === "blocked" ? { error: true } : entry.status === "done" ? { success: true } : entry.status === "archived" ? { neutral: true } : { warning: true })}>{statusLabel(entry.status)}</Badge>
      <View testID="issue-id"><Typography mono tiny muted>{entry.id}</Typography></View>
    </Row>
    <CardTitle>{entry.title || entry.label}</CardTitle>
  </Column>;
  const controls = <Row tight>{action}{entry.doc ? <View><Button small link testID="issue-doc" href={issueDocumentHref(entry.id)} hrefAttrs={{ target: "_blank", rel: "noopener" }}>Issue.md</Button></View> : null}</Row>;
  return <View testID="issue-card">
    <Card raised comfortable>
      <CardHeader>{phone ? <Column snug>{identity}{controls}</Column> : <Row between alignStart snug>{identity}{controls}</Row>}</CardHeader>
      <CardContent><Column snug>
        <BadgeGroup snug><Badge secondary>{entry.severity}</Badge><Badge outline>{entry.categoryGloss?.phrase || entry.category}</Badge>{entry.routes.map((route) => <Badge key={route} outline>{route}</Badge>)}{entry.attempt ? <Badge outline>attempt {entry.attempt}</Badge> : null}</BadgeGroup>
        <Typography small muted>{statusExplanation(entry)}</Typography>{entry.lastSeenAt ? <AgeText at={entry.lastSeenAt} /> : null}
        {entry.fix ? <Row snug alignCenter><Typography small>{entry.fix.cleared ? "Fixed in" : "Claimed at"}</Typography>{entry.fix.url ? <Button link small href={entry.fix.url} hrefAttrs={{ target: "_blank", rel: "noreferrer noopener" }}>{entry.fix.short}</Button> : <Typography mono small>{entry.fix.short}</Typography>}<Typography tiny muted>{entry.fix.host ?? "no remote to link to"}</Typography></Row> : null}
        {entry.archived ? <Typography tiny muted>Archive reason: {entry.archived.reason} · {entry.archived.at.slice(0, 19).replace("T", " ")}</Typography> : null}
        <Divider soft>What is wrong</Divider>
        {entry.defects.map((defect, index) => <Column key={`${defect.attribute}-${index}`} tight><Typography h3>{defect.title}</Typography><Typography tiny mono muted>rule {entry.category}/{defect.attribute}</Typography>{defect.problem && defect.problem !== defect.title ? defect.problem.trim().split(/\n{2,}/).map((part, partIndex) => <Typography key={partIndex} small muted>{part}</Typography>) : null}</Column>)}
        {entry.acceptance.length ? <><Divider soft>Acceptance · {entry.acceptance.filter((criterion) => criterion.verdict === "met").length} of {entry.acceptance.length} met</Divider>{entry.acceptance.map((criterion) => <Row key={criterion.id} snug alignStart><Badge status {...(criterion.verdict === "met" ? { success: true } : criterion.verdict === "unmet" ? { error: true } : { neutral: true })}>{criterion.verdict === "unmet" ? "not met" : criterion.verdict ?? "not ruled"}</Badge><Column tight shrink><Typography small>{criterion.text}</Typography>{criterion.note && criterion.verdict !== "met" ? <Typography tiny muted>{criterion.note}</Typography> : null}</Column></Row>)}</> : null}
        {pairs.length ? <><Divider soft>Pre and post fix</Divider><ShotPairs pairs={pairs} ruled={ruled} onOpenShot={onOpenShot} /></> : shots.length ? <><Divider soft>These views as they are now</Divider><ScrollView horizontal><Row snug>{shots.map((shot, index) => <ShotTile key={`${shot.path}-${index}`} shot={shot} onOpen={onOpenShot} />)}</Row></ScrollView></> : null}
        {entry.judgeNote ? <Alert warning title="Judge" description={entry.judgeNote} /> : null}
        {result ? <Alert {...(result.includes("failed") || result.startsWith("Error") ? { destructive: true } : { success: true })} description={result} /> : null}
        {entry.timeline.length ? <Column tight data-feed={entry.id}><Divider soft>Record</Divider>{entry.timeline.map((step, index) => <Typography key={`${step.at}-${index}`} tiny muted>{step.at.slice(0, 19).replace("T", " ")} · {step.text}</Typography>)}</Column> : null}
        {paths.length ? <Column tight><Divider soft>On disk</Divider>{paths.map((path, index) => <Typography key={`${path}-${index}`} tiny mono muted>{path}</Typography>)}</Column> : null}
      </Column></CardContent>
    </Card>
  </View>;
}

export function IssuesBoard({
  entries,
  filter,
  queued,
  tools,
  attemptCap,
  refresh,
  onOpenShot,
}: {
  entries: BoardEntry[];
  filter: Filter | null;
  queued: Set<string>;
  tools: string[];
  attemptCap: number;
  refresh: () => Promise<void>;
  onOpenShot: (shot: BoardShot) => void;
}): React.JSX.Element {
  const visible = entries.filter((entry) => issueMatches(entry, filter));
  return <View nativeID="viewIssues"><Column relaxed>
    {filter ? <View nativeID="filterbar"><Alert info testID="filter-bar" title="Filtered" description={`Showing only ${filter.label}`} /></View> : null}
    <Row between alignCenter><Typography h2>Issues</Typography><Typography tiny muted>{visible.length} of {entries.length} on record</Typography></Row>
    <Grid columns={2} minTileWidth={420} relaxed testID="board">{visible.length ? visible.map((entry) => <IssueCard key={entry.id} entry={entry} queued={queued.has(entry.id)} tools={tools} attemptCap={attemptCap} refresh={refresh} onOpenShot={onOpenShot} />) : <Alert info title="Nothing here" description={filter ? `Nothing is ${filter.label}.` : "Nothing found yet. Run lookout check."} />}</Grid>
  </Column></View>;
}
