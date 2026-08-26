// Voice channel strip (alpha.6 groundwork): one row under the chat panes.
// Motion only where it carries meaning — a speaking ring pulses while the
// pipeline reports real voice activity, and the room segment blips when the
// participant set changes (join/leave). Muted and idle states are static.
// Reduced motion: filled vs hollow glyphs still distinguish speaking/idle.
import type { RoomView } from "../core/contract.ts"
import { colors, truncate } from "./theme"
import { useChangeFlash, useTick } from "./use-tick"
import { spriteFrame } from "./anim"

const SPEAKING_FRAMES = ["◉", "◎", "◉", "○"] as const

export function VoiceStrip(props: { room: RoomView; selfId: string; width: number }) {
  const { room, selfId, width } = props
  const participants = room.voice.participants

  // Pulse ONLY while someone is actually speaking; idle strips cost nothing.
  const anyoneSpeaking = participants.some((p) => p.speaking && !p.muted)
  const tick = useTick(anyoneSpeaking, 380)

  // Membership blip: highlights the room name for a beat on join OR leave.
  const joinBlip = useChangeFlash(participants.length, 800)

  return (
    <box
      style={{
        width,
        height: 1,
        flexDirection: "row",
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: colors.surface,
      }}
    >
      <text fg={joinBlip ? colors.accent : colors.heading}>{`⌂ ${truncate(room.name, 18)} `}</text>
      <text fg={participants.some((p) => p.peerId === selfId) ? colors.success : colors.dim}>
        {participants.some((p) => p.peerId === selfId) ? "VOICE ●" : "voice ─"}
      </text>
      {participants.map((p) => {
        const isSelf = p.peerId === selfId
        // Text channel stays primary: muted ⊘, speaking ◉/◎, idle ○.
        const glyph = p.muted ? "⊘" : p.speaking ? spriteFrame(SPEAKING_FRAMES, tick) : "○"
        const fg = p.muted ? colors.dim : p.speaking ? colors.highlight : colors.fg
        return (
          <text key={p.peerId} fg={fg}>
            {`  ${glyph} ${isSelf ? "you" : truncate(p.name, 12)}`}
          </text>
        )
      })}
    </box>
  )
}
