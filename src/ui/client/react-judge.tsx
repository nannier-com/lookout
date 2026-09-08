import React, { useState } from "react";
import { Alert, Button, Card, CardContent, CardHeader, CardSeparator, CardTitle, Column, Icon, Row, ScrollView, Typography, useTheme, View } from "@nannier-com/canvas";
import type { NarrationFrame } from "../narration.js";
import type { StatusPayload } from "../payload.js";
import { age } from "./dom.js";
import { post } from "./react-state.js";

function queueState(item: StatusPayload["status"]["queue"][number], status: string | undefined, head: boolean): string {
  if (item.failedAt) return item.lastReason ?? "the handoff did not open";
  if (!head) return "waiting its turn";
  if (!item.handedOffAt) return "next up";
  if (status === "verifying") return "lookout is ruling on it now";
  return `handed off ${age(Date.now() - Date.parse(item.handedOffAt))} ago · waiting for lookout to rule`;
}

function QueuePanel({ payload, refresh }: { payload: StatusPayload; refresh: () => Promise<void> }): React.JSX.Element {
  const byId = new Map(payload.status.board.map((entry) => [entry.id, entry]));
  const [result, setResult] = useState<string | null>(null);
  const mutate = async (path: string, issue: string): Promise<void> => {
    try {
      const response = await post(path, { issue });
      const value = await response.json() as { error?: string };
      setResult(value.error ?? (path === "/api/rule" ? "Ruling started." : "Removed from the queue."));
      await refresh();
    } catch (error) { setResult(String(error)); }
  };
  return <Column snug testID="queue-list">{result ? <Alert info description={result} /> : null}{payload.status.queue.map((item, index) => {
    const entry = byId.get(item.issue);
    const head = index === 0;
    const state = queueState(item, entry?.status, head);
    return <View key={item.issue} testID="queue-row" {...({ dataSet: { head: String(head), failed: String(!!item.failedAt) } } as object)}><Card compact flat><CardContent><Row snug alignStart>
      <Column tight grow shrink><Typography tiny mono>{item.issue}</Typography><Typography small>{entry?.title ?? "No longer on the board"}</Typography><Typography tiny muted>{item.tools.length ? `Tool${item.tools.length === 1 ? "" : "s"}: ${item.tools.join(" → ")}` : "No tool recorded"}</Typography><View testID="queue-state"><Typography tiny muted>{state}</Typography></View></Column>
      {head && item.handedOffAt && !item.failedAt ? <Button small outline testID={`rule-${item.issue}`} onPress={() => void mutate("/api/rule", item.issue)}>Rule</Button> : null}
      <View {...({ className: "qx" } as object)}><Button small ghost testID={`remove-${item.issue}`} accessibilityLabel={`Remove issue ${item.issue} from the queue`} onPress={() => void mutate("/api/queue/remove", item.issue)}>Remove</Button></View>
    </Row></CardContent></Card></View>;
  })}</Column>;
}

export function JudgePanel({ payload, lines, shut, phone, onToggle, onClear, refresh }: {
  payload: StatusPayload | null;
  lines: NarrationFrame["lines"];
  shut: boolean;
  phone: boolean;
  onToggle: () => void;
  onClear: () => void;
  refresh: () => Promise<void>;
}): React.JSX.Element {
  const { tokens } = useTheme();
  const grouped = new Map<string, { panel: string; opened: string; lines: NarrationFrame["lines"] }>();
  for (const line of lines) {
    const group = grouped.get(line.call) ?? { panel: line.panel, opened: line.at, lines: [] };
    if (line.kind !== "close") group.lines.push(line);
    grouped.set(line.call, group);
  }
  if (phone) return <></>;
  return <View nativeID="stream" style={{ width: shut ? 64 : 340, minWidth: shut ? 64 : 340, height: "100%", overflow: "hidden", borderLeftWidth: 1, borderLeftColor: tokens.border }} {...({ role: "complementary", "aria-label": "The judge and fix queue" } as object)}><Card flat flush>
    <CardHeader><Row between alignCenter><View nativeID="streamFold"><Button ghost icon testID="judge-fold" accessibilityLabel={shut ? "Show the judge's transcript" : "Collapse the judge's transcript"} onPress={onToggle} iconLeft={<Icon {...(shut ? { chevronLeft: true } : { chevronRight: true })} decorative />} /></View>{shut ? null : <><CardTitle>Judge</CardTitle><Button ghost small testID="judge-clear" onPress={onClear}>Clear</Button></>}</Row></CardHeader>
    {shut ? null : <CardContent><ScrollView testID="stream-log" {...({ tabIndex: 0 } as object)}><Column snug>{grouped.size ? [...grouped.entries()].map(([call, group]) => <Card key={call} compact flat><CardContent><Column tight><Row between alignStart><Typography h3>{group.panel}</Typography><Typography tiny muted>{group.opened.slice(11, 19)}</Typography></Row>{group.lines.map((line, index) => line.kind === "open" ? line.text ? <Typography key={index} tiny muted>{line.text}</Typography> : null : line.kind === "tool" ? <Alert key={index} info title="Tool" description={line.text} /> : <Typography key={index} small>{line.text}</Typography>)}</Column></CardContent></Card>) : <Typography tiny muted>The judge is quiet.</Typography>}</Column></ScrollView><CardSeparator /><Row between alignCenter><Typography h3>Queue</Typography><View nativeID="queueCount"><Typography tiny muted>{payload?.status.queue.length || ""}</Typography></View></Row>{payload?.status.queue.length ? <QueuePanel payload={payload} refresh={refresh} /> : <Typography tiny muted>No issues are waiting.</Typography>}</CardContent>}
  </Card></View>;
}
