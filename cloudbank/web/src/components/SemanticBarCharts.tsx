import { formatGBPFromPence } from '../util/currency'

export interface MerchantBarDatum {
  name: string
  valuePence: number
}

interface HorizontalMerchantBarChartProps {
  data: MerchantBarDatum[]
  ariaLabel: string
}

const BAR_PRIMARY = '#0a4d35'
const BAR_ACCENT = '#8a6318'
const BAR_TRACK = '#eceae3'
const GRID_STROKE = '#e5e3dc'
const TEXT_INK = '#141413'
const TEXT_MUTED = '#63615b'

function truncateLabel(label: string, maxChars: number = 18): string {
  if (label.length <= maxChars) return label
  return `${label.slice(0, maxChars - 1)}…`
}

export function HorizontalMerchantBarChart({
  data,
  ariaLabel,
}: HorizontalMerchantBarChartProps) {
  if (data.length === 0) return null

  const maxValue = Math.max(1, ...data.map((d) => d.valuePence))
  const rowHeight = 28
  const topPad = 6
  const bottomPad = 6
  const viewWidth = 360
  const labelWidth = 122
  const barLeft = labelWidth + 8
  const barMaxWidth = viewWidth - barLeft - 8
  const viewHeight = Math.max(88, topPad + bottomPad + data.length * rowHeight)

  const detailedSummary = `${ariaLabel}: ${data
    .map((d) => `${d.name} ${formatGBPFromPence(d.valuePence)}`)
    .join(', ')}`

  return (
    <svg
      role="img"
      aria-label={detailedSummary}
      viewBox={`0 0 ${viewWidth} ${viewHeight}`}
      className="w-full h-auto block select-none"
    >
      {data.map((item, idx) => {
        const yCenter = topPad + idx * rowHeight + rowHeight / 2
        const barHeight = 14
        const barY = yCenter - barHeight / 2
        const fillWidth =
          item.valuePence > 0
            ? Math.max(4, Math.round((item.valuePence / maxValue) * barMaxWidth))
            : 0
        const fill = idx === 0 ? BAR_PRIMARY : BAR_ACCENT

        return (
          <g key={item.name}>
            <text
              aria-hidden="true"
              x={labelWidth}
              y={yCenter + 4}
              textAnchor="end"
              fill={TEXT_INK}
              fontSize="11"
              fontWeight={idx === 0 ? '600' : '500'}
            >
              {truncateLabel(item.name)}
            </text>
            <rect
              x={barLeft}
              y={barY}
              width={barMaxWidth}
              height={barHeight}
              rx={3}
              fill={BAR_TRACK}
            />
            {fillWidth > 0 && (
              <rect
                data-bar-merchant={item.name}
                x={barLeft}
                y={barY}
                width={fillWidth}
                height={barHeight}
                rx={3}
                fill={fill}
              />
            )}
          </g>
        )
      })}
    </svg>
  )
}

export interface MonthlyBarDatum {
  shortLabel: string
  monthName: string
  valuePence: number
}

interface MonthlyComparisonBarChartProps {
  data: MonthlyBarDatum[]
  ariaLabel: string
}

function niceWholePoundCeiling(maxPence: number): number {
  const maxPounds = Math.max(10, Math.ceil(maxPence / 100))
  const magnitude = Math.pow(10, Math.max(1, Math.floor(Math.log10(maxPounds))))
  const normalized = maxPounds / magnitude
  const step = normalized <= 1.5 ? 1.5 : normalized <= 2 ? 2 : normalized <= 3 ? 3 : normalized <= 5 ? 5 : 10
  return Math.ceil(step * magnitude)
}

export function MonthlyComparisonBarChart({
  data,
  ariaLabel,
}: MonthlyComparisonBarChartProps) {
  if (data.length === 0) return null

  const maxPence = Math.max(0, ...data.map((d) => d.valuePence))
  const topPounds = niceWholePoundCeiling(maxPence)
  const topPence = topPounds * 100
  const midPounds = Math.round(topPounds / 2)

  const viewWidth = 360
  const viewHeight = 188
  const plotLeft = 48
  const plotRight = viewWidth - 12
  const plotTop = 14
  const plotBottom = 154
  const plotWidth = plotRight - plotLeft
  const plotHeight = plotBottom - plotTop

  const slotWidth = plotWidth / data.length
  const barWidth = Math.min(56, Math.max(24, Math.floor(slotWidth * 0.54)))

  const detailedSummary = `${ariaLabel}: ${data
    .map((d) => `${d.monthName} ${formatGBPFromPence(d.valuePence)}`)
    .join(', ')}`

  const ticks = [
    { pounds: topPounds, y: plotTop },
    { pounds: midPounds, y: plotTop + plotHeight / 2 },
    { pounds: 0, y: plotBottom },
  ]

  return (
    <svg
      role="img"
      aria-label={detailedSummary}
      viewBox={`0 0 ${viewWidth} ${viewHeight}`}
      className="w-full h-48 block select-none"
    >
      {ticks.map((t) => (
        <g key={t.pounds}>
          <line
            x1={plotLeft}
            x2={plotRight}
            y1={t.y}
            y2={t.y}
            stroke={GRID_STROKE}
            strokeWidth={1}
          />
          <text
            aria-hidden="true"
            x={plotLeft - 8}
            y={t.y + 3.5}
            textAnchor="end"
            fill={TEXT_MUTED}
            fontSize="10"
          >
            £{t.pounds}
          </text>
        </g>
      ))}

      {data.map((item, idx) => {
        const slotCenter = plotLeft + idx * slotWidth + slotWidth / 2
        const rawHeight = topPence > 0 ? (item.valuePence / topPence) * plotHeight : 0
        const barHeight = item.valuePence > 0 ? Math.max(4, Math.round(rawHeight)) : 0
        const barX = slotCenter - barWidth / 2
        const barY = plotBottom - barHeight
        const isCurrentMonth = idx === data.length - 1
        const fill = isCurrentMonth ? BAR_ACCENT : BAR_PRIMARY

        return (
          <g key={item.shortLabel}>
            {barHeight > 0 && (
              <rect
                data-bar-month={item.shortLabel}
                x={barX}
                y={barY}
                width={barWidth}
                height={barHeight}
                rx={4}
                fill={fill}
              />
            )}
            <text
              aria-hidden="true"
              x={slotCenter}
              y={plotBottom + 20}
              textAnchor="middle"
              fill={TEXT_INK}
              fontSize="12"
              fontWeight={isCurrentMonth ? '600' : '500'}
            >
              {item.shortLabel}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
