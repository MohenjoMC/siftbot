# shadcn/ui dashboard on Vite + React + Tailwind v4 — research findings

Researched 2026-11-03 against primary sources only (ui.shadcn.com, tailwindcss.com, vite.dev, react.dev, npm registry). Every command below was executed end-to-end in a throwaway directory (`/tmp`), including `npm run build`, `vite dev`, `shadcn init`, `shadcn add`, and the Node file server; the generated files quoted here are the actual output.

Scope: `web/` inside this repo — a Vite + React + TS SPA that polls `GET /progress` every 2 s and renders cards, progress bars, a scrollable event log and one area chart.

---

## 1. Versions (2026-11-03)

Confirmed with `npm view <pkg> version`, which is authoritative over the website:

| Package | `latest` | Notes |
| --- | --- | --- |
| `vite` | **8.3.5** | engines: `node ^20.19.0 \|\| >=22.12.0` |
| `create-vite` | 9.3.3 | scaffolds React 19 + TS 7 template |
| `@vitejs/plugin-react` | 6.2.1 | template pins `^6.1.4` |
| `tailwindcss` | **4.3.4** | `v3-lts` tag = 3.4.19, don't use it here |
| `@tailwindcss/vite` | **4.3.4** | must match `tailwindcss` major/minor |
| `react` / `react-dom` | **19.3.1** | template pins `^19.3.1` |
| `typescript` | **7.0.2** | TS 7 removed `baseUrl` — see Pitfalls #1 |
| `shadcn` (CLI) | **4.23.0** | v4 is a different CLI/registry shape than the v3-era docs |
| `recharts` | 3.10.1 | `shadcn add chart` installs `recharts@3.8.0` (see §5) |
| `@types/node` | 26.6.6 | template already pins `^24.19.2`; that is enough |
| `cn` | 0.5.2 | replaces `clsx` + `tailwind-merge` in shadcn v4 |
| `radix-ui` | 1.8.1 | unified package; no more `@radix-ui/react-*` |
| `lucide-react` | 1.67.0 | installed by `init` (preset "nova") |

Sources: `npm view vite version` etc.; registry pages <https://www.npmjs.com/package/vite>, <https://www.npmjs.com/package/tailwindcss>, <https://www.npmjs.com/package/shadcn>.

> **Heads-up:** shadcn v4 changed the component style names and added a required `shadcn` **runtime** dependency (see Config). Older tutorials that say `style: "new-york"`, `clsx`/`tailwind-merge`, or `@radix-ui/react-*` are out of date.

---

## 2. Scaffolding `web/` non-interactively

```bash
cd /home/home/.t3/projects/siftbot
npm create vite@latest web -- --template react-ts --no-interactive --no-immediate
cd web
npm install
npm install tailwindcss @tailwindcss/vite
```

* `create-vite` accepts a target directory and scaffolds **into an existing empty directory** (verified). If the directory has any file, it refuses/asks — use `--overwrite` only if you mean it (`npx create-vite@latest --help`).
* Prompts are avoided by passing `--template react-ts` **and** `--no-interactive`; `--no-immediate` stops it from auto-installing and starting `vite dev`. (`--eslint` / `--no-eslint` switches the linter; the template now defaults to **oxlint**, not ESLint.)
* The `--` after `npm create vite@latest` is required so npm forwards flags to `create-vite`.
* Generated scripts: `dev: vite`, `build: tsc -b && vite build`, `preview: vite preview`, `lint: oxlint`.

Refs: <https://vite.dev/guide/#scaffolding-your-first-vite-project>, <https://vite.dev/guide/cli>.

---

## 3. Tailwind v4 with Vite

Two files only. **No `tailwind.config.js` is needed** — v4 configures via CSS (`@theme`) and auto-detects source files; `components.json` requires `tailwind.config` to be left empty for v4 (<https://ui.shadcn.com/docs/components-json#tailwindconfig>).

`vite.config.ts`:

```ts
import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
})
```

`src/index.css` must start with:

```css
@import "tailwindcss";
```

Refs: <https://tailwindcss.com/docs/installation/using-vite> (steps 2–4: install `tailwindcss @tailwindcss/vite`, add `tailwindcss()` to `plugins`, `@import "tailwindcss";`), <https://tailwindcss.com/docs/theme> (theme lives in CSS via `@theme`).

`@types/node` is required for `node:path` in the config; the Vite 8 template already ships it (`tsconfig.node.json` has `"types": ["node"]`), so no extra install.

---

## 4. shadcn init for an existing Vite project

### Non-interactive command

```bash
npx shadcn@latest init -b radix -p nova -y --no-monorepo --no-rtl --no-pointer
```

What each flag suppresses (all confirmed by running the CLI):

| Prompt | Flag |
| --- | --- |
| Which component library: `base` (Base UI), `radix`, `aria` (React Aria) | `-b radix` |
| Which preset: Nova / Vega / Maia / Lyra / Mira / Luma / Sera / Rhea / Custom | `-p nova` (Nova = Lucide icons + Geist font) |
| Monorepo? | `--no-monorepo` |
| RTL support? | `--no-rtl` |
| Pointer cursor for buttons? | `--no-pointer` |
| "components.json already exists, overwrite?" | delete `components.json` or add `-f` |

`-y` is already the default for `init`. Without `-p` the run stalls on the preset picker even when every other flag is passed.

### What it writes

```
✔ Writing components.json.
✔ Installing dependencies.
✔ Created 1 file: src/lib/utils.ts
✔ Updating src/index.css
```

Dependencies it adds (actual `package.json` diff):

```
dependencies:  shadcn  tw-animate-css  cn  class-variance-authority
               radix-ui  lucide-react  @fontsource-variable/geist
               tailwindcss  @tailwindcss/vite
```

`tailwindcss` and `@tailwindcss/vite` land in `dependencies`, not `devDependencies` — harmless for a static build, but expect it.

`src/lib/utils.ts` becomes:

```ts
export { cn } from "cn"
```

Note this is **not** the old `clsx` + `twMerge` helper, and generated components import `{ cn } from "cn"` directly, not from `@/lib/utils`. Keep `src/lib/utils.ts` anyway — the alias `@/lib/utils` is part of `components.json`.

### `components.json`

It does **not** need to be hand-written if you run `init`; the docs describe it as optional and only required by the CLI (<https://ui.shadcn.com/docs/components-json>). The file generated for this exact stack:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "radix-nova",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/index.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "rtl": false,
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "menuColor": "default",
  "menuAccent": "subtle",
  "registries": {}
}
```

Key Vite-specific values: `"config": ""` (Tailwind v4), `"css": "src/index.css"`, `"rsc": false`, and the `@/*` aliases. `style`/`baseColor`/`cssVariables` are **locked after init** (docs: "cannot be changed after initialization"); switch with `npx shadcn@latest migrate base-color --to zinc --yes` instead of editing by hand.

`style` is `<base>-<preset>`: `-b radix -p nova` → `radix-nova`, `-b base -p nova` → `base-nova` (this repo's existing `web/` is `base-nova`, i.e. Base UI primitives via `@base-ui/react`), `-b aria` → `aria-nova` (React Aria). Pick once; the primitive library is what the generated `ui/*.tsx` import from. Everything below uses `radix`; with `base` the component APIs are nearly identical but the dependency is `@base-ui/react` instead of `radix-ui`.

If you do write it by hand, `npx shadcn@latest add …` will still place files correctly as long as `tsconfig.json` has the `@/*` paths (verified: with paths, files go to `src/components/ui/…`; without them the CLI writes literal `@/components/ui/…` paths that then fail to resolve).

### Run the CLI from `web/`

`init`/`add` resolve everything relative to the current directory (or `-c <dir>`).

Refs: <https://ui.shadcn.com/docs/installation/vite#existing-project>, <https://ui.shadcn.com/docs/cli#init>.

---

## 5. Components

```bash
npx shadcn@latest add button card badge progress separator scroll-area tooltip chart -y
```

Output: 8 files in `src/components/ui/`, one shared dependency install. Exports (from the generated sources):

| File | Exports | Primitive it pulls (`-b radix`) |
| --- | --- | --- |
| `button.tsx` | `Button`, `buttonVariants` | `radix-ui` (`Slot`) |
| `card.tsx` | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter` | none |
| `badge.tsx` | `Badge`, `badgeVariants` | none (`Slot` for `asChild`) |
| `progress.tsx` | `Progress` | `radix-ui` (`Progress`) |
| `separator.tsx` | `Separator` | `radix-ui` (`Separator`) |
| `scroll-area.tsx` | `ScrollArea`, `ScrollBar` | `radix-ui` (`ScrollArea`) |
| `tooltip.tsx` | `Tooltip`, `TooltipTrigger`, `TooltipContent`, `TooltipProvider` | `radix-ui` (`Tooltip`) |
| `chart.tsx` | `ChartContainer`, `ChartStyle`, `ChartTooltip`, `ChartTooltipContent`, `ChartLegend`, `ChartLegendContent`, `type ChartConfig` | `recharts` |

With `-b base` (this repo's `base-nova`), the same files exist with the same names, importing from `@base-ui/react` instead of `radix-ui`; exports above are unchanged (verified against `web/src/components/ui/*.tsx` in this repo).

Dependency notes:

* `chart` installs **`recharts` automatically** — no separate `npm i recharts` required. The registry pins `recharts@^3.8.0` (resolved to 3.8.0 in the test install, while `latest` is 3.10.1). Bump only if you need a newer fix: `npm install recharts@latest`.
* **No individual `@radix-ui/react-*` packages.** shadcn v4 uses the single `radix-ui` package (already installed by `init`), so `add` usually installs nothing new except `recharts`.
* Tooltip requires wrapping the app once: `<TooltipProvider>` (the CLI prints this reminder). Put it in `main.tsx` around `<App />`.
* Button variants: `default | outline | secondary | ghost | destructive | link`; sizes: `default | xs | sm | lg | icon | icon-xs | icon-sm | icon-lg`. Badge variants: `default | secondary | destructive | outline | ghost | link`.
* `npx shadcn@latest add --dry-run` previews files/deps, `--diff` shows patches, `--view` prints contents — useful before touching a working tree.

Refs: <https://ui.shadcn.com/docs/cli#add>, <https://ui.shadcn.com/docs/components/chart>.

---

## 6. Chart usage (recharts)

`ChartContainer` needs a `config` and an explicit height (`h-[220px]`, `min-h-*`, or `aspect-*`) so `ResponsiveContainer` can measure on first render — the docs call this out explicitly (<https://ui.shadcn.com/docs/components/chart#updating-to-recharts-v3>).

Each config key becomes a CSS custom property `--color-<key>` injected by `ChartStyle`; reference it as `fill="var(--color-distance)"`. Color values may be `var(--chart-N)`, hex, `hsl()` or `oklch()`; with recharts v3 never wrap tokens in `hsl(...)`.

```tsx
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"

const chartConfig = {
  distance: { label: "Distance to corner", color: "var(--chart-1)" },
} satisfies ChartConfig

export function DistanceChart({ data }: { data: { t: number; distance: number }[] }) {
  return (
    <ChartContainer config={chartConfig} className="h-[220px] w-full">
      <AreaChart accessibilityLayer data={data}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="t" tickLine={false} axisLine={false}
               tickFormatter={(v: number) => `${Math.round(v)}s`} />
        <YAxis width={40} tickLine={false} axisLine={false} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Area
          dataKey="distance"
          type="monotone"
          fill="var(--color-distance)"
          fillOpacity={0.2}
          stroke="var(--color-distance)"
          strokeWidth={2}
        />
      </AreaChart>
    </ChartContainer>
  )
}
```

Expected CSS variables: `--chart-1` … `--chart-5` in both `:root` and `.dark` (supplied by `init`; see §7). `ChartStyle` reads `config[key].color` or `config[key].theme.{light,dark}` and emits `--color-<key>` scoped to the chart's `[data-chart=…]` element.

The `import { type ChartConfig }` form matters: the Vite template enables `verbatimModuleSyntax`, so type-only imports must be marked.

Ref: <https://ui.shadcn.com/docs/components/chart>, theming section <https://ui.shadcn.com/docs/components/chart#theming>.

---

## 7. Theming

### How the tokens work

* Tokens are plain CSS variables on `:root` and `.dark`; Tailwind utilities are created by mapping them in `@theme inline` (`--color-background: var(--background)` → `bg-background`). Using `inline` is required when a theme variable references another variable — otherwise the var resolves at the definition site and silently falls back (<https://tailwindcss.com/docs/theme#referencing-other-variables>).
* Values are `oklch()` by default. Any CSS color works (`hex`, `hsl()`, `oklch()`); oklch is preferred because it gives perceptually even lightness steps and `color-mix()`-friendly alpha. Nothing in shadcn parses the format.
* Semantic pairs: `background`/`foreground`, `card`/`card-foreground`, `primary`/`primary-foreground`, `muted`/`muted-foreground`, `border`, `ring`, `chart-1..5`, plus `--radius` driving `--radius-sm…4xl` (<https://ui.shadcn.com/docs/theming#theme-tokens>).

### Custom palette

Add or override tokens under `:root` and `.dark`, then expose them in `@theme inline` — exactly the "Adding New Tokens" recipe in the docs:

```css
:root {
  --background: oklch(0.99 0.005 240);
  --foreground: oklch(0.18 0.02 240);
  --primary: oklch(0.55 0.15 155);          /* minecraft-grass green */
  --primary-foreground: oklch(0.99 0.01 155);
  --warning: oklch(0.84 0.16 84);
  --warning-foreground: oklch(0.28 0.07 46);
  --chart-1: oklch(0.65 0.16 155);
  --chart-2: oklch(0.62 0.14 220);
  --radius: 0.5rem;
}

.dark {
  --background: oklch(0.16 0.01 240);
  --foreground: oklch(0.96 0.005 240);
  --primary: oklch(0.72 0.16 155);
  --primary-foreground: oklch(0.18 0.02 155);
  --warning: oklch(0.41 0.11 46);
  --warning-foreground: oklch(0.99 0.02 95);
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-warning: var(--warning);
  --color-warning-foreground: var(--warning-foreground);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  /* keep the rest of the generated block: card, popover, muted, accent,
     destructive, border, input, ring, chart-3..5, sidebar-*, radius-* */
}
```

Then `bg-primary`, `text-warning-foreground`, `fill-chart-1` all exist. Dark mode is a `.dark` override, activated by toggling the class on `<html>` (<https://ui.shadcn.com/docs/dark-mode>).

### Second font family for tabular numerals

Two independent pieces:

1. `font-variant-numeric` — `tabular-nums` is a built-in utility; it makes digits equal-width so a 2 s polling readout doesn't jitter (<https://tailwindcss.com/docs/font-variant-numeric>).
2. A mono face, mapped through the `--font-*` namespace, which is what creates the `font-mono` / `font-<name>` utilities (<https://tailwindcss.com/docs/theme#theme-variable-namespaces>).

Verified working (built, `.font-mono` compiled to the new stack, woff2 chunks emitted):

```bash
npm install @fontsource-variable/geist-mono
```

```css
@import "@fontsource-variable/geist";       /* already added by init */
@import "@fontsource-variable/geist-mono";

@theme inline {
  --font-sans: 'Geist Variable', sans-serif;
  --font-mono: 'Geist Mono Variable', ui-monospace, monospace;
}
```

```tsx
<span className="font-mono tabular-nums">{data.speed.toFixed(2)}</span>
```

All `@import`s must stay at the top of the file, before `@theme`/`:root` — CSS drops late imports and Tailwind warns.

### Canonical `src/index.css` after init

Abridged only where marked; everything else is verbatim CLI output:

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";
@import "@fontsource-variable/geist";

@custom-variant dark (&:is(.dark *));

@theme inline {
  --font-heading: var(--font-sans);
  --font-sans: 'Geist Variable', sans-serif;
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --color-chart-5: var(--chart-5);
  /* sidebar-* color mappings omitted here; keep them if you use Sidebar */
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
  --radius-2xl: calc(var(--radius) * 1.8);
  --radius-3xl: calc(var(--radius) * 2.2);
  --radius-4xl: calc(var(--radius) * 2.6);
}

:root {
  --radius: 0.625rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
  --chart-1: oklch(0.87 0 0);
  --chart-2: oklch(0.556 0 0);
  --chart-3: oklch(0.439 0 0);
  --chart-4: oklch(0.371 0 0);
  --chart-5: oklch(0.269 0 0);
}

.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.205 0 0);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.205 0 0);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.922 0 0);
  --primary-foreground: oklch(0.205 0 0);
  --secondary: oklch(0.269 0 0);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.269 0 0);
  --muted-foreground: oklch(0.708 0 0);
  --accent: oklch(0.269 0 0);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(1 0 0 / 10%);
  --input: oklch(1 0 0 / 15%);
  --ring: oklch(0.556 0 0);
  --chart-1: oklch(0.87 0 0);
  --chart-2: oklch(0.556 0 0);
  --chart-3: oklch(0.439 0 0);
  --chart-4: oklch(0.371 0 0);
  --chart-5: oklch(0.269 0 0);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
  html {
    @apply font-sans;
  }
}
```

(`shadcn/tailwind.css` ships the `data-open:`/`data-closed:`/`data-checked:` style custom variants, `no-scrollbar`/`scroll-fade` utilities and accordion keyframes; `npx shadcn@latest eject` inlines it and drops the `shadcn` dependency. Ref: <https://ui.shadcn.com/docs/cli#eject>.)

---

## 8. Serving `dist/` + `/progress`

`vite preview` is explicitly **not** for production/serving: "Locally preview the production build. Do not use this as a production server as it's not designed for it." (<https://vite.dev/guide/cli#vite-preview>). It also can't serve `/progress` — it only serves the build dir, so you'd need a proxy or CORS.

For a local dashboard the cleanest option is one small Node server that serves `dist/` **and** the JSON route on the same origin (no CORS, no proxy, no framework). `node:http` + `node:fs/promises` only; `dist/` is Vite's default output (`<root>/index.html` entry, `dist` outDir — <https://vite.dev/guide/build>).

`web/server.mjs` (verified against a real `npm run build`: `/` → 200 html, `/progress` → 200 json, `/some/deep/route` → 200 html, `/assets/nope.js` → 404):

```js
import { createServer } from "node:http"
import { readFile, stat } from "node:fs/promises"
import { extname, join, normalize, sep } from "node:path"
import { fileURLToPath } from "node:url"

const DIST = fileURLToPath(new URL("./dist/", import.meta.url))
const PORT = Number(process.env.PORT ?? 4173)

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
}

async function readProgress() {
  // Replace with your bot's real state: JSON file, in-memory snapshot, etc.
  return { bot: "siftbot-1", x: 0, z: 0, distanceToCorner: 0, speed: 0,
           etaSeconds: 0, health: 20, food: 20, events: [], history: [] }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? "/", "http://localhost")

  if (pathname === "/progress") {
    try {
      res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" })
      res.end(JSON.stringify(await readProgress()))
    } catch (err) {
      res.writeHead(500, { "content-type": MIME[".json"] })
      res.end(JSON.stringify({ error: String(err) }))
    }
    return
  }

  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\]|\.\.[/\\])+/, "")
  let file = join(DIST, rel)
  if (!file.startsWith(DIST.endsWith(sep) ? DIST : DIST + sep)) {
    res.writeHead(403).end("Forbidden")
    return
  }

  try {
    const info = await stat(file)
    if (info.isDirectory()) file = join(file, "index.html")
  } catch {
    // Missing asset (has an extension) is a real 404; anything else is an SPA route.
    if (extname(file)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found")
      return
    }
    file = join(DIST, "index.html")
  }

  try {
    const body = await readFile(file)
    const isHtml = file.endsWith("index.html")
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      // Vite hashes asset filenames; HTML must not be cached or stale chunk refs break.
      "cache-control": isHtml ? "no-store" : "public, max-age=31536000, immutable",
    })
    res.end(body)
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    res.end("Not found")
  }
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`dashboard on http://127.0.0.1:${PORT}`)
})
```

Why these details:

* **SPA fallback** only for extension-less paths; returning `index.html` for a missing `.js` turns a build error into a confusing MIME error in the console.
* **MIME types**: browsers refuse `text/html` for module scripts (`Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of "text/html"`), and woff2 must be `font/woff2`.
* **`no-store` on HTML / immutable on hashed assets** matches Vite's content-hashed filenames and avoids the stale-chunk failure Vite documents (<https://vite.dev/guide/build#load-error-handling>).
* `vite preview` is still fine for a quick "does the prod bundle boot" check before publishing; just don't wire the bot's data through it.

---

## 9. Polling every 2 s

React 19 guidance that actually applies here:

* Fetching-in-an-Effect is legitimate (it's synchronization with an external system), but the effect **must clean up** — the docs' canonical fix is an `ignore` flag in the cleanup so a stale response can't overwrite a newer one (<https://react.dev/learn/you-might-not-need-an-effect#fetching-data>). With `setInterval` you additionally must `clearInterval`.
* If the data lives outside React and several components read it, `useSyncExternalStore` is the recommended tool; `getSnapshot` must return a **cached, immutable** value or you hit "The result of getSnapshot should be cached" (<https://react.dev/reference/react/useSyncExternalStore>).

Minimal store (verified to compile and build with the chart above):

```ts
// src/lib/progress.ts
import * as React from "react"

export type Progress = {
  bot: string
  x: number; z: number
  distanceToCorner: number
  speed: number; etaSeconds: number
  health: number; food: number
  events: { at: number; text: string }[]
  history: { t: number; distance: number; speed: number }[]
}

export type ProgressState = { data: Progress | null; error: string | null }

const EMPTY: ProgressState = { data: null, error: null }
let snapshot: ProgressState = EMPTY
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

function emit() { for (const l of listeners) l() }

async function tick() {
  try {
    const res = await fetch("/progress", { headers: { accept: "application/json" } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    snapshot = { data: (await res.json()) as Progress, error: null }
  } catch (err) {
    // keep the last good data on screen, surface the failure separately
    snapshot = { data: snapshot.data, error: err instanceof Error ? err.message : String(err) }
  }
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) {
    void tick()
    timer = setInterval(() => void tick(), 2000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) { clearInterval(timer); timer = null }
  }
}

const getSnapshot = () => snapshot

export function useProgress() {
  return React.useSyncExternalStore(subscribe, getSnapshot, () => EMPTY)
}
```

Two behaviours worth keeping: poll starts on first subscriber and stops on last unsubscribe (StrictMode's double mount just subscribes/unsubscribes harmlessly), and `getSnapshot` returns the same object until a tick replaces it.

If you prefer the plain hook, the same logic works with `useEffect(() => { let ignore = false; … return () => { ignore = true; clearInterval(id) } }, [])` — `useSyncExternalStore` mainly buys you one shared timer across cards instead of one per component.

---

## 10. Pitfalls

1. **`baseUrl` no longer exists in TypeScript 7.** The shadcn Vite docs still tell you to add `"baseUrl": "."`; with `typescript@7.0.2` that fails `npm run build` with
   `error TS5102: Option 'baseUrl' has been removed. Please remove it from your configuration.`
   Use `paths` alone — in TS 7 they resolve relative to the tsconfig file that declares them:

   ```json
   { "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }
   ```

   Put it in **both** `tsconfig.json` (so the CLI/editor resolve `@/`) and `tsconfig.app.json` (so `tsc -b` type-checks the app). Verified: `npm run build` passes with this and fails with `baseUrl`.

2. **Alias must exist in three places or nothing resolves.** `components.json` `aliases` (CLI placement), `tsconfig.json`/`tsconfig.app.json` `paths` (TS + editor), `vite.config.ts` `resolve.alias` (bundler). Missing the tsconfig entry doesn't error in `shadcn add` — it silently writes to a literal `@/components/ui/...` path (observed). Missing the Vite alias fails at import time.

3. **`@types/node` must be installed for `path` in `vite.config.ts`.** The Vite 8 template includes it and sets `"types": ["node"]` in `tsconfig.node.json`; if you scaffolded the config yourself, `npm i -D @types/node`.

4. **shadcn v4 needs `shadcn` as a runtime dependency.** `src/index.css` contains `@import "shadcn/tailwind.css"`, which resolves to `node_modules/shadcn/dist/tailwind.css`. Removing `shadcn` from `dependencies` breaks the CSS build (`npx shadcn@latest eject` is the supported way to inline it).

5. **CSS `@import` order is load-bearing.** All `@import`s must precede any other rule. `@import "tailwindcss"` first, then `tw-animate-css`, `shadcn/tailwind.css`, and fonts — appending a font `@import` at the bottom of `index.css` silently does nothing.

6. **`@theme` vs `:root`.** `@theme inline` must be top-level (not nested in a selector or media query) and is only for tokens that should generate utilities. Raw custom variables (`--warning`) go in `:root`/`.dark` and are exposed separately. Defining both in the wrong place is the usual "my class has no styles" cause (<https://tailwindcss.com/docs/theme>).

7. **`cn` is not `clsx`+`tailwind-merge` anymore.** Generated components import `{ cn } from "cn"`. If you paste older shadcn snippets that import `@/lib/utils` expecting `twMerge`, they still work only because `src/lib/utils.ts` re-exports `cn`; hand-rolling the old implementation adds two dead dependencies and different merge semantics.

8. **React 19 peer ranges are fine — but check `recharts`.** `radix-ui@1.8.1` and `recharts@3.8.0` both declare React 19 support; a fresh install produced no peer warnings (only UNMET OPTIONAL platform binaries for `@tailwindcss/oxide`, which is normal). If you upgrade `recharts`, stay on v3 — v2 required `hsl(var(--chart-1))` wrappers and breaks the v4 tokens.

9. **Bundle size warning is expected.** With `chart` + recharts the main chunk was ~622 kB (190 kB gzip) and Vite 8 (Rolldown) printed "Some chunks are larger than 500 kB". Either accept it for a local dashboard, raise `build.chunkSizeWarningLimit`, or lazy-load the chart with `React.lazy`.

10. **`verbatimModuleSyntax` + `erasableSyntaxOnly`** (both on in the Vite template) mean `import { type ChartConfig }` / `import type { … }` — a plain `import { ChartConfig }` fails `tsc -b` even though Vite would bundle it.

11. **Tailwind must actually see the files.** v4 auto-detects sources from the project root, so keep the app under `web/` and don't build with a root outside it; there's no `content` array to forget, but dynamically constructed class names (`bg-${color}-500`) still won't be generated.

12. **`npx shadcn@latest init` is not fully non-interactive on its own** — `-y` only skips confirmation, not the preset picker (it hung on "Which preset would you like to use?" in the test run). Always pass `-b` and `-p`, plus `--no-monorepo --no-rtl --no-pointer`.

---

## Sources

* shadcn — Vite install: <https://ui.shadcn.com/docs/installation/vite>
* shadcn — CLI (`init`/`add` flags): <https://ui.shadcn.com/docs/cli>
* shadcn — `components.json`: <https://ui.shadcn.com/docs/components-json>
* shadcn — theming/tokens: <https://ui.shadcn.com/docs/theming>
* shadcn — chart: <https://ui.shadcn.com/docs/components/chart>
* shadcn — dark mode: <https://ui.shadcn.com/docs/dark-mode>
* Tailwind — Vite install: <https://tailwindcss.com/docs/installation/using-vite>
* Tailwind — theme variables / `@theme inline`: <https://tailwindcss.com/docs/theme>
* Tailwind — `tabular-nums`: <https://tailwindcss.com/docs/font-variant-numeric>
* Vite — CLI (incl. `vite preview` warning): <https://vite.dev/guide/cli>
* Vite — build output: <https://vite.dev/guide/build>
* React — `useSyncExternalStore`: <https://react.dev/reference/react/useSyncExternalStore>
* React — fetching in Effects + cleanup: <https://react.dev/learn/you-might-not-need-an-effect#fetching-data>
* npm registry versions: `npm view <pkg> version` on 2026-11-03 (<https://www.npmjs.com/package/vite>, <https://www.npmjs.com/package/tailwindcss>, <https://www.npmjs.com/package/shadcn>, <https://www.npmjs.com/package/typescript>, <https://www.npmjs.com/package/recharts>)
