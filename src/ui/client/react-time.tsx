import React, { useEffect, useState } from "react";
import { Typography } from "@nannier-com/canvas";
import { age, dur } from "./dom.js";

export function useNow(period = 1_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), period);
    return () => window.clearInterval(timer);
  }, [period]);
  return now;
}

export function AgeText({ at }: { at: string }): React.JSX.Element {
  const now = useNow(30_000);
  return <Typography small muted>Seen {age(now - Date.parse(at))}.</Typography>;
}

export function RunClock({ startedAt, endedAt, running, lastEventAt }: { startedAt: string; endedAt: string | null; running: boolean; lastEventAt: string | null }): React.JSX.Element {
  const now = useNow();
  const silent = lastEventAt ? now - Date.parse(lastEventAt) : 0;
  const stalled = running && silent > 10 * 60 * 1_000;
  const elapsed = stalled ? silent : (endedAt && !running ? Date.parse(endedAt) : now) - Date.parse(startedAt);
  return <Typography tiny muted>{stalled ? `nothing for ${dur(elapsed)}` : `${running ? "running" : "ran for"} ${dur(elapsed)}`}</Typography>;
}
