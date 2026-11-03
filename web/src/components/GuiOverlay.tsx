import { useEffect, useRef, useState } from "react"
import { X } from "lucide-react"
import { itemIcon, sendGuiAction } from "@/lib/gui"
import type { GuiAction, GuiState } from "@/lib/gui"

type Props = {
  gui: GuiState | null
  open: boolean
  onClose: () => void
}

const INV_COLS = 9

export function GuiOverlay ({ gui, open, onClose }: Props) {
  const menu = gui?.window ?? null
  const [selected, setSelected] = useState(0)
  const [command, setCommand] = useState("/shop")
  const [message, setMessage] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const first = useRef<number | null>(null)

  useEffect(() => {
    if (!menu) {
      setSelected(0)
      return
    }
    if (first.current !== menu.id) {
      first.current = menu.id
      const next = menu.slots.findIndex(Boolean)
      setSelected(next >= 0 ? next : 0)
    }
  }, [menu])

  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose()
        return
      }
      if (!menu) return
      if (event.key === "ArrowLeft") setSelected(index => Math.max(0, index - 1))
      else if (event.key === "ArrowRight") setSelected(index => Math.min(menu.size - 1, index + 1))
      else if (event.key === "ArrowUp") setSelected(index => Math.max(0, index - INV_COLS))
      else if (event.key === "ArrowDown") setSelected(index => Math.min(menu.size - 1, index + INV_COLS))
      else if (event.key === "Enter") void clickSlot(selected)
      else return
      event.preventDefault()
    }
    globalThis.addEventListener("keydown", handler)
    return () => globalThis.removeEventListener("keydown", handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, menu, selected])

  if (!open) return null

  const run = async (action: GuiAction, label: string) => {
    setPending(true)
    try {
      await sendGuiAction(action)
      setMessage(label)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
      globalThis.setTimeout(() => setMessage(null), 2500)
    }
  }

  const clickSlot = (slot: number) => {
    if (!menu) return
    const item = menu.slots[slot]
    if (!item) return
    void run({ action: "click", slot }, `clicked ${item.label}`)
  }

  const hovered = menu && menu.slots[selected]
  const rows = menu ? Math.ceil(menu.size / INV_COLS) : 0
  const online = Boolean(gui?.online) && gui?.updatedAt
    ? Date.now() - new Date(gui.updatedAt).getTime() < 15000
    : false
  const inventoryStart = menu && menu.size > 36 ? menu.size - 36 : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 backdrop-blur-[2px]">
      <div
        className="w-full max-w-[540px] border-4 border-t-[#ffffff] border-l-[#ffffff] border-r-[#555555] border-b-[#555555] bg-[#c6c6c6] shadow-[0_0_0_2px_#000,8px_8px_0_rgba(0,0,0,0.35)]"
        role="dialog"
        aria-label={menu?.title ?? "game menu"}
      >
        <div className="flex items-center justify-between border-b-2 border-b-[#8b8b8b] px-3 py-2">
          <span className="font-pixel text-[13px] text-[#3f3f3f]">
            {menu ? prettyTitle(menu.title) : "No window open"}
          </span>
          <div className="flex items-center gap-3 font-pixel text-[10px] text-[#555]">
            <span>{online ? "live" : "offline"}</span>
            <button
              type="button"
              onClick={onClose}
              className="grid size-6 place-items-center border-2 border-t-white border-l-white border-r-[#555] border-b-[#555] bg-[#c6c6c6] text-[#3f3f3f] hover:bg-[#d6d6d6]"
              aria-label="close overlay"
            >
              <X className="size-3.5" strokeWidth={3} />
            </button>
          </div>
        </div>

        {menu ? (
          <div
            className="mx-auto grid gap-[2px] p-3"
            style={{ gridTemplateColumns: `repeat(${INV_COLS}, 1fr)`, maxWidth: 480 }}
          >
            {Array.from({ length: rows * INV_COLS }, (_, slot) => {
              const item = menu.slots[slot]
              const separator = inventoryStart != null && slot === inventoryStart
              const active = slot === selected
              if (separator) {
                return (
                  <div
                    key={`sep-${slot}`}
                    className="col-span-9 my-1 h-2"
                    aria-hidden
                  />
                )
              }
              return (
                <button
                  key={slot}
                  type="button"
                  onMouseEnter={() => setSelected(slot)}
                  onClick={() => clickSlot(slot)}
                  className={[
                    "relative aspect-square border-2 border-t-[#373737] border-l-[#373737] border-r-[#ffffff] border-b-[#ffffff] bg-[#8b8b8b]",
                    active ? "bg-[#a6a6a6] outline outline-2 outline-white/80" : "",
                    item ? "cursor-pointer hover:bg-[#a6a6a6]" : "cursor-default"
                  ].join(" ")}
                  aria-label={item ? `${item.label} x${item.count}` : `empty slot ${slot}`}
                >
                  {item ? (
                    <>
                      <SlotIcon name={item.name} />
                      {item.count > 1 ? (
                        <span className="absolute bottom-0 right-0.5 font-pixel text-[11px] leading-none text-white [text-shadow:1px_1px_0_#3f3f3f]">
                          {item.count}
                        </span>
                      ) : null}
                    </>
                  ) : null}
                </button>
              )
            })}
          </div>
        ) : (
          <div className="px-6 py-10 text-center">
            <p className="font-pixel text-[12px] text-[#3f3f3f]">No in-game menu is open</p>
            <p className="mt-2 font-mono text-[11px] text-[#555]">
              Run <span className="text-[#3f3f3f]">/shop</span> below, or use the held item.
            </p>
          </div>
        )}

        <div className="border-t-2 border-t-[#8b8b8b] px-3 py-2">
          <div className="mb-2 min-h-6 border-2 border-[#2d0a63] bg-[#100010] px-2 py-1 font-pixel text-[10px] text-[#e0e0e0]">
            {message ?? (hovered
              ? `${hovered.label}${hovered.count > 1 ? ` x${hovered.count}` : ""}`
              : menu
                ? "hover a slot to inspect it"
                : "waiting for a menu")}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <McButton disabled={pending || !online} onClick={() => run({ action: "use" }, "used held item")}>
              Use item
            </McButton>
            <McButton disabled={pending || !menu} onClick={() => run({ action: "close" }, "closed menu")}>
              Close
            </McButton>
            <form
              className="ml-auto flex items-center gap-1"
              onSubmit={event => {
                event.preventDefault()
                void run({ action: "command", command }, `sent ${command}`)
              }}
            >
              <input
                value={command}
                onChange={event => setCommand(event.target.value)}
                className="w-28 border-2 border-t-[#373737] border-l-[#373737] border-r-[#ffffff] border-b-[#ffffff] bg-[#8b8b8b] px-1 py-0.5 font-pixel text-[10px] text-[#1f1f1f] outline-none placeholder:text-[#5a5a5a]"
                placeholder="/shop"
                aria-label="server command"
              />
              <McButton type="submit" disabled={pending || !online}>Send</McButton>
            </form>
          </div>

          <p className="mt-2 font-mono text-[10px] text-[#555]">
            arrows select · enter clicks · esc closes overlay · clicks go to the bot
          </p>
        </div>
      </div>
    </div>
  )
}

function prettyTitle (title: string) {
  const known: Record<string, string> = {
    "minecraft:generic_9x1": "Chest",
    "minecraft:generic_9x2": "Chest",
    "minecraft:generic_9x3": "Chest",
    "minecraft:generic_9x4": "Large chest",
    "minecraft:generic_9x5": "Large chest",
    "minecraft:generic_9x6": "Large chest",
    "minecraft:generic_3x3": "Dispenser"
  }
  if (known[title]) return known[title]
  return title
    .replace(/^minecraft:/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, letter => letter.toUpperCase())
}

function McButton ({ children, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      {...props}
      type={props.type ?? "button"}
      className="border-2 border-t-[#ffffff] border-l-[#ffffff] border-r-[#555555] border-b-[#555555] bg-[#c6c6c6] px-2.5 py-1 font-pixel text-[10px] text-[#3f3f3f] hover:bg-[#d6d6d6] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  )
}

function SlotIcon ({ name }: { name: string }) {
  const [failed, setFailed] = useState(false)
  const src = itemIcon(name)
  if (failed || !src) {
    return (
      <span className="absolute inset-0 grid place-items-center font-pixel text-[9px] text-[#d0d0d0]">
        {name.slice(0, 2)}
      </span>
    )
  }
  return (
    <img
      src={src}
      alt={name}
      onError={() => setFailed(true)}
      className="absolute inset-0 m-auto size-8 [image-rendering:pixelated]"
      draggable={false}
    />
  )
}
