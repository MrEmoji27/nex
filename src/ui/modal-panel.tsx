// Worker B owns this file: shared centered modal panel.
// Built on verified @opentui 0.5.6 APIs only: absolute position + zIndex on <box>
// (LayoutOptions.position / RenderableOptions.zIndex). No dialog component exists.
import type { ReactNode } from "react"
import { colors } from "./theme"

export function ModalPanel(props: {
  title: string
  termWidth: number
  termHeight: number
  width: number
  height: number
  children: ReactNode
}) {
  const { title, termWidth, termHeight, width, height, children } = props
  const left = Math.max(0, Math.floor((termWidth - width) / 2))
  const top = Math.max(0, Math.floor((termHeight - height) / 2))

  return (
    <box
      style={{
        position: "absolute",
        left,
        top,
        width,
        height,
        paddingLeft: 2,
        paddingRight: 2,
        justifyContent: "center",
        flexDirection: "column",
        backgroundColor: colors.surface,
      }}
      border={true}
      borderStyle="rounded"
      borderColor={colors.border}
      title={` ${title} `}
      titleColor={colors.heading}
      zIndex={100}
    >
      {children}
    </box>
  )
}
