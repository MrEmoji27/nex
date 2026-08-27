// Worker B owns this file: bottom input line + status footer.
import { useEffect, useRef } from "react"
import type { InputRenderable, KeyEvent } from "@opentui/core"
import { colors, truncate } from "./theme"

export function InputLine(props: {
  focused: boolean
  width: number
  disabled: boolean
  onSubmit(value: string): void
  onRecallLast(): string | undefined
  /** Receives the handler that pane-focused typing forwards characters to. */
  registerForwardChar?(forward: (ch: string) => void): void
}) {
  const { focused, width, disabled, onSubmit, onRecallLast, registerForwardChar } = props
  const inputRef = useRef<InputRenderable | null>(null)
  const lastSent = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!registerForwardChar) return
    registerForwardChar((ch: string) => {
      const el = inputRef.current
      if (!el) return
      // Blur first: with the input natively focused, a forwarded char would be
      // applied by the renderable itself AND by us (doubled characters).
      el.blur()
      el.value = `${el.value}${ch}`
      el.focus()
    })
  }, [registerForwardChar])

  // Up-arrow recalls the last sent message while the input holds focus.
  useEffect(() => {
    const el = inputRef.current
    if (!el || !focused) return
    const handler = (key: KeyEvent) => {
      if (key.name !== "up" || key.eventType !== "press") return
      const previous = onRecallLast()
      if (previous != null) {
        key.preventDefault()
        el.value = previous
      }
    }
    el.onKeyDown = handler
    return () => {
      el.onKeyDown = undefined
    }
  }, [focused, onRecallLast])

return (
    <box
      style={{
        width,
        height: 3,
        flexDirection: "row",
        paddingLeft: 1,
        paddingRight: 1,
        alignItems: "center",
        backgroundColor: colors.surface,
      }}
      border={true}
      borderStyle="single"
      borderColor={focused ? colors.accent : colors.border}
    >
      <text fg={focused ? colors.highlight : colors.dim}>{"> "}</text>
      <input
        ref={inputRef}
        focused={focused}
        placeholder={
          disabled ? "no one selected — / commands still work (try /find)" : "type a message"
        }
        textColor={colors.fg}
        backgroundColor={undefined}
        style={{ flexGrow: 1 }}
        onSubmit={(value: unknown) => {
          const text = typeof value === "string" ? value : inputRef.current?.value ?? ""
          const trimmed = text.trim()
          // A command is not a message and must never need a conversation.
          // Blocking on `disabled` made the app a dead end on first run: with
          // no contacts yet, /rendezvous — the command that GETS you a contact
          // — was swallowed along with everything else, silently.
          if (!trimmed) return
          if (disabled && !trimmed.startsWith("/")) {
            onSubmit(trimmed)
            if (inputRef.current) inputRef.current.value = ""
            return
          }
          lastSent.current = trimmed
          onSubmit(trimmed)
          if (inputRef.current) inputRef.current.value = ""
        }}
      />
    </box>
  )
}

export function Footer(props: { hint: string; error: string | null; width: number; keys?: string }) {
  const { hint, error, width, keys = "a add · v verify · s settings · esc home · tab focus · ↑ recall" } = props
  // Hint budget accounts for the actual keymap length so the two never collide.
  const hintText = truncate(error ?? hint, Math.max(8, width - keys.length - 5))
  return (
    <box style={{ width, height: 1, flexDirection: "row", paddingLeft: 1, paddingRight: 1 }}>
      <text fg={error ? colors.error : colors.dim}>{hintText}</text>
      <box style={{ flexGrow: 1 }} />
      <text fg={colors.dim}>{truncate(keys, 40)}</text>
    </box>
  )
}
