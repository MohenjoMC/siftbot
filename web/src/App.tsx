import { useEffect, useMemo, useRef, useState } from "react"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { GuiOverlay } from "@/components/GuiOverlay"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig
} from "@/components/ui/chart"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Compass,
  Copy,
  Drumstick,
  Footprints,
  HeartPulse,
  LayoutGrid,
  MapPin,
  Pause,
  Play,
  Zap
} from "lucide-react"
import {
  distanceTo,
  formatAge,
  formatClock,
  formatCoordinate,
  formatEta,
  formatNumber,
  routeFraction,
  useProgress
} from "@/lib/progress"
import { useGui } from "@/lib/gui"

const STATUS_TONE: Record<string, string> = {
  walking: "border-primary/50 text-primary",
  arrived: "border-secondary/50 text-secondary",
  eating: "border-primary/50 text-primary",
  stopped: "border-border text-muted-foreground",
  disconnected: "border-destructive/50 text-destructive",
  dead: "border-destructive/50 text-destructive",
  error: "border-destructive/50 text-destructive"
}

const chartConfig = {
  remaining: {
    label: "Remaining",
    color: "var(--chart-1)"
  }
} satisfies ChartConfig

function compact (value: number) {
  if (value >= 10000) return `${Math.round(value / 1000)}k`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return formatNumber(value)
}

function tickTime (time: number, origin: number) {
  const seconds = Math.round((time - origin) / 1000)
  if (seconds < 90) return `${seconds}s`
  return `${Math.round(seconds / 60)}m`
}

export default function App () {
  const [paused, setPaused] = useState(false)
  const [copied, setCopied] = useState(false)
  const { progress, events, error } = useProgress(paused)
  const gui = useGui(paused)
  const [guiOpen, setGuiOpen] = useState(false)
  const lastGuiWindow = useRef<number | null>(null)

  useEffect(() => {
    const id = gui?.window?.id ?? null
    if (id != null && id !== lastGuiWindow.current) setGuiOpen(true)
    lastGuiWindow.current = id
  }, [gui?.window?.id])

  const fraction = routeFraction(progress)
  const chartData = useMemo(() => {
    if (!progress?.trail?.length) return []
    return progress.trail.map((point: { t: number; x: number; z: number }) => ({
      time: point.t,
      remaining: Math.round(distanceTo(point, progress.target))
    }))
  }, [progress])

  const origin = chartData[0]?.time ?? 0
  const stale = progress ? Date.now() - new Date(progress.updatedAt).getTime() > 20000 : false
  const status = progress ? (stale ? "offline" : progress.status) : (error ? "error" : "waiting")
  const updatedLabel = progress ? formatAge(progress.updatedAt) : "—"

  const copyCoordinates = async () => {
    if (!progress) return
    try {
      await navigator.clipboard.writeText(
        `${Math.round(progress.position.x)} ${Math.round(progress.position.y)} ${Math.round(progress.position.z)}`
      )
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // Clipboard can be blocked; the number is visible anyway.
    }
  }

  return (
    <main className="survey-grid min-h-dvh bg-background text-foreground">
      <header className="border-b border-border/70">
        <div className="mx-auto flex max-w-6xl items-baseline justify-between gap-4 px-5 py-4 sm:px-8">
          <div className="flex items-baseline gap-4">
            <span className="font-heading text-xl font-semibold tracking-tight">siftbot</span>
            <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">
              border expedition
            </span>
          </div>
          <div className="flex items-center gap-3 font-mono text-[11px] text-muted-foreground">
            <span className="hidden sm:inline">{progress?.server ?? "no fix"}</span>
            <Button
              variant="outline"
              size="xs"
              className="h-6 gap-1 whitespace-nowrap font-mono text-[11px]"
              onClick={() => setGuiOpen(true)}
            >
              <LayoutGrid className="size-3" strokeWidth={1.5} />
              <span className="hidden sm:inline">GUI</span>
              {gui?.window ? <span className="max-w-28 truncate">{gui.window.title}</span> : null}
            </Button>
            <Badge variant="outline" className={`whitespace-nowrap ${STATUS_TONE[status] ?? STATUS_TONE.stopped}`}>
              {status}
            </Badge>
            <span className="whitespace-nowrap tabular">fix {updatedLabel}</span>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-5 pb-8 pt-10 sm:px-8">
        <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-8">
          <div>
            <div className="flex items-baseline gap-3 font-mono text-[11px] text-muted-foreground">
              <MapPin className="size-3.5" strokeWidth={1.5} />
              <span>{progress?.username ?? "awaiting walker"}</span>
              <span className="text-border">/</span>
              <span>{progress?.corner ? (progress.corner === "custom" ? "custom target" : `${progress.corner.toUpperCase()} corner`) : "no target"}</span>
            </div>
            <h1 className="fix-in mt-2 font-heading text-[clamp(2rem,7vw,5.2rem)] leading-[0.95] font-semibold tracking-[-0.02em] tabular">
              {progress ? (
                <>
                  <span className="text-muted-foreground">x</span>{" "}
                  {formatCoordinate(progress.position.x)}
                  <span className="mx-2 text-border">/</span>
                  <span className="text-muted-foreground">z</span>{" "}
                  {formatCoordinate(progress.position.z)}
                </>
              ) : (
                "— / —"
              )}
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground">
              <span className="tabular">y {progress ? formatNumber(progress.position.y) : "—"}</span>
              <span className="tabular">target {progress ? `${formatCoordinate(progress.target.x)}, ${formatCoordinate(progress.target.z)}` : "—"}</span>
              <Button
                variant="ghost"
                size="xs"
                className="h-6 gap-1 px-1.5 font-mono text-[11px] text-muted-foreground"
                onClick={copyCoordinates}
                disabled={!progress}
              >
                <Copy className="size-3" strokeWidth={1.5} />
                {copied ? "copied" : "copy"}
              </Button>
            </div>
          </div>

          <div className="text-right">
            <div className="font-mono text-[11px] text-muted-foreground">remaining</div>
            <div className="font-heading text-4xl leading-none font-semibold tabular sm:text-5xl">
              {progress ? formatNumber(progress.distance) : "—"}
            </div>
            <div className="mt-2 font-mono text-[11px] text-muted-foreground tabular">
              blocks · eta {progress ? formatEta(progress.etaSeconds) : "—"}
            </div>
          </div>
        </div>

        <div className="mt-10">
          <div className="relative">
            <Progress value={fraction * 100} className="h-1.5 rounded-none">
              <span className="sr-only">Route progress</span>
            </Progress>
            <span
              className="absolute -top-[5px] h-3 w-[2px] bg-primary transition-[left] duration-500"
              style={{ left: `${fraction * 100}%` }}
              aria-hidden
            />
          </div>
          <div className="mt-2 flex justify-between font-mono text-[10px] text-muted-foreground tabular">
            {["0%", "25%", "50%", "75%"].map(value => (
              <span key={value}>{value}</span>
            ))}
            <span>{progress ? (progress.corner === "custom" ? "target" : `corner · ${progress.corner.toUpperCase()}`) : "corner · —"}</span>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl border-t border-border/70">
        <div className="grid grid-cols-1 md:grid-cols-[1.65fr_1fr]">
          <div className="min-w-0 overflow-hidden border-b border-border/70 px-5 py-6 md:border-b-0 md:border-r md:px-8">
            <div className="flex items-baseline justify-between">
              <h2 className="font-heading text-sm font-medium">Distance to corner</h2>
              <span className="font-mono text-[10px] text-muted-foreground">
                {paused ? "paused" : "live · 2s"}
              </span>
            </div>
            {chartData.length > 1 ? (
              <ChartContainer config={chartConfig} className="mt-5 aspect-auto h-[240px] w-full">
                <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="2 5" />
                  <XAxis
                    dataKey="time"
                    tickFormatter={(value: number) => tickTime(value, origin)}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={28}
                    tick={{ fontSize: 10, fontFamily: "Spline Sans Mono" }}
                  />
                  <YAxis
                    width={44}
                    tickFormatter={compact}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 10, fontFamily: "Spline Sans Mono" }}
                    domain={["auto", "auto"]}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        labelFormatter={(value) => tickTime(Number(value), origin)}
                        formatter={(value) => (
                          <span className="font-mono tabular">{formatNumber(Number(value))} blocks left</span>
                        )}
                      />
                    }
                  />
                  <Area
                    dataKey="remaining"
                    type="monotone"
                    stroke="var(--color-remaining)"
                    fill="var(--color-remaining)"
                    fillOpacity={0.16}
                    strokeWidth={1.5}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ChartContainer>
            ) : (
              <div className="mt-5 flex h-[240px] flex-col items-start justify-center gap-2 border border-dashed border-border/70 px-5">
                <p className="font-heading text-sm">No route sampled yet</p>
                <p className="font-mono text-[11px] text-muted-foreground">
                  Start a walk with <span className="text-foreground">.border-walk ne</span> in the console.
                </p>
              </div>
            )}
            <div className="mt-4 flex items-center justify-between font-mono text-[10px] text-muted-foreground tabular">
              <span>{progress ? `${formatNumber(progress.travelled)} travelled` : "0 travelled"}</span>
              <span>{progress?.trail?.length ?? 0} fixes</span>
            </div>
          </div>

          <aside className="min-w-0 px-5 py-6 md:px-8">
            <div className="flex items-baseline justify-between">
              <h2 className="font-heading text-sm font-medium">Condition</h2>
              <span className="font-mono text-[10px] text-muted-foreground tabular">
                {progress ? formatClock(progress.updatedAt) : "—"}
              </span>
            </div>

            <div className="mt-5 space-y-4">
              <div>
                <div className="flex items-baseline justify-between font-mono text-[11px]">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <HeartPulse className="size-3.5" strokeWidth={1.5} /> health
                  </span>
                  <span className="tabular">{progress ? `${formatNumber(progress.health, 1)} / 20` : "—"}</span>
                </div>
                <Progress
                  value={progress ? (progress.health / 20) * 100 : 0}
                  className="mt-2 h-1 rounded-none [&_[data-slot=progress-indicator]]:bg-[var(--chart-4)]"
                />
              </div>

              <div>
                <div className="flex items-baseline justify-between font-mono text-[11px]">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Drumstick className="size-3.5" strokeWidth={1.5} /> food
                  </span>
                  <span className="tabular">
                    {progress ? `${formatNumber(progress.food)} / 20` : "—"}
                    {progress?.eating ? <span className="ml-2 text-primary">eating</span> : null}
                  </span>
                </div>
                <Progress
                  value={progress ? (progress.food / 20) * 100 : 0}
                  className="mt-2 h-1 rounded-none [&_[data-slot=progress-indicator]]:bg-secondary"
                />
              </div>

              <div className="flex items-end justify-between pt-2">
                <div>
                  <div className="font-mono text-[11px] text-muted-foreground">speed</div>
                  <div className="font-heading text-3xl leading-none font-semibold tabular">
                    {progress ? formatNumber(progress.speed, 1) : "—"}
                    <span className="ml-1 font-mono text-[11px] font-normal text-muted-foreground">m/s</span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  {progress?.sprinting ? (
                    <Badge variant="outline" className="border-primary/50 text-primary">
                      <Zap className="mr-1 size-3" strokeWidth={2} /> sprint
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="border-border text-muted-foreground">
                      <Footprints className="mr-1 size-3" strokeWidth={1.5} /> walk
                    </Badge>
                  )}
                  <span className="font-mono text-[10px] text-muted-foreground tabular">
                    {progress ? `${formatNumber(progress.distance / 1000, 1)} km to corner` : "—"}
                  </span>
                </div>
              </div>
            </div>

            <Separator className="my-5" />

            <div className="flex items-baseline justify-between">
              <h2 className="font-heading text-sm font-medium">Log</h2>
              <span className="font-mono text-[10px] text-muted-foreground">session</span>
            </div>
            <ScrollArea className="mt-3 h-44">
              {events.length === 0 ? (
                <p className="font-mono text-[11px] text-muted-foreground">
                  {error ? `No telemetry — ${error}` : "Waiting for the first event."}
                </p>
              ) : (
                <ol className="space-y-2">
                  {events.map((event: { time: number; text: string }, index: number) => (
                    <li key={`${event.time}-${index}`} className="flex gap-3 font-mono text-[11px]">
                      <span className="shrink-0 text-muted-foreground tabular">
                        {formatClock(event.time)}
                      </span>
                      <span className="text-foreground">{event.text}</span>
                    </li>
                  ))}
                </ol>
              )}
            </ScrollArea>

            <div className="mt-5 flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 font-mono text-[11px]"
                onClick={() => setPaused(value => !value)}
              >
                {paused
                  ? <><Play className="size-3" strokeWidth={1.5} /> resume</>
                  : <><Pause className="size-3" strokeWidth={1.5} /> pause</>}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 font-mono text-[11px] text-muted-foreground"
                onClick={() => window.location.reload()}
              >
                reload
              </Button>
            </div>
          </aside>
        </div>
      </section>

      <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 border-t border-border/70 px-5 py-4 font-mono text-[10px] text-muted-foreground sm:px-8">
        <span className="flex items-center gap-1.5">
          <Compass className="size-3" strokeWidth={1.5} />
          {progress ? `${formatNumber(progress.travelled)} blocks walked since ${formatClock(progress.startedAt)}` : "no expedition in progress"}
        </span>
        <span className="tabular">
          {progress ? `target ${formatCoordinate(progress.target.x)}, ${formatCoordinate(progress.target.z)}` : "—"}
        </span>
      </footer>

      <GuiOverlay gui={gui} open={guiOpen} onClose={() => setGuiOpen(false)} />
    </main>
  )
}
