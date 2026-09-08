import React from "react";
import { alpha, Button, Column, Dialog, Icon, Image, Pressable, Row, Typography, useFormFactor, useTheme, useWindowDimensions, View } from "@nannier-com/canvas";
import type { BoardShot } from "../../report/board-types.js";
import { hintOf, type SvBox } from "./shot-project.js";

export interface OpenShot {
  shot: BoardShot;
  boxes: SvBox[];
  hint: string;
  aspectRatio?: number;
}

export function ShotInspector({ value, onClose, onSelect }: {
  value: OpenShot;
  onClose: () => void;
  onSelect: (hint: string) => void;
}): React.JSX.Element {
  const { tokens } = useTheme();
  const phone = useFormFactor() === "phone";
  const viewport = useWindowDimensions();
  const ratio = value.aspectRatio ?? 16 / 9;
  const maxHeight = viewport.height * (phone ? 0.62 : 0.72);
  const stageWidth = Math.max(1, Math.min(phone ? viewport.width - 48 : viewport.width - 160, 1100, maxHeight * ratio));
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }} overlay wide accessibilityLabel="Screenshot provenance inspector" testID="shot-dialog">
      <View nativeID="shotview"><Column relaxed>
        <Row between alignCenter><Typography h4>{[value.shot.route, value.shot.platform, value.shot.formFactor, value.shot.scheme, value.shot.state].filter(Boolean).join(" · ")}</Typography><Row snug><Button link small href={`/evidence/${encodeURIComponent(value.shot.path)}`} hrefAttrs={{ target: "_blank", rel: "noopener" }}>Open PNG</Button><Button small ghost testID="shot-close" accessibilityLabel="Close the shot inspector" onPress={onClose}>Close</Button></Row></Row>
        <View style={{ position: "relative", width: stageWidth, height: stageWidth / ratio, maxWidth: "100%", alignSelf: "center", overflow: "hidden" }}>
          <Image testID="shot-image" source={{ uri: `/evidence/${encodeURIComponent(value.shot.path)}` }} width="100%" height="100%" contain alt="" />
          {value.boxes.map((box, index) => <Pressable key={index} testID="shot-box" accessibilityLabel={hintOf(box.el)} onPress={() => onSelect(hintOf(box.el))} style={{ position: "absolute", left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%`, borderWidth: 2, borderColor: tokens.primary, backgroundColor: alpha(tokens.primary, 0.12), cursor: "pointer" }} />)}
          <View nativeID="svX"><Button small ghost icon testID="shot-corner-close" accessibilityLabel="Close the shot inspector" onPress={onClose} iconLeft={<Icon x decorative />} /></View>
        </View>
        <View nativeID="svHint"><Typography tiny muted>{value.hint}</Typography></View>
      </Column></View>
  </Dialog>;
}
