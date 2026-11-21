import { posix } from 'path'
import { NgZone } from '@angular/core'
import { ConfigService, HTMLFileUpload, NotificationsService } from 'tabby-core'
import { SFTPFile, SFTPPanelComponent } from 'tabby-ssh'
import { SidebarPlusDragOutServer } from './dragOutServer.service'
import { SftpDragOut } from './sftpDragOut'
import { SidebarPlusI18nService } from './i18n'
import { SidebarPlusNoticesService } from './notices.service'
import { readRemoteEntry } from './remoteEntry'
import { humanSize as formatSize } from './sftpFormat'
import { SidebarPlusTransfersService } from './transfersRegistry.service'
import { canMoveSourcesTo, destinationFor, DropPlan, INTERNAL_DRAG_TYPE, isSelfOrDescendant, PlannedUpload, planFromEntries } from './sftpDropModel'

/** The live SFTP transport, borrowed from the one member that publicly exposes its type. */
type SftpSession = SFTPPanelComponent['sftp']

/**
 * What the drop controller needs from the browser component: its live session,
 * listing and selection, plus the two inherited helpers that read the server.
 */
export interface SftpDropHost {
    getSftp: () => SftpSession
    getPath: () => string
    getDisplayedFiles: () => SFTPFile[]
    getSelection: () => Set<string>
    getSessionLabel: () => string|null
    isDirectoryEntry: (item: SFTPFile) => boolean
    resolveSymlink: (item: SFTPFile) => Promise<SFTPFile>
    refreshListing: () => Promise<void>
    /** The panel's one yes/no question, in HTML rather than a native dialog. */
    ask: (message: string, confirmLabel: string) => Promise<boolean>
}

/**
 * Dragging out to the OS, dropping files in, and moving rows within the
 * server.
 *
 * All three gestures share one state machine — what is being carried, where it
 * would land, and what has to be cleaned up when the gesture ends — which is
 * why they live together rather than in three controllers. The panel template
 * only binds to the handful of getters and handlers below.
 */
export class SftpDropController {
    ////// DRAG OUT //////
    /**
     * Past either of these, a directory is confirmed before being downloaded.
     * Low on purpose: the cost being guarded against is not disk space but a
     * gesture that appears to do nothing for minutes, with no way to cancel it.
     */
    private static readonly DRAG_OUT_MAX_FILES = 25
    private static readonly DRAG_OUT_MAX_BYTES = 20 * 1024 * 1024

    /**
     * True while the mouse button that started a drag gesture is still down.
     *
     * `onDragStart` calls `preventDefault()`, so there is no HTML drag and
     * therefore no `dragend` to listen for — the button state is the only
     * remaining evidence that the user is still holding the gesture.
     */
    private gestureHeld = false

    /** Whether a directory may leave for the OS at all. Off by default; files are always draggable. */
    private get canDragOutFolders (): boolean {
        return !!this.config.store.sidebarPlus?.sftpDragOutFolders
    }

    /**
     * Full path of the directory whose *next* drag goes to the OS.
     *
     * One gesture cannot serve both purposes. Moving a row needs the HTML drag
     * to run; copying a directory out needs `preventDefault()` and Electron's
     * `startDrag()`, which only accepts a path that already exists on disk — so
     * the two are mutually exclusive, and a file only escapes the choice because
     * a `DownloadURL` rides along with the HTML drag.
     *
     * The gesture is therefore split in two, which is what the copy already did
     * anyway ("prepare, then drag again"): dragging a directory out of the
     * window without dropping it states the intent and starts the download, and
     * the gesture after that is the one that carries it away. Dragging it inside
     * the panel moves it, always.
     */
    private dragOutIntent: string|null = null

    /**
     * Past this long without a `dragover` anywhere in the window, the pointer is
     * taken to be outside it.
     *
     * `dragover` fires at mouse-move rate while the cursor is over the document,
     * and stops the moment it leaves — so the age of the last one is what tells
     * "dropped on the desktop" from "let go inside Tabby". Preferred over
     * counting `dragenter`/`dragleave` pairs, which Chromium already reports
     * unreliably here (see `onDragLeave`).
     */
    private static readonly WINDOW_EXIT_MS = 150

    private windowExitCandidate: SFTPFile|null = null
    private lastPointerInWindow = 0
    private windowExitWatcher: (() => void)|null = null

    ////// WHERE A DROP LANDS //////
    /**
     * Where a drop would land, while one is being dragged over the list. Null
     * when nothing is. The row bearing that path is the one highlighted; when
     * it is the current directory, the body is outlined instead.
     */
    dropTargetPath: string|null = null

    /** Set when the `..` row is the target — the one destination that is not a row of the listing. */
    dropOnUpRow = false

    /**
     * Long enough to outlive a spurious `dragleave`, short enough not to leave a
     * highlight behind. `dragover` fires at mouse-move rate while the pointer is
     * inside, so any delay above a frame or two bridges the gap.
     */
    private static readonly DROP_CLEAR_MS = 120

    private dropClearTimer: ReturnType<typeof setTimeout>|null = null

    ////// MOVING A ROW WITHIN THE SERVER //////
    /**
     * The rows a drag started from, for as long as the gesture lasts — the
     * whole selection when the grabbed row was part of one with more than one
     * entry, just that row otherwise (see `onDragStart()`).
     *
     * Kept here rather than read from the `DataTransfer` because `getData()` is
     * write-only until the drop: during `dragover` the engine exposes the list
     * of types and nothing else, and the target highlight has to be decided on
     * every one of those events. Empty while nothing is being dragged, and
     * empty as well for the gestures that call `preventDefault()` — those have
     * no HTML drag, hence no move to offer and no `dragend` to clean up after.
     *
     * A panel can only ever see its own: the host detaches the whole root node
     * from the document, so only the focused tab's browser is there to receive
     * a drop.
     */
    private internalDragSources: SFTPFile[] = []

    /** Names enumerated up to this many; past it, a count. A modal listing forty files says nothing. */
    private static readonly COLLISIONS_NAMED = 5

    constructor (
        private config: ConfigService,
        private zone: NgZone,
        private notices: SidebarPlusNoticesService,
        private notify: NotificationsService,
        private i18n: SidebarPlusI18nService,
        private registry: SidebarPlusTransfersService,
        private dragServer: SidebarPlusDragOutServer,
        private dragOut: SftpDragOut,
        private host: SftpDropHost,
    ) { }

    /** Stops every document-level watch this gesture installed. */
    dispose (): void {
        this.clearDropTarget()
        this.stopWatchingWindowExit()
        this.internalDragSources = []
    }

    isDragPreparing (item: SFTPFile): boolean {
        return this.dragOut.isPreparing(item.fullPath)
    }

    isDropTarget (item: SFTPFile): boolean {
        return !this.dropOnUpRow && this.dropTargetPath === item.fullPath
    }

    get dropInCurrentDirectory (): boolean {
        return !this.dropOnUpRow && this.dropTargetPath === this.host.getPath()
    }

    /** Dims every row being moved, so the gesture reads as coming from somewhere. */
    isDragSource (item: SFTPFile): boolean {
        return this.internalDragSources.some(f => f.fullPath === item.fullPath)
    }

    /**
     * Native drag towards the OS.
     *
     * `preventDefault()` in every path: the HTML drag is never the one that
     * runs. Either `startDrag()` takes over immediately — the entry is already
     * downloaded — or this gesture only prepares the copy, and the next drag is
     * the one that carries it out. Letting the HTML drag proceed would drag the
     * row's text into whatever accepts it.
     */
    onDragStart (item: SFTPFile, event: DragEvent): void {
        const isDirectory = this.host.isDirectoryEntry(item)

        // A directory that asked to leave on the previous gesture. The copy to
        // the OS takes the *whole* gesture — see `dragOutIntent` — so nothing
        // else is set up here.
        if (isDirectory && this.claimDragOutIntent(item)) {
            event.preventDefault()
            this.copyToOS(item, true)
            return
        }

        // Announced first, and on every gesture that keeps its HTML drag: this
        // is what makes an internal move possible, and it costs nothing when
        // the drop lands outside — Chromium hands custom types to the source
        // window only.
        //
        // The whole selection rides along when the grabbed row is part of one
        // with more than one entry; otherwise only the grabbed row does — this
        // is the one place selection size decides what a drag carries, and it
        // is deliberately read-only here: grabbing a row outside the selection
        // does not change what is selected, only what this one gesture moves.
        // The outbound OS drag below (`DownloadURL`/`startDrag`) stays strictly
        // single-element regardless — pièges #58/#65 — and keeps reading `item`
        // directly, never this set.
        const selection = this.host.getSelection()
        const dragSources = selection.size > 1 && selection.has(item.fullPath)
            ? this.host.getDisplayedFiles().filter(f => selection.has(f.fullPath))
            : [item]
        this.internalDragSources = dragSources
        event.dataTransfer?.setData(INTERNAL_DRAG_TYPE, JSON.stringify(dragSources.map(f => f.fullPath)))

        // The real drag-and-drop path: announce the file and let Chromium claim
        // its content when — and only when — the drop lands. `preventDefault()`
        // is deliberately *not* called here, since the browser's own drag is the
        // one doing the work.
        //
        // Files only: a `DownloadURL` announces exactly one file, so a
        // directory cannot be offered this way and takes the route below.
        if (!isDirectory && this.dragServer.ready && event.dataTransfer) {
            const url = this.dragServer.offer(this.host.getSftp(), item, this.host.getSessionLabel() ?? undefined)
            if (url) {
                // Both, because both are on offer: copy towards the OS, move
                // inside the panel. `effectAllowed` is the gate `dropEffect`
                // has to fit through — leaving it at `copy` would have the
                // engine veto the move rather than merely mislabel it.
                event.dataTransfer.effectAllowed = 'copyMove'
                event.dataTransfer.setData('DownloadURL', `application/octet-stream:${item.name}:${url}`)
                return
            }
        }

        // A directory leaves through a *marker*: an empty file under a unique
        // name, announced in its place. The shell writes it at the drop site,
        // which is what reveals where the drop landed — and the entry is then
        // delivered there by us (see `SidebarPlusDragOutServer.serveMarker`).
        //
        // What this buys over `startDrag()`, beyond knowing the destination: the
        // gesture stays a plain HTML drag, so the internal move keeps working on
        // the same drag and the copy no longer takes a gesture of its own. The
        // two-step shape below is only reached when the server never started.
        if (isDirectory && this.canDragOutFolders && this.dragServer.ready && event.dataTransfer) {
            const marker = this.dragServer.offerMarker(this.host.getSftp(), item, this.host.getSessionLabel() ?? undefined)
            if (marker) {
                event.dataTransfer.effectAllowed = 'copyMove'
                event.dataTransfer.setData('DownloadURL', `application/octet-stream:${marker.markerName}:${marker.url}`)
                return
            }
        }

        // A directory keeps its HTML drag: this gesture is the move's, and
        // `preventDefault()` would take that away. Leaving the window without
        // dropping is what asks for the copy instead, and the *next* gesture is
        // the one that carries it out.
        if (isDirectory) {
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = 'move'
            }
            this.watchForWindowExit(item)
            return
        }

        // A file with no HTTP offer to announce — the drag-out server failed to
        // start. Falls back to the local copy, which needs the whole gesture.
        event.preventDefault()
        // No HTML drag from here on, so there is no internal move to be had
        // either — and no `dragend` coming to clear this.
        this.internalDragSources = []
        this.copyToOS(item, false)
    }

    /**
     * Ends the gesture, dropped or not.
     *
     * `dragend` fires on the source element whatever the outcome, including a
     * drop outside the window and an `Échap` — which is what makes it the one
     * reliable place to forget the source, and the one place from which a
     * directory dragged towards the OS can be recognised at all.
     */
    onDragEnd (event?: DragEvent): void {
        const candidate = this.windowExitCandidate
        const leftWindow = this.wasAimedOutOfWindow(event)
        this.stopWatchingWindowExit()
        this.internalDragSources = []
        this.clearDropTarget()
        if (candidate && leftWindow) {
            this.askedToLeave(candidate)
        }
    }

    onDragOver (event: DragEvent): void {
        if (!this.host.getSftp()) {
            return
        }
        const internal = this.carriesInternalPath(event)
        if (!internal && !this.carriesFiles(event)) {
            return
        }
        const aimed = this.aimFrom(event.target as HTMLElement)
        // A move that cannot happen shows nothing and accepts nothing: without
        // `preventDefault()` the drop never fires, which is exactly the answer
        // for a directory aimed at itself or a row already where it would land.
        if (internal && !this.canMoveTo(aimed)) {
            this.clearDropTarget()
            if (event.dataTransfer) {
                event.dataTransfer.dropEffect = 'none'
            }
            return
        }
        // Without this the drop event never fires, and the cursor keeps
        // Chromium's default "move" glyph for something that copies.
        event.preventDefault()
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = internal ? 'move' : 'copy'
        }
        if (this.dropClearTimer) {
            clearTimeout(this.dropClearTimer)
            this.dropClearTimer = null
        }
        this.dropOnUpRow = aimed === 'up'
        this.dropTargetPath = aimed === 'up'
            ? posix.dirname(this.host.getPath())
            : aimed?.fullPath ?? this.host.getPath()
    }

    /**
     * `dragleave` fires on every crossing between children, so the only useful
     * question is whether the cursor left the panel altogether.
     *
     * The answer is not always reliable: Chromium reports a null
     * `relatedTarget` on some crossings, which reads as "left the panel" for a
     * pointer that never went anywhere. Hence the delay — a `dragover` still to
     * come cancels it, and the highlight stops flickering under a moving cursor.
     */
    onDragLeave (event: DragEvent): void {
        const to = event.relatedTarget as Node|null
        if (to && (event.currentTarget as HTMLElement).contains(to)) {
            return
        }
        if (this.dropClearTimer) {
            clearTimeout(this.dropClearTimer)
        }
        this.dropClearTimer = setTimeout(
            () => this.clearDropTarget(),
            SftpDropController.DROP_CLEAR_MS,
        )
    }

    onDrop (event: DragEvent): void {
        if (!this.host.getSftp()) {
            return
        }
        const internal = this.carriesInternalPath(event)
        if (!internal && !this.carriesFiles(event)) {
            return
        }
        event.preventDefault()
        event.stopPropagation()
        const aimed = this.aimFrom(event.target as HTMLElement)
        const sources = this.internalDragSources
        this.clearDropTarget()
        if (internal) {
            // Read while the event is still being dispatched — `getData()`
            // answers nothing once the handler has returned.
            void this.receiveMove(sources, event.dataTransfer?.getData(INTERNAL_DRAG_TYPE) ?? '', aimed)
            return
        }
        void this.receiveDrop(this.claimEntries(event), aimed)
    }

    /** The copy-to-OS route: hand over the local copy if there is one, otherwise take it and say so. */
    private copyToOS (item: SFTPFile, isDirectory: boolean): void {
        this.gestureHeld = true
        window.addEventListener('mouseup', () => { this.gestureHeld = false }, { once: true })
        if (this.dragOut.startDrag(item)) {
            // The copy was current as far as the listing knows; confirm that
            // against the server now that the synchronous part is over.
            void this.dragOut.revalidate(this.host.getSftp(), item)
            return
        }
        if (this.dragOut.isPreparing(item.fullPath)) {
            return
        }
        void this.prepareDrag(item, isDirectory)
    }

    private async prepareDrag (item: SFTPFile, isDirectory: boolean): Promise<boolean> {
        if (isDirectory && !await this.confirmHeavyDirectory(item)) {
            return false
        }
        await this.dragOut.prepare(this.host.getSftp(), item, isDirectory, () => this.gestureHeld)
        return true
    }

    /** True once, for the directory that asked. Cleared as it is served, so the gesture after is a move again. */
    private claimDragOutIntent (item: SFTPFile): boolean {
        if (this.dragOutIntent !== item.fullPath) {
            return false
        }
        this.dragOutIntent = null
        return true
    }

    private watchForWindowExit (item: SFTPFile): void {
        this.stopWatchingWindowExit()
        this.windowExitCandidate = item
        this.lastPointerInWindow = Date.now()
        this.windowExitWatcher = () => { this.lastPointerInWindow = Date.now() }
        // Capture phase, on the document: this has to see every `dragover` of
        // the window, including those a handler further down stops.
        document.addEventListener('dragover', this.windowExitWatcher, true)
    }

    private stopWatchingWindowExit (): void {
        if (this.windowExitWatcher) {
            document.removeEventListener('dragover', this.windowExitWatcher, true)
            this.windowExitWatcher = null
        }
        this.windowExitCandidate = null
    }

    /**
     * Whether the gesture that just ended was aimed out of the window.
     *
     * Both halves matter: a drop the panel accepted ends with its own
     * `dropEffect`, and a gesture let go anywhere inside Tabby has a fresh
     * `dragover` behind it.
     */
    private wasAimedOutOfWindow (event: DragEvent|undefined): boolean {
        return event?.dataTransfer?.dropEffect === 'none'
            && Date.now() - this.lastPointerInWindow > SftpDropController.WINDOW_EXIT_MS
    }

    /**
     * Asks before pulling a large directory down, and only then.
     *
     * The count itself stops at the thresholds (see `weigh()`), so a small
     * directory costs one quick walk and no question at all.
     */
    private async confirmHeavyDirectory (item: SFTPFile): Promise<boolean> {
        let weight: import('./sftpDragOut').DirectoryWeight
        try {
            weight = await this.dragOut.weigh(
                this.host.getSftp(),
                item.fullPath,
                SftpDropController.DRAG_OUT_MAX_FILES,
                SftpDropController.DRAG_OUT_MAX_BYTES,
            )
        } catch (e) {
            this.notify.error(this.i18n.t('Could not read the contents of {name}', { name: item.name }), String(e))
            return false
        }
        if (!weight.truncated) {
            return true
        }
        return await this.host.ask(
            this.i18n.t(
                '"{name}" contains more than {count} files ({size} at least). Everything will be downloaded before drag-and-drop becomes possible, with no progress and no way to cancel. Continue?',
                { name: item.name, count: weight.files, size: formatSize(weight.bytes) },
            ),
            this.i18n.t('Download'),
        )
    }

    /**
     * A directory was dragged out of the window and let go there.
     *
     * Nothing can have reached the desktop — the HTML drag carried a type the
     * OS ignores — so this is where the copy starts, and the *next* drag on the
     * same row is the one that hands it over. That two-step shape is not new:
     * it is what a directory drag-out has always done, `startDrag()` needing a
     * file that already exists on disk.
     */
    private askedToLeave (item: SFTPFile): void {
        if (!this.config.store.sidebarPlus?.sftpDragOutFolders) {
            // Kept from the gesture this replaced: without it, dragging a
            // directory to the desktop does nothing and says nothing, and the
            // setting that governs it is undiscoverable.
            this.notices.notice(this.i18n.t('Dragging folders out is disabled — enable it in Settings → Better Sidebar'))
            return
        }
        this.dragOutIntent = item.fullPath
        // Cleared on refusal so that the next gesture is a move again: the
        // question `prepareDrag()` may ask is a way out, not a postponement.
        void this.prepareDrag(item, true).then(accepted => {
            if (!accepted && this.dragOutIntent === item.fullPath) {
                this.dragOutIntent = null
            }
        })
    }

    /** Whether this drag is files coming in from the OS. */
    private carriesFiles (event: DragEvent): boolean {
        const types = event.dataTransfer?.types
        return !!types && types.includes('Files') && !types.includes('DownloadURL')
    }

    /** Whether this drag is a row of this very panel, on its way to another directory. */
    private carriesInternalPath (event: DragEvent): boolean {
        return !!event.dataTransfer?.types.includes(INTERNAL_DRAG_TYPE)
    }

    /** Where a drop over this element would land; synchronous, because it runs on every `dragover`. */
    private aimFrom (target: HTMLElement): SFTPFile|'up'|null {
        const row = target.closest('.sftp-row')
        if (!row || row.classList.contains('sftp-header-row')) {
            return null
        }
        if (row.classList.contains('sftp-row-up')) {
            return 'up'
        }
        const itemPath = (row as HTMLElement).dataset.path
        const item = itemPath ? this.host.getDisplayedFiles().find(file => file.fullPath === itemPath) : null
        if (!item || !(this.host.isDirectoryEntry(item) || item.isSymlink)) {
            return null
        }
        return item
    }

    /** Whether the row being dragged could land on what is currently aimed at. */
    private canMoveTo (aimed: SFTPFile|'up'|null): boolean {
        return canMoveSourcesTo(this.internalDragSources, destinationFor(this.host.getPath(), aimed))
    }

    private clearDropTarget (): void {
        if (this.dropClearTimer) {
            clearTimeout(this.dropClearTimer)
            this.dropClearTimer = null
        }
        this.dropTargetPath = null
        this.dropOnUpRow = false
    }

    ////// DROP FROM THE OS //////
    /**
     * Takes hold of what was dropped, synchronously.
     *
     * `dataTransfer.items` is only readable while the event is being
     * dispatched — `webkitGetAsEntry()` answers null once the handler has
     * returned — so the entries have to be claimed here, before the first
     * await. The entries themselves stay valid afterwards; the item list does
     * not.
     */
    private claimEntries (event: DragEvent): FileSystemEntry[] {
        const items = event.dataTransfer?.items
        if (!items) {
            return []
        }
        const entries: FileSystemEntry[] = []
        for (let i = 0; i < items.length; i++) {
            const entry = items[i].webkitGetAsEntry()
            if (entry) {
                entries.push(entry)
            }
        }
        return entries
    }

    private async receiveDrop (entries: FileSystemEntry[], aimed: SFTPFile|'up'|null): Promise<void> {
        if (!entries.length) {
            return
        }
        // Everything below resumes from `readEntries`/`file()` callbacks, which
        // zone.js does not patch: it mutates state and may open a modal, and
        // would otherwise not be painted until something else triggered a cycle
        // (piège #41).
        await this.zone.run(async () => {
            const destination = await this.resolveDestination(aimed)
            let plan: DropPlan
            try {
                plan = await planFromEntries(entries, destination)
            } catch (e) {
                this.notices.error(this.i18n.t('Could not read what was dropped'), String(e))
                return
            }
            if (!plan.files.length && !plan.directories.length) {
                return
            }
            const collisions = await this.findCollisions(plan.files)
            // Nothing has been written at this point — not even a directory —
            // so turning the question down leaves the server exactly as it was.
            if (collisions.length && !await this.confirmOverwrite(collisions, destination)) {
                return
            }
            const failed = await this.runPlan(plan)
            this.reportDrop(plan, failed, destination)
            await this.host.refreshListing()
        })
    }

    /**
     * Turns the aimed row into the directory the files are written under.
     *
     * The symlink case is the one that needed a decision: the row was
     * highlighted on `isSymlink` alone, so the link still has to be followed
     * here. When it does lead to a directory, the destination is the **link's**
     * own path rather than the target's — the server resolves it, and it is the
     * location the user aimed at. `openEntry()` navigates the same way.
     */
    private async resolveDestination (aimed: SFTPFile|'up'|null, intent: 'upload'|'move' = 'upload'): Promise<string> {
        if (aimed === null || aimed === 'up') {
            return destinationFor(this.host.getPath(), aimed)
        }
        if (!aimed.isSymlink) {
            return aimed.fullPath
        }
        const target = await this.host.resolveSymlink(aimed).catch(() => null)
        if (target && this.host.isDirectoryEntry(target)) {
            return aimed.fullPath
        }
        // Said out loud rather than silently retargeted: the row lit up, and
        // nothing is going there. The two outcomes differ — files fall back to
        // the directory on screen, whereas a move to it is no move at all,
        // since that is where the dragged row already lives.
        this.notices.notice(intent === 'move'
            ? this.i18n.t('{name} is not a folder — nothing was moved', { name: aimed.name })
            : this.i18n.t('{name} is not a folder — sending to {path}', { name: aimed.name, path: this.host.getPath() }))
        return this.host.getPath()
    }

    /**
     * Which of the planned files already exist on the server.
     *
     * `SFTPSession.upload()` writes to `<path>.tabby-upload` and renames it
     * over the target, so an existing file is replaced without a word. That was
     * tolerable while a drop could only land in the directory on screen; now
     * that any row can be aimed at, a slip of the cursor is enough.
     *
     * One listing per destination directory rather than one lookup per file:
     * `readRemoteEntry()` reads the parent listing anyway, so asking it file by
     * file would re-read the same directory N times. A directory that does not
     * exist yet simply answers nothing, which is the right answer. And never a
     * `stat()`, which follows links and reports a dangling one as free (piège
     * #50).
     */
    private async findCollisions (files: PlannedUpload[]): Promise<string[]> {
        const byDirectory = new Map<string, PlannedUpload[]>()
        for (const file of files) {
            const parent = posix.dirname(file.remotePath)
            const bucket = byDirectory.get(parent)
            if (bucket) {
                bucket.push(file)
            } else {
                byDirectory.set(parent, [file])
            }
        }
        const collisions: string[] = []
        for (const [directory, bucket] of byDirectory) {
            const entries = await this.host.getSftp().readdir(directory).catch(() => [])
            const existing = new Set(entries.map(entry => entry.name))
            for (const file of bucket) {
                const name = posix.basename(file.remotePath)
                if (existing.has(name)) {
                    collisions.push(name)
                }
            }
        }
        return collisions
    }

    private async confirmOverwrite (collisions: string[], destination: string): Promise<boolean> {
        const named = collisions.slice(0, SftpDropController.COLLISIONS_NAMED)
        const rest = collisions.length - named.length
        const list = rest > 0
            ? this.i18n.t('{names}, and {rest, plural, =1 {# more} other {# more}}', { names: named.join(', '), rest })
            : named.join(', ')
        const message = collisions.length > 1
            ? this.i18n.t(
                '{count} files already exist under {destination} and will be overwritten: {list}. Continue?',
                { count: collisions.length, destination, list },
            )
            : this.i18n.t(
                'A file already exists under {destination} and will be overwritten: {list}. Continue?',
                { destination, list },
            )
        return await this.host.ask(message, this.i18n.t('Overwrite'))
    }

    /**
     * Runs a plan through to the end and answers with the names that failed.
     *
     * Each transfer is built and registered when its turn comes rather than up
     * front. The panel's elapsed time counts from the moment a line is
     * registered, so queueing fifty of them at once would show forty-nine
     * clocks running against 0 % — forty-nine transfers that read as stalled
     * when they have simply not started. The uploads are sequential: one SFTP
     * channel carries them all.
     */
    private async runPlan (plan: DropPlan): Promise<string[]> {
        const sftp = this.host.getSftp()
        for (const directory of plan.directories) {
            // A directory that already exists is the normal case when merging
            // into an existing tree; the native panel ignores the same failure.
            await sftp.mkdir(directory).catch(() => undefined)
        }
        const failed: string[] = []
        for (const planned of plan.files) {
            const transfer = new HTMLFileUpload(planned.file)
            this.registry.track(transfer, false, {
                remotePath: planned.remotePath,
                sessionLabel: this.host.getSessionLabel() ?? undefined,
            })
            try {
                await sftp.upload(planned.remotePath, transfer)
            } catch (e) {
                // The registry only ever learns of a cancellation or a
                // completion: a transfer whose channel died answers false to
                // both, and its line would stay "en cours" for the rest of the
                // session. Reported per file here, and summed up once below —
                // one toast per failure would bury the list under itself when
                // the transport is what died.
                this.registry.markFailed(transfer, String((e as Error)?.message ?? e))
                failed.push(planned.file.name)
            }
        }
        return failed
    }

    private reportDrop (plan: DropPlan, failed: string[], destination: string): void {
        const sent = plan.files.length - failed.length
        const folders = plan.directories.length
        if (sent > 0) {
            this.notices.notice(folders > 0
                ? this.i18n.t(
                    '{sent, plural, =1 {# file} other {# files}} sent to {destination} ({folders, plural, =1 {# folder} other {# folders}})',
                    { sent, destination, folders },
                )
                : this.i18n.t(
                    '{sent, plural, =1 {# file} other {# files}} sent to {destination}',
                    { sent, destination },
                ))
        } else if (folders > 0 && !failed.length) {
            this.notices.notice(this.i18n.t(
                '{folders, plural, =1 {# folder} other {# folders}} created in {destination}',
                { folders, destination },
            ))
        }
        if (failed.length) {
            this.notices.error(
                this.i18n.t(
                    'Could not send {failed, plural, =1 {# file} other {# files}} of {total}',
                    { failed: failed.length, total: plan.files.length },
                ),
                failed.slice(0, SftpDropController.COLLISIONS_NAMED).join(', '),
            )
        }
    }

    ////// MOVING A ROW WITHIN THE SERVER //////
    /**
     * Moves every dragged entry into the aimed directory.
     *
     * `rename()` on a server-side move costs nothing and transfers nothing —
     * within one filesystem it is a directory entry being rewritten. Across two
     * mount points the server refuses outright, which is reported as it comes
     * rather than guessed at beforehand: SFTP has no way to ask where a path is
     * mounted.
     *
     * The announced payload is checked against the remembered rows rather than
     * used on its own: a mismatch means the drag did not come from this
     * panel's own state, and the safe answer to a move whose source is
     * uncertain is not to make it. Compared as sets, not as an ordered pair —
     * `JSON.stringify()` on the sending side and the engine's own string
     * transport give no guarantee the order survives, and membership is all
     * this check is for.
     */
    private async receiveMove (sources: SFTPFile[], announcedPayload: string, aimed: SFTPFile|'up'|null): Promise<void> {
        if (!sources.length) {
            return
        }
        let announcedPaths: unknown
        try {
            announcedPaths = JSON.parse(announcedPayload)
        } catch {
            return
        }
        if (!Array.isArray(announcedPaths) || !announcedPaths.every(p => typeof p === 'string')) {
            return
        }
        const remembered = new Set(sources.map(s => s.fullPath))
        if (announcedPaths.length !== remembered.size || announcedPaths.some(p => !remembered.has(p))) {
            return
        }

        const destination = await this.resolveDestination(aimed, 'move')
        // Every dragged row comes from the same listing, so they share a
        // parent — "already there" is an all-or-nothing question, exactly as
        // `canMoveTo()` already treated it. Re-run against the *resolved*
        // destination: a symlink is judged on its own path while the cursor
        // moves, so this is the first point at which a link leading back into
        // the directory on screen is visible at all.
        if (destination === posix.dirname(sources[0].fullPath)) {
            return
        }

        // Sequential, not parallel, and each entry gets the same per-entry
        // conflict arbitration the single-item move always had: a name clash,
        // a link resolving back into the dragged entry itself (only visible now,
        // against the *resolved* destination), or a rename the server refused
        // skips that one entry and moves on to the rest, rather than aborting
        // entries that were perfectly fine.
        let succeeded = 0
        let firstError: string|null = null
        const selection = this.host.getSelection()
        for (const source of sources) {
            if (isSelfOrDescendant(source.fullPath, destination)) {
                firstError = firstError ?? this.i18n.t('{name} cannot be moved into itself', { name: source.name })
                continue
            }
            const target = posix.join(destination, source.name)
            // Refused rather than overwritten, exactly as `renameEntry()` does:
            // SFTP v3 leaves it to the server to decide what a rename onto an
            // existing name does, and some replace it. Refusing is the one
            // answer that cannot destroy anything.
            if (await readRemoteEntry(this.host.getSftp(), target)) {
                firstError = firstError ?? this.i18n.t('{name} already exists in {destination}', { name: source.name, destination })
                continue
            }
            try {
                await this.host.getSftp().rename(source.fullPath, target)
            } catch (e) {
                firstError = firstError ?? this.i18n.t('Could not move {name}: {error}', { name: source.name, error: String(e) })
                continue
            }
            // The entry has left the directory on screen, so the selection has
            // nothing left to point at — unlike a rename, where it follows.
            succeeded++
            selection.delete(source.fullPath)
        }

        await this.host.refreshListing()

        const failed = sources.length - succeeded
        if (sources.length === 1) {
            // Same wording as before there was a batch to speak of.
            if (succeeded === 1) {
                this.notices.notice(this.i18n.t('{name} moved to {destination}', { name: sources[0].name, destination }))
            } else {
                this.notices.error(
                    this.i18n.t('Could not move {name} to {destination}', { name: sources[0].name, destination }),
                    firstError ?? undefined,
                )
            }
        } else if (failed === 0) {
            this.notices.notice(this.i18n.t('{count} items moved to {destination}', { count: succeeded, destination }))
        } else if (succeeded === 0) {
            this.notices.error(this.i18n.t('No move succeeded'), firstError ?? undefined)
        } else {
            this.notices.error(this.i18n.t('{succeeded} moved, {failed} failed', { succeeded, failed }), firstError ?? undefined)
        }
    }
}
