import type { HistoryRow } from "@/lib/types"

export const ROW_H = 26
const LANE = 14
const NODE_Y = 13
const RADIUS = 5
const X0 = 12
export const MAX_LANES = 24

const x = (col: number) => X0 + Math.min(col, MAX_LANES) * LANE
const lane = (c: number) => `var(--lane-${c})`

export function lanesWidth(maxCol: number) {
  return X0 + Math.min(maxCol, MAX_LANES) * LANE + 10
}

function path([kind, from, to]: [number, number, number, number]) {
  const a = x(from)
  const b = x(to)
  const dir = Math.sign(b - a)
  switch (kind) {
    case 0:
      return `M${a} 0V${ROW_H}`
    case 3:
      return `M${a} ${NODE_Y}V${ROW_H}`
    case 1:
      return a === b ? `M${a} 0V${NODE_Y}` : `M${a} 0V${NODE_Y - RADIUS}Q${a} ${NODE_Y} ${a + dir * RADIUS} ${NODE_Y}H${b}`
    default:
      return a === b ? `M${a} ${NODE_Y}V${ROW_H}` : `M${a} ${NODE_Y}H${b - dir * RADIUS}Q${b} ${NODE_Y} ${b} ${NODE_Y + RADIUS}V${ROW_H}`
  }
}

/** One row of the commit graph: lines passing through, joining and leaving, plus the node. */
export function Lanes({ row, width, isHead, isWorktree, folded }: { row: HistoryRow; width: number; isHead: boolean; isWorktree: boolean; folded?: boolean }) {
  const cx = x(row.col)
  const color = lane(row.color)
  const merge = row.parents.length > 1
  return (
    <svg width={width} height={ROW_H} className="block shrink-0 overflow-visible" aria-hidden>
      {row.segs.map((s, i) => (
        <path
          key={i}
          d={path(s)}
          fill="none"
          stroke={lane(s[3])}
          strokeWidth={s[3] === 0 ? 2 : 1.5}
          strokeDasharray={s[0] === 3 ? "2 3" : isWorktree && s[0] === 2 ? "3 3" : undefined}
        />
      ))}
      {isHead && <circle cx={cx} cy={NODE_Y} r={7} fill="none" stroke={color} strokeOpacity={0.35} strokeWidth={2} />}
      {folded ? (
        // A folded branch: a small stack, its commits behind the tip.
        <>
          <rect x={cx - 2.5} y={NODE_Y - 6.5} width={9} height={9} rx={2} fill={color} fillOpacity={0.35} />
          <rect x={cx - 4.5} y={NODE_Y - 4.5} width={9} height={9} rx={2} fill={color} />
        </>
      ) : isWorktree ? (
        <circle cx={cx} cy={NODE_Y} r={4} fill="var(--background)" stroke={color} strokeWidth={1.5} strokeDasharray="2 2" />
      ) : merge ? (
        <circle cx={cx} cy={NODE_Y} r={4} fill="var(--background)" stroke={color} strokeWidth={2} />
      ) : (
        <circle cx={cx} cy={NODE_Y} r={4} fill={color} />
      )}
    </svg>
  )
}
