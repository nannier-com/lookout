import React from "react";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, Column, Divider, Grid, Row, Typography, View } from "@nannier-com/canvas";
import type { Learning } from "../../report/learning.js";

function when(at: string | null | undefined): string {
  return at ? `${at.slice(0, 10)} ${at.slice(11, 19)}` : "";
}

export function LearningPanel({ value }: { value: Learning | null }): React.JSX.Element {
  if (!value) return <Alert info title="Loading" description="Reading lookout's learning record." />;
  const running = [value.running.improve ? "amending its own instructions" : "", value.running.heal ? "editing its own source" : ""].filter(Boolean);
  const frozen = value.instructions.frozen;
  const pending = value.instructions.pending;
  const incidents = value.code.incidents.reduce((sum, group) => sum + group.count, 0);
  return <View nativeID="learning"><Column relaxed><Typography h2>Learning</Typography>
    {running.length ? <Alert info title={`lookout is ${running.join(" and ")}`} description="Nothing is kept until it passes its gate." /> : null}
    <Grid columns={2} minTileWidth={360} relaxed>
      <Card raised comfortable><CardHeader><CardTitle>Its instructions</CardTitle></CardHeader><CardContent><Column relaxed>
        <Typography small muted>Every judgement is driven by an instruction file that lookout can amend and verify.</Typography>
        <Column tight testID="learning-skills">{value.instructions.skills.length ? value.instructions.skills.map((skill) => <View key={skill.name} testID="learning-skill"><Card compact flat><CardContent><Column tight><Row between alignStart><Typography h3>{skill.name}</Typography><Badge outline>v{skill.version}</Badge></Row><Typography small>{skill.description}</Typography>{skill.amendmentPath ? <Typography tiny mono muted>Amended here: {skill.amendmentPath}</Typography> : null}{skill.proposalPath ? <Typography tiny mono muted>Proposal waiting: {skill.proposalPath}</Typography> : null}</Column></CardContent></Card></View>) : <Typography small muted>No skills could be read.</Typography>}</Column>
        <Divider soft>Regression gate</Divider>
        {frozen ? <Typography small>Gated by {frozen.cases} frozen screenshot{frozen.cases === 1 ? "" : "s"} carrying {frozen.claims} settled claim{frozen.claims === 1 ? "" : "s"}, frozen {when(frozen.frozenAt)}.</Typography> : <Alert warning title="No frozen gate" description="An amendment can only be saved as a proposal. Run lookout skills freeze to build the set from adjudicated findings." />}
        {pending.total ? <Column tight><Typography small>{pending.total} new signal{pending.total === 1 ? "" : "s"}{pending.lastImproveAt ? ` since the last improve (${when(pending.lastImproveAt)})` : ""}. Threshold {pending.threshold}; the next lookout check learns from them.</Typography><Row snug wrap>{pending.bySkill.map((item) => <Badge key={item.skill} secondary>{item.skill} {item.count}</Badge>)}</Row></Column> : <Typography small muted>Nothing new to learn from{pending.lastImproveAt ? ` since ${when(pending.lastImproveAt)}` : ""}: no refutation, adjudication, or blocked issue has been recorded.</Typography>}
        <Divider soft>History</Divider>
        <Column tight testID="learning-history">{value.instructions.history.length ? value.instructions.history.map((entry, index) => <View key={`${entry.at}-${index}`} testID="learning-entry"><Card compact flat><CardContent><Column tight><Row between alignStart><Row snug><Badge {...(entry.action === "applied" ? { success: true } : entry.action === "rolled-back" ? { error: true } : { neutral: true })}>{entry.action}</Badge><Typography h3>{entry.skill}{entry.version ? ` v${entry.version}` : ""}</Typography></Row><Typography tiny muted>{when(entry.at)}</Typography></Row><Typography small>{entry.summary}</Typography>{entry.violations?.map((violation, violationIndex) => <Typography key={violationIndex} tiny mono muted>{violation.kind} {violation.shotId} · {violation.category}: {violation.why}</Typography>)}{entry.evidence?.length ? <Typography tiny mono muted>From: {entry.evidence.join(" · ")}</Typography> : null}</Column></CardContent></Card></View>) : <Typography small muted>lookout has not changed its instructions in this project yet. Run lookout skills improve once there is settled evidence to learn from.</Typography>}</Column>
      </Column></CardContent></Card>
      <Card raised comfortable><CardHeader><CardTitle>Its own code</CardTitle></CardHeader><CardContent><Column relaxed>
        <Typography small muted>Failures, reverted repair attempts, and fixes that passed every gate. {incidents ? `${incidents} failure${incidents === 1 ? "" : "s"} recorded.` : "The record is clean."}</Typography>
        <Divider soft>Incidents</Divider>
        {value.code.incidents.length ? value.code.incidents.map((incident) => { const action = incident.needsPerson ? "Two heal attempts reverted; this needs a person." : incident.recurred ? "It was healed before and came back; consider lookout self-heal." : incident.count > 2 ? "This is recurring; consider lookout self-heal." : ""; return <Alert key={`${incident.kind}-${incident.message}`} {...(incident.needsPerson || incident.recurred ? { destructive: true } : { warning: true })} title={`${incident.count}× ${incident.kind}`} description={`${incident.message}${incident.verb ? ` · during lookout ${incident.verb}` : ""}${incident.detail ? ` · ${incident.detail}` : ""} · last ${when(incident.latestAt)}${action ? ` · ${action}` : ""}`} />; }) : <Typography small muted>Nothing has gone wrong with lookout itself in this project.</Typography>}
        <Divider soft>Attempts a gate killed</Divider>
        {value.code.attempts.length ? value.code.attempts.map((attempt) => <Card key={attempt.dir} compact flat><CardContent><Column tight><Row between><Badge error>reverted</Badge><Typography tiny muted>{when(attempt.at)}</Typography></Row><Typography small>{attempt.summary ?? "The attempt left no readable report."}</Typography>{attempt.cause ? <Typography tiny muted>{attempt.cause}</Typography> : null}<Row snug wrap>{attempt.failedGates.map((gate) => <Badge key={gate} error>{gate} failed</Badge>)}</Row><Typography tiny mono muted>{attempt.dir}</Typography></Column></CardContent></Card>) : <Typography small muted>No attempt has been reverted.</Typography>}
        <Divider soft>Heals that stuck</Divider>
        {value.code.checkout ? <><Typography tiny mono muted>{value.code.checkout}</Typography>{value.code.commits.length ? value.code.commits.map((commit) => <Card key={commit.sha} compact flat><CardContent><Column tight><Row between><Typography mono small>{commit.sha}</Typography><Typography tiny muted>{when(commit.at)}</Typography></Row><Typography small>{commit.subject}</Typography></Column></CardContent></Card>) : <Typography small muted>lookout has never committed a fix to itself here. It commits and never pushes, so every heal stays one git revert away.</Typography>}</> : <Alert info description="This is an installed copy of lookout, so there is no source here to heal and no repository to revert in." />}
      </Column></CardContent></Card>
    </Grid>
  </Column></View>;
}
