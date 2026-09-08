import React, { useEffect, useState } from "react";
import { Alert, Button, Column, Divider, Field, Icon, Input, Row, ScrollView, Select, Switch, Typography, View } from "@nannier-com/canvas";
import type { SettingsView } from "../project.js";

const CUSTOM = "__custom__";
const DEFAULT = "__default__";

export function SettingsPanel({ settings, onClose, onApply, onReset }: {
  settings: SettingsView;
  onClose: () => void;
  onApply: (path: string, body?: object) => Promise<void>;
  onReset: () => void;
}): React.JSX.Element {
  const [projectDir, setProjectDir] = useState(settings.projectDir ?? "");
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl ?? "");
  const [models, setModels] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setProjectDir(settings.projectDir ?? "");
    setBaseUrl(settings.baseUrl ?? "");
    setModels(Object.fromEntries(settings.judges.map((judge) => [judge.key, judge.model ?? ""])));
    setCustom(Object.fromEntries(settings.judges.map((judge) => [judge.key, !!judge.model && !judge.models.includes(judge.model)])));
  }, [settings]);
  // Bounded to the drawer that holds it, because the ScrollView inside cannot
  // scroll a box nothing has given a height: it grew to its content instead,
  // the drawer clipped the overflow, and the settings below the fold were
  // simply unreachable. The panel is taller than a short viewport by design --
  // it carries a judge row per AI now -- so this is not a rare case.
  return <View nativeID="settings" style={{ height: "100%" }}><ScrollView><Column relaxed padLoose>
        <Row between alignCenter><Typography h2>Settings</Typography><Button ghost icon accessibilityLabel="Close settings" testID="settings-close" onPress={onClose} iconLeft={<Icon x decorative />} /></Row>
        <Alert {...(settings.configured ? { success: true } : { warning: true })} title={settings.configured ? `Configured for ${settings.project ?? "this project"}` : "No lookout.config.ts here"} description={settings.configPath ?? "Choose a repository above, or type its path. lookout can create a config for a repository that does not have one."} />
        <Field label="Project" helper="Which repository lookout checks."><Row snug stacks><Input block accessibilityLabel="Project directory" value={projectDir} onChangeText={setProjectDir} onSubmitEditing={() => void onApply("/api/project", { dir: projectDir })} testID="set-project" /><Button outline small testID="pick-project" onPress={() => void onApply("/api/pick")}>Choose folder</Button></Row></Field>
        <Field label="Base URL" helper="Overrides where configured targets live."><Row snug stacks><Input block accessibilityLabel="Base URL" value={baseUrl} onChangeText={setBaseUrl} onSubmitEditing={() => void onApply("/api/settings", { baseUrl })} testID="set-url" /><Button outline small testID="save-url" onPress={() => void onApply("/api/settings", { baseUrl })}>Save</Button></Row></Field>
        <Column tight testID="settings-targets">
          {settings.error ? <Alert destructive description={settings.error} /> : !settings.configured ? <Typography small muted>No configured targets until a project is chosen.</Typography> : settings.targets.length ? settings.targets.map((target) => <View key={target.name} testID="settings-target"><Alert {...(target.up ? { success: true } : { warning: true })} title={target.name} description={`${target.url} · ${target.routes} route${target.routes === 1 ? "" : "s"} · ${target.up ? "reachable" : `not responding${target.status ? ` (HTTP ${target.status})` : ""}`}`} /></View>) : <Typography small muted>That config declares no targets.</Typography>}
          {settings.devices.map((device) => <View key={device.line} testID="settings-target"><Alert {...(device.up ? { success: true } : { warning: true })} description={device.line} /></View>)}
        </Column>
        <Row between alignCenter stacks><Column tight shrink><Typography h3>Calls to action</Typography><View nativeID="setNavState"><Typography small muted>{!settings.configured ? "no config here" : settings.navigation ? "On for this project" : "Off"}</Typography></View><Typography small muted>{settings.navigation ? "The next run clicks this project's buttons and links and photographs what they open, destructive controls included. Remembered for this project only." : "Runs photograph each route at rest. Turn this on to click this project's buttons and links, destructive controls included, and judge what they open."}</Typography></Column><Switch disabled={!settings.configured} checked={settings.navigation} onChange={(navigation) => void onApply("/api/settings", { navigation })} testID="nav-toggle">{settings.navigation ? "Turn off" : "Turn on"}</Switch></Row>
        <Divider soft>Judges</Divider>
        {settings.judges.map((judge) => {
          const selected = custom[judge.key] ? CUSTOM : models[judge.key] || DEFAULT;
          const fallback = judge.defaultModel ? `${judge.defaultModel} (lookout's default)` : "choose a model";
          const options = [{ value: DEFAULT, label: fallback }, ...judge.models.map((model) => ({ value: model, label: model })), { value: CUSTOM, label: "Custom..." }];
          return <Column key={judge.key} snug><Typography h3>{judge.label} model</Typography>{judge.models.length ? <Select block value={selected} options={options} testID={`model-menu-${judge.key}`} onSelect={(next) => { setCustom((current) => ({ ...current, [judge.key]: next === CUSTOM })); if (next !== CUSTOM) setModels((current) => ({ ...current, [judge.key]: next === DEFAULT ? "" : next })); }} /> : null}{custom[judge.key] || !judge.models.length ? <Input block accessibilityLabel={`Custom model for ${judge.label}`} value={models[judge.key] ?? ""} placeholder={fallback} onChangeText={(next) => setModels((current) => ({ ...current, [judge.key]: next }))} testID={`model-input-${judge.key}`} /> : null}<Row between alignCenter><View testID="judge-version"><Typography tiny muted>{judge.version ? `${judge.label} ${judge.version}` : `${judge.label} version unavailable`}</Typography></View><Button small primary testID={`save-model-${judge.key}`} onPress={() => void onApply("/api/settings", { judgeModels: { [judge.key]: models[judge.key] ?? "" } })}>Save</Button></Row><Typography small muted>What rules on this project, and what the ledger files each verdict under. {!judge.installed ? `${judge.label} was not found here, so nothing will run until it is installed. ` : ""}{judge.defaultModel ? `Empty means ${judge.defaultModel}, used whenever nobody has chosen.` : `${judge.label} publishes no stable alias, so it cannot judge until a model is chosen.`}</Typography></Column>;
        })}
        <Alert destructive title="Delete everything lookout found" description="This permanently deletes this project's backlog, evidence, issue folders, and fix queue. It does not change the application being checked or its source files." actions={<Button destructive small testID="reset-project" onPress={onReset}>Delete</Button>} />
      </Column></ScrollView></View>;
}
