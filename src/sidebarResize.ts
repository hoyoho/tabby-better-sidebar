/**
 * Width persistence and the resize gesture for the sidebar.
 *
 * Kept out of `SidebarPlusTreeComponent` so the geometry rules are testable
 * without a DOM and the component only wires mouse events to this state
 * machine. The host element is sized elsewhere; this module never touches it.
 */

/** Bounds of a usable sidebar width, in px. */
export const PANEL_MIN_WIDTH = 200
export const PANEL_MAX_WIDTH = 600
/**
 * Released below this width the sidebar closes entirely (matching Tabby's own
 * sidebar); it can be re-opened from the settings or the hotkey.
 */
export const PANEL_COLLAPSE_DRAG_WIDTH = 30
/**
 * Width used when nothing usable is persisted — a missing key, a hand-edited
 * one, or an empty localStorage slot whose `parseInt()` is NaN. Deliberately
 * inside [PANEL_MIN_WIDTH, PANEL_MAX_WIDTH].
 */
export const DEFAULT_PANEL_WIDTH = 300

export const PANEL_WIDTH_STORAGE_KEY = 'sidebarPlusTreeWidth'

/** The slice of `Storage` this module needs, so tests can pass a plain object. */
export interface WidthStorage {
    getItem: (key: string) => string | null
    setItem: (key: string, value: string) => void
}

/**
 * Clamped to the usable range; `min` is 0 while dragging so the handle can
 * reach the collapse zone. NaN falls back to the default instead of
 * propagating into geometry.
 */
export function clampPanelWidth (width: number, min = PANEL_MIN_WIDTH): number {
    const safe = Number.isFinite(width) ? width : DEFAULT_PANEL_WIDTH
    return Math.min(PANEL_MAX_WIDTH, Math.max(min, safe))
}

/** The one place that reads the persisted width; NaN and absent keys fall back to the default. */
export function readStoredWidth (storage: WidthStorage): number {
    const stored = parseInt(storage.getItem(PANEL_WIDTH_STORAGE_KEY) ?? '', 10)
    return Number.isFinite(stored) ? stored : DEFAULT_PANEL_WIDTH
}

/** Writes only on change, so startup clamping does not rewrite the key on every launch. */
export function writeStoredWidth (storage: WidthStorage, width: number): void {
    const value = width.toString()
    if (storage.getItem(PANEL_WIDTH_STORAGE_KEY) !== value) {
        storage.setItem(PANEL_WIDTH_STORAGE_KEY, value)
    }
}

/** One in-progress resize gesture: where it started and how far the grabber has been previewed. */
interface ResizeDrag {
    startX: number
    startWidth: number
    offset: number
}

export interface SidebarResizeHooks {
    /** Called once per commit, after the width is stored, with the collapse verdict. */
    onCommit: (width: number, collapsed: boolean) => void
    /** Mirrors the gesture onto the app-wide cursor (col-resize while dragging). */
    setCursor: (resizing: boolean) => void
}

/**
 * The resize state machine.
 *
 * While a gesture is active the sidebar width does not change — only
 * `grabberTransform` follows the pointer — and `commit()` folds the preview
 * into `width` once, on release. Writing the width on every mousemove would
 * reflow the terminal under the pointer. The commit is immediate (the host
 * applies the new width and clears the transform in one relayout, with no CSS
 * transition), so the handle lands where the pointer released it.
 */
export class SidebarResizeController {
    width: number
    private drag: ResizeDrag|null = null

    constructor (private storage: WidthStorage, private hooks: SidebarResizeHooks) {
        this.width = readStoredWidth(storage)
    }

    get isResizing (): boolean {
        return this.drag !== null
    }

    /**
     * Translation applied to the grabber during a drag, or null at rest. The
     * sidebar width is untouched mid-drag, so the handle — not the panel — is
     * what follows the pointer.
     */
    get grabberTransform (): string|null {
        const drag = this.drag
        return drag && drag.offset !== 0 ? `translateX(${drag.offset}px)` : null
    }

    /** Repairs and re-persists a stored width; called before the first paint. */
    clampAndPersist (): void {
        this.width = clampPanelWidth(this.width)
        writeStoredWidth(this.storage, this.width)
    }

    start (clientX: number): void {
        // Clamped up front so a stale or NaN committed width cannot poison
        // every position computed during the gesture.
        this.drag = {
            startX: clientX,
            startWidth: clampPanelWidth(this.width),
            offset: 0,
        }
        this.hooks.setCursor(true)
    }

    move (clientX: number): void {
        if (!this.drag) {
            return
        }
        // Tracks the mouse all the way to 0 so the handle can reach the
        // collapse threshold; the min/close decision is deferred to release so
        // the handle never teleports under the cursor. Preview only: the real
        // width is committed in commit(), because writing it here would
        // reflow the terminal on every mousemove.
        const width = clampPanelWidth(this.drag.startWidth + clientX - this.drag.startX, 0)
        this.drag.offset = width - this.drag.startWidth
    }

    /**
     * Drops an in-progress gesture without committing it; used when the
     * component is torn down mid-drag so the app-wide cursor is restored.
     */
    cancel (): void {
        if (!this.drag) {
            return
        }
        this.drag = null
        this.hooks.setCursor(false)
    }

    commit (): void {
        const drag = this.drag
        if (!drag) {
            return
        }
        try {
            // Clamped to [0, max] first so it can be compared against the
            // collapse threshold; assigning through clampPanelWidth() then
            // snaps a value still under PANEL_MIN_WIDTH to the minimum width.
            const width = clampPanelWidth(drag.startWidth + drag.offset, 0)
            this.width = clampPanelWidth(width)
            this.hooks.onCommit(this.width, width < PANEL_COLLAPSE_DRAG_WIDTH)
            writeStoredWidth(this.storage, this.width)
        } finally {
            // Cleanup must run even if the commit hook throws, otherwise the
            // grabber stays offset and the app-wide cursor stays stuck.
            this.drag = null
            this.hooks.setCursor(false)
        }
    }
}
