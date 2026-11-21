import './sftpBrowser.component.scss'
import * as fs from 'fs'
import { basename, posix } from 'path'
import { AfterViewChecked, Component, ElementRef, EventEmitter, HostListener, Inject, NgZone, OnDestroy, Output, ViewChild } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { ConfigService, LocaleService, NotificationsService, PlatformService, PromptModalComponent, TranslateService } from 'tabby-core'
import { SFTPContextMenuItemProvider, SFTPFile, SFTPPanelComponent } from 'tabby-ssh'
import { SidebarPlusEditorService } from '../editorLauncher.service'
import { electronRemote } from '../electronRemote'
import { EmptyFileUpload } from '../sftpLocalTransfer'
import { SftpDragOut } from '../sftpDragOut'
import { OpenMode, SftpRemoteEditor } from '../sftpRemoteEdit'
import { SidebarPlusDragOutServer } from '../dragOutServer.service'
import { freeLocalName } from '../localNames'
import { SidebarPlusNoticesService } from '../notices.service'
import { SidebarPlusI18nService } from '../i18n'
import { readRemoteEntry, resolveRemoteSymlink } from '../remoteEntry'
import { downloadRemoteTree } from '../remoteTree'
import { SidebarPlusTempFilesService } from '../tempFiles.service'
import { SftpTransfers } from '../transfers'
import { SidebarPlusTransfersService } from '../transfersRegistry.service'
import { clampInViewport } from '../viewport'
import { extension as formatExtension, fullDate as formatFullDate, humanSize as formatSize, isHidden as formatIsHidden, longMode as formatLongMode, octalMode as formatOctalMode, sameEntry as sameSftpEntry, shortDate as formatShortDate } from '../sftpFormat'
import { reuseListingRows, sortAndFilterListing } from '../sftpListing'
import { overwritePrompt } from '../sftpMessages'
import { SftpDropController } from '../sftpDrop'
import { SftpFileOperationsController } from '../sftpFileOps'
import { ConfirmModalComponent } from './confirmModal.component'


/**
 * One rendered row, computed once instead of on every change detection pass.
 *
 * The template used to call a method for the icon, the tooltip and each cell.
 * Angular re-runs those on *every* cycle, and Tabby runs a great many of them —
 * a live terminal alone is enough. On a directory with a few thousand entries
 * that meant thousands of date and size formatting calls per cycle, which is
 * what made a full `/tmp` unusable rather than merely slow.
 */
export interface SftpRow {
    item: SFTPFile
    icon: string
    tooltip: string
    hidden: boolean
    /** Formatted values, positionally aligned with `visibleColumns`. */
    cells: string[]
}

/** An optional column of the file list. The name column is not one of these — it is always shown. */
export interface SftpColumn {
    id: string
    /** Header caption. Kept short: the whole list lives in a ~300px sidebar. */
    label: string
    /** Full wording for the column chooser, where there is room for it. */
    description: string
    /** A fixed grid track — fixed is the point, it is what keeps the columns aligned at any width. */
    width: string
    /**
     * Right-aligned. Deliberately only the size: `4.2 MB` / `856 B` / `1.1 GB`
     * left-aligned in a 60px track makes magnitudes unscannable, which is the
     * one thing a size column is for. SFTP+ left-aligns everything; this is
     * the single place this panel departs from it.
     */
    numeric?: boolean
}

/**
 * Tabby's own SFTP panel with this plugin's presentation.
 *
 * Subclassing rather than reimplementing: every behaviour worth having —
 * navigation, open, upload/download, the context menu, the filter, transfer
 * plumbing — is inherited untouched from `SFTPPanelComponent`, and only the
 * template is ours. What forced the split is that the native template renders
 * the date through the `tabbyDate` pipe, the permissions through
 * `getModeString()`, and carries no `title` anywhere: all of that is template
 * content, unreachable from a stylesheet, and patching the DOM instead would
 * just be overwritten on the next change detection pass.
 *
 * The native row also puts an `*ngIf` on its size cell, so directories have
 * one fewer child than files and the columns cannot line up. Ours is a CSS
 * grid with fixed column tracks, so a directory simply leaves its size track
 * empty and everything stays aligned at any width.
 */
@Component({
    selector: 'sidebar-plus-sftp-browser',
    template: require('./sftpBrowser.component.pug'),
})
export class SidebarPlusSftpBrowserComponent extends SFTPPanelComponent implements OnDestroy, AfterViewChecked {
    /**
     * Everything `SFTPFile` can actually answer — it carries only name,
     * fullPath, isDirectory, isSymlink, mode, size and modified, so there is
     * no owner/group column to offer however much an SFTP client usually has
     * one.
     *
     * Translated through explicit calls to `i18n.t()`, each with its own
     * string written out in full, rather than the template's `| translate`
     * pipe: this list is consumed as a bound property
     * (`*ngFor='let column of availableColumns'`), never a literal, and the
     * i18n lint script's extraction is lexical — it only recognises a
     * literal immediately piped to `translate` in a `.pug` file or passed
     * directly to `i18n.t()` in a `.ts` file (piping `column.label` came
     * back CLÉ MORTE while building this lot). A getter rather than a field
     * computed once keeps a live language change picked up on the next read
     * — this is six entries, read only while the rarely-open display menu is
     * on screen, nothing like the row list `visibleColumns`/`rows` below
     * guard against.
     */
    get availableColumns (): SftpColumn[] {
        return [
            { id: 'size', label: this.i18n.t('Size'), description: this.i18n.t('File size'), width: '3.9rem', numeric: true },
            { id: 'date', label: this.i18n.t('Date'), description: this.i18n.t('Date modified'), width: '4.5rem' },
            { id: 'mode', label: this.i18n.t('Perm.'), description: this.i18n.t('Permissions in octal (755)'), width: '2.1rem' },
            { id: 'modeLong', label: this.i18n.t('Rights'), description: this.i18n.t('Permissions in long form (drwxr-xr-x)'), width: '5.2rem' },
            { id: 'type', label: this.i18n.t('Type'), description: this.i18n.t('Item type'), width: '4rem' },
            { id: 'ext', label: this.i18n.t('Ext.'), description: this.i18n.t('File extension'), width: '2.6rem' },
        ]
    }

    /**
     * The display toggles that sit under the column list in the header menu,
     * modelled on SFTP+'s. Each is a `sidebarPlus` key, declared in the
     * ConfigProvider defaults (piège #16). Same translation reasoning as
     * `availableColumns` above.
     */
    get displayToggles (): { key: string, label: string }[] {
        return [
            { key: 'sftpFoldersFirst', label: this.i18n.t('Folders first') },
            { key: 'sftpShowHidden', label: this.i18n.t('Show hidden files') },
            { key: 'sftpColumnBorders', label: this.i18n.t('Column borders') },
            { key: 'sftpZebra', label: this.i18n.t('Alternating rows') },
        ]
    }

    /**
     * trackBy for the header-menu `*ngFor`s. The two getters above return
     * fresh object identities on every access, so identity-based diffing
     * would rebuild every menu item on each change-detection pass — that
     * destroys the node between mousedown and mouseup and Chromium then
     * drops the click entirely. Tracking by stable id/key keeps the nodes.
     */
    trackColumn = (_index: number, column: SftpColumn): string => column.id

    trackToggle = (_index: number, toggle: { key: string }): string => toggle.key

    /**
     * Full paths of every selected entry — files and folders mixed freely.
     * `Set` rather than an array: `isSelected()` runs for every row on every
     * change-detection pass (see the doc comment above `rows`), and a `Set`
     * lookup is the O(1) that requires.
     */
    private selection = new Set<string>()

    /**
     * The last entry clicked *without* Shift — a plain click or a Ctrl/Cmd
     * click, both of which start a fresh anchor by the usual desktop
     * convention. A Shift+click ranges from here to the clicked row, in
     * **displayed** order, and never moves the anchor itself: a second
     * Shift+click extends or shrinks the same range instead of restarting it
     * from wherever the previous one landed.
     */
    private selectionAnchor: string|null = null

    private editor: SftpRemoteEditor
    private dragOut: SftpDragOut
    /** Drag-out, drop-upload and internal move. */
    readonly drop: SftpDropController
    /** Rename and the single/bulk delete paths. */
    readonly fileOps: SftpFileOperationsController

    // Declared explicitly rather than relying on Angular inheriting the
    // parent's factory: the parameters are the contract with SSHModule's
    // providers, and spelling them out keeps a future change in tabby-ssh a
    // compile error instead of a runtime injection failure.
    //
    // `notify`/`ngbModalService` rather than `notifications`/`ngbModal`: the
    // parent already holds *private* fields under those names, and
    // redeclaring one in a subclass is a type error — so the injected
    // instances have to be kept under names of our own to stay reachable.
    constructor (
        private config: ConfigService,
        private locale: LocaleService,
        private notify: NotificationsService,
        private ngbModalService: NgbModal,
        private elementRef: ElementRef<HTMLElement>,
        private zone: NgZone,
        private editors: SidebarPlusEditorService,
        platform: PlatformService,
        temp: SidebarPlusTempFilesService,
        private notices: SidebarPlusNoticesService,
        private i18n: SidebarPlusI18nService,
        private dragServer: SidebarPlusDragOutServer,
        registry: SidebarPlusTransfersService,
        translate: TranslateService,
        @Inject(SFTPContextMenuItemProvider) contextMenuProviders: SFTPContextMenuItemProvider[],
    ) {
        super(ngbModalService, notify, platform, translate, contextMenuProviders)
        const transfers = new SftpTransfers(platform, notices, registry)
        this.fileTransfers = transfers
        this.platformSvc = platform
        this.editor = new SftpRemoteEditor(notices, editors, transfers, temp, (message, confirmLabel) => this.ask(message, confirmLabel), zone)
        this.dragOut = new SftpDragOut(notices, zone, transfers, temp)
        this.drop = new SftpDropController(
            config,
            zone,
            notices,
            notify,
            i18n,
            registry,
            dragServer,
            this.dragOut,
            {
                getSftp: () => this.sftp,
                getPath: () => this.path,
                getDisplayedFiles: () => this.displayedFiles,
                getSelection: () => this.selection,
                getSessionLabel: () => this._sessionLabel,
                isDirectoryEntry: item => this.isDirectoryEntry(item),
                resolveSymlink: item => this.resolveSymlink(item),
                refreshListing: () => this.refreshListing(),
                ask: (message, confirmLabel) => this.ask(message, confirmLabel),
            },
        )
        this.fileOps = new SftpFileOperationsController(
            config,
            ngbModalService,
            notify,
            notices,
            i18n,
            {
                getSftp: () => this.sftp,
                getPath: () => this.path,
                getSelection: () => this.selection,
                getSelectionAnchor: () => this.selectionAnchor,
                setSelectionAnchor: path => {
                    this.selectionAnchor = path
                },
                getSelectedItems: () => this.selectedItems(),
                refreshListing: () => this.refreshListing(),
                navigate: path => this.navigate(path),
                isPanelAttached: () => !!this.elementRef.nativeElement.offsetParent,
            },
        )
    }

    /** The transfers helper shared with the editor and the drag-out — kept for routes started here. */
    private readonly fileTransfers: SftpTransfers
    /** The constructor's `platform` goes to `super` — kept under our own name for the routes below. */
    private readonly platformSvc: PlatformService

    private _sessionLabel: string|null = null
    /**
     * Display name of the SSH tab this panel serves, set by the host panel at
     * creation. Forwarded to the transfers helper, which stamps it on every
     * registry line this panel starts — and passed along with each drag-out
     * offer, whose delivery happens long after this component may be gone.
     */
    set sessionLabel (value: string|null) {
        this._sessionLabel = value
        this.fileTransfers.sessionLabel = value
    }

    get sessionLabel (): string|null {
        return this._sessionLabel
    }

    /**
     * True when the SFTP channel could not be opened at all.
     *
     * Read by the host panel, which has no other way of telling a browser that
     * is merely empty from one that never got a channel.
     */
    sftpUnavailable = false

    /** What the server or the transport actually said — shown rather than guessed at. */
    sftpUnavailableReason = ''

    /**
     * A file was double-clicked. The host owns the local pane, so it is the
     * side that knows the destination directory; this component only names the
     * remote entry. The old double-click opened the edit round-trip and its
     * temporary copy — that is now explicitly "Edit on the server..." in the
     * context menu.
     */
    @Output() transferRequest = new EventEmitter<SFTPFile>()

    /**
     * `super.ngOnInit()` calls `session.openSFTP()` **outside** its own
     * try/catch — only the `navigate()` that follows is guarded. So a server
     * without an SFTP subsystem, or a transport that died between the tab
     * opening and the panel being built, rejects here and takes the whole
     * `ngOnInit` down: unhandled rejection, `this.sftp` left undefined, and a
     * panel that shows nothing and says nothing. Catching it is what turns a
     * silent dead view into a state the panel above can act on.
     */
    override async ngOnInit (): Promise<void> {
        try {
            await super.ngOnInit()
        } catch (error) {
            this.sftpUnavailable = true
            this.sftpUnavailableReason = String((error as Error)?.message ?? error)
            return
        }
        this.startAutoRefresh()
        // The interval is rebuilt on every config change rather than tracked:
        // the setting is edited from the settings tab, not from here, and
        // restarting a timer is cheaper than watching one key.
        this.config.changed$.subscribe(() => this.startAutoRefresh())
    }

    ngOnDestroy (): void {
        this.editor.dispose()
        this.dragOut.dispose()
        this.stopAutoRefresh()
        // Clears the drop highlight and the one document listener the drag
        // gesture puts there — a panel torn down mid-gesture would otherwise
        // leave it for good.
        this.drop.dispose()
        // Belt and braces alongside `loadMoreSentinelRef`'s own teardown: a
        // component destroyed outright — the SSH tab closing, say — never
        // runs that setter with `undefined`, Angular just tears the view
        // down, so the observer has to be told here too.
        this.teardownLoadMoreObserver()
    }

    /**
     * Serves the file ourselves and lets Chromium write it, instead of the
     * inherited `platform.startDownload()` path.
     *
     * The inherited one calls `this.sftp.download(...)` **without awaiting
     * it** (`sftpPanel.component.ts:252` of the installed app), so a transport
     * that dies mid-transfer rejects a promise nobody holds: the failure never
     * reaches us, and all the panel sees is the `transfer.cancel()` tabby-ssh
     * makes on its way out — a line reading "annulé" for something the user
     * never cancelled. Going through our own HTTP offer puts the rejection back
     * in a catch we own, which is what tells a dead transfer apart from a
     * cancelled one.
     *
     * **Overriding `download()` and not `downloadItem()` is the point.** This
     * used to hook the latter, which left the whole thing resting on an
     * unwritten assumption: that the context menu entry calls
     * `panel.downloadItem(item)` (it does, in `sftpContextMenu.ts`). If Tabby
     * ever pointed that entry at `download()` instead, the override would have
     * stopped being reached — no error, no sign, just the "annulé" label
     * quietly back. `download()` is where both routes end up, `open()`
     * included, so which one the host picks stops mattering. That is one
     * unverifiable assumption removed rather than watched.
     *
     * Chromium does the writing, so what is given up is the native transfers
     * menu's progress bar — a trade the user made knowingly on 2026-08-02, this
     * plugin hiding that menu by default and its own panel saying more
     * (percentage, speed, ETA).
     *
     * Directories and symlinks stay on the inherited path, as before: a
     * `DownloadURL` offer serves exactly one file, and a link is only ever
     * resolved through the `stat()` piège #50 warns against — its `size` is
     * sound but its mode is not, and there is nothing here worth that risk.
     * `downloadFolder()` never comes through here at all.
     */
    override async download (itemPath: string, mode: number, size: number): Promise<void> {
        // The listing, never `stat()` (piège #50): it comes from `readdir`, so
        // its size and mode are the real ones. An entry that is not in it —
        // nothing reaches this method today with such a path — falls back.
        const item = this.fileList?.find(f => f.fullPath === itemPath)
        if (!item || item.isDirectory || item.isSymlink || !this.dragServer.ready || this.downloadsAreIntercepted()) {
            await super.download(itemPath, mode, size)
            return
        }
        const url = this.dragServer.offer(this.sftp, item, this._sessionLabel ?? undefined)
        if (!url) {
            await super.download(itemPath, mode, size)
            return
        }
        // A detached anchor is enough — the offer answers with
        // `Content-Disposition: attachment`, so Chromium downloads rather than
        // navigates, and the transfer registers itself when the request lands.
        const link = document.createElement('a')
        link.href = url
        link.download = item.name
        link.click()
    }

    /**
     * Sends « Download directory » down this plugin's own route instead of the
     * inherited one.
     *
     * The inherited route *does* await its transfers, but converts any failure
     * into `transfer.cancel()` on its single aggregated line — so a transport
     * that dies mid-download reads « annulé » for something the user never
     * cancelled, exactly the confusion `download()` above was moved off of.
     * Going through `SftpTransfers.download()` gives every file its own line,
     * a real `failed` state when one dies, and the arrival check — the folder
     * route is the one place where the destination is a path we chose, so
     * « le fichier est-il bien arrivé ? » is actually answerable here.
     *
     * Same shape as the marker delivery in `SidebarPlusDragOutServer.deliver()`:
     * pick a folder, avoid collisions the Explorer way, then walk and fetch
     * four files at a time. The directory dialog is ours to raise since the
     * inherited `startDownloadDirectory()` is never called — `pickDirectory()`
     * answers null on cancel, which ends the gesture without a word, like the
     * native route.
     */
    override async downloadFolder (folder: SFTPFile): Promise<void> {
        // Arity-checked like `imposesPath`: an older Tabby without the two
        // dialog arguments still answers a folder, just with a stock title.
        if (typeof this.platformSvc.pickDirectory !== 'function') {
            await super.downloadFolder(folder)
            return
        }
        const base = await this.platformSvc.pickDirectory(
            this.i18n.t('Destination folder for {name}', { name: folder.name }),
            this.i18n.t('Download here'),
        )
        if (!base) {
            return
        }
        const target = freeLocalName(base, folder.name)
        try {
            await downloadRemoteTree(
                this.sftp, folder.fullPath, target,
                (remote, local, item) => this.fileTransfers.download(this.sftp, remote, local, item.name, item.size, item.mode),
            )
            this.notices.notice(this.i18n.t('{name} downloaded to {base}', { name: folder.name, base }))
        } catch (error) {
            // The lines already say which file failed and why; the toast says
            // the folder as a whole is not to be trusted yet.
            this.notices.error(
                this.i18n.t('{name}: incomplete download', { name: folder.name }),
                String((error as Error)?.message ?? error),
            )
        }
    }

    /**
     * Whether something now decides where downloads land.
     *
     * The second thing our route rests on: Tabby installs **no**
     * `will-download` handler, which is what leaves Electron free to raise its
     * own "Save as" dialog — the same prompt the inherited path used to raise.
     * A handler appearing there would silently change what the user gets, and
     * could cancel the download outright, which would be a click that does
     * nothing at all.
     *
     * Rather than document that as a thing to re-check after a Tabby update,
     * it is asked. `listenerCount` is an EventEmitter method, i.e. actually
     * contractual, unlike everything else in this file's neighbourhood.
     * Measured at 0 on the installed app. When it is not, the inherited route
     * is the honest answer: `platform.startDownload()` is what Tabby would
     * expect to be handling.
     */
    private downloadsAreIntercepted (): boolean {
        try {
            return (electronRemote()?.session?.defaultSession?.listenerCount('will-download') ?? 0) > 0
        } catch {
            // Unreachable remote is not evidence of interception, and this is a
            // fallback, not a gate: keep the route that works.
            return false
        }
    }

    ////// AUTO REFRESH //////
    private autoRefreshTimer: ReturnType<typeof setInterval>|null = null

    /**
     * Reloads the listing on a timer, because nothing else does.
     *
     * SFTP has no change notification: a file created or removed from a shell
     * simply does not appear until the directory is read again. Off by default
     * (0 seconds) — a poll on a large directory is a full `readdir` each time,
     * and the user is the one who knows whether that trade is worth it here.
     *
     * Skipped, never queued, while anything is in the middle of something: a
     * menu open, a path being typed, a delete in flight. Refreshing under an
     * open menu would rebuild the rows beneath it, and the selection with them.
     */
    private startAutoRefresh (): void {
        this.stopAutoRefresh()
        const seconds = Number(this.config.store.sidebarPlus?.sftpAutoRefreshSeconds ?? 0)
        if (!seconds || seconds <= 0) {
            return
        }
        this.autoRefreshTimer = setInterval(() => void this.autoRefresh(), seconds * 1000)
    }

    private stopAutoRefresh (): void {
        if (this.autoRefreshTimer) {
            clearInterval(this.autoRefreshTimer)
            this.autoRefreshTimer = null
        }
    }

    private async autoRefresh (): Promise<void> {
        if (!this.sftp || this.fileOps.isDeleting || this.editingPath !== null
            || this.backgroundMenuOpen || this.displayMenuOpen) {
            return
        }
        await this.refreshListing()
    }

    /**
     * Rereads the current directory and merges the result in.
     *
     * Deliberately *not* `navigate()`: that one clears the list before
     * refilling it, so every row is destroyed and rebuilt — the visible jump,
     * and a full re-render of a directory that usually has not changed at all.
     */
    private async refreshListing (): Promise<void> {
        const entries = await this.sftp.readdir(this.path).catch(() => null)
        if (entries) {
            this.applyListing(entries)
        }
    }

    /**
     * Merges a fresh listing into the current one, touching only what differs.
     *
     * Nothing changed ⇒ nothing is reassigned, so `filteredFileList` keeps its
     * identity, the sorted list and the row cache stay valid, and the refresh
     * costs exactly one `readdir` and no rendering whatsoever. When something
     * did change, unchanged entries keep their *existing object*, which is what
     * lets `trackBy` hold on to the rows already on screen — the list updates
     * in place instead of blinking, and the scroll position survives.
     */
    private applyListing (entries: SFTPFile[]): void {
        const current = this.fileList ?? []
        const byPath = new Map(current.map(file => [file.fullPath, file]))
        let changed = current.length !== entries.length
        const merged = entries.map(entry => {
            const existing = byPath.get(entry.fullPath)
            if (existing && sameSftpEntry(existing, entry)) {
                return existing
            }
            changed = true
            return entry
        })
        if (!changed) {
            return
        }
        this.fileList = merged
        // The native filter pass, reached through its public trigger rather
        // than through `updateFilteredList()`, which is private.
        this.onFilterChange()
    }

    ////// CONTEXT MENUS //////
    /** Create actions, on a right-click over the empty area of the listing. */
    backgroundMenuOpen = false
    /** Columns and display toggles. Opened by right-clicking the header — where SFTP+ puts it, and where one looks for column settings — or from the background menu. */
    displayMenuOpen = false
    backgroundMenuX = 0
    backgroundMenuY = 0
    /** Set when either menu opens, consumed once in ngAfterViewChecked — a menu has no measurable size until Angular has rendered it (piège #30). */
    private backgroundMenuDirty = false

    /**
     * Right-click anywhere in the listing that is not an entry.
     *
     * Entry rows carry their own `(contextmenu)` and this handler sits on
     * their container, so without the guard below a right-click on a file
     * would open both menus. The header is deliberately *not* excluded — it is
     * neither a file nor a folder, and reaching the display settings by
     * right-clicking the column titles is where one would look first.
     */
    onBackgroundContextMenu (event: MouseEvent): void {
        const target = event.target as HTMLElement
        if (target.closest('.sftp-row:not(.sftp-header-row)')) {
            return
        }
        event.preventDefault()
        event.stopPropagation()
        // Right-clicking the column titles goes straight to the display
        // settings — one click instead of two, as in SFTP+. Elsewhere in the
        // empty area, the create actions.
        const onHeader = !!target.closest('.sftp-header-row')
        this.clearSelection()
        this.backgroundMenuX = event.clientX
        this.backgroundMenuY = event.clientY
        this.backgroundMenuOpen = !onHeader
        this.displayMenuOpen = onHeader
        this.backgroundMenuDirty = true
    }

    /**
     * Closes the menu on any click outside it.
     *
     * The `closest()` test is not belt-and-braces: a `document:click`
     * HostListener fires even when a descendant called stopPropagation() on
     * the event, so checking the target explicitly is the only thing that
     * keeps clicking a menu item from dismissing the menu first (piège #15).
     */
    @HostListener('document:click', ['$event'])
    onDocumentClick (event: MouseEvent): void {
        if (!this.backgroundMenuOpen && !this.displayMenuOpen) {
            return
        }
        if ((event.target as HTMLElement).closest('.sftp-floating-menu')) {
            return
        }
        this.backgroundMenuOpen = false
        this.displayMenuOpen = false
    }

    ngAfterViewChecked (): void {
        if (!this.backgroundMenuDirty) {
            return
        }
        this.backgroundMenuDirty = false
        setTimeout(() => {
            const menu = document.querySelector<HTMLElement>('.sftp-floating-menu')
            if (!menu) {
                return
            }
            const { x, y } = clampInViewport(menu, this.backgroundMenuX, this.backgroundMenuY)
            this.backgroundMenuX = x
            this.backgroundMenuY = y
            menu.style.left = `${x}px`
            menu.style.top = `${y}px`
        })
    }

    createDirectoryFromMenu (): void {
        this.backgroundMenuOpen = false
        void this.openCreateDirectoryModal()
    }

    /** Copies the remote directory on screen — the upload target — to the clipboard. */
    copyCurrentPath (): void {
        this.backgroundMenuOpen = false
        this.platform.setClipboard({ text: this.path })
    }

    /** Swaps one menu for the other in place, so the display settings appear where the cursor already is. */
    openDisplayMenu (): void {
        this.backgroundMenuOpen = false
        this.displayMenuOpen = true
        this.backgroundMenuDirty = true
    }

    /**
     * Creates an empty remote file.
     *
     * `SFTPSession` offers no "create file", so this goes through `upload()`
     * with a zero-byte transfer — see EmptyFileUpload. Mode 0o644, the usual
     * default for a new file; the context menu on the entry can change it
     * afterwards.
     */
    async createFileFromMenu (): Promise<void> {
        this.backgroundMenuOpen = false
        const modal = this.ngbModalService.open(PromptModalComponent)
        modal.componentInstance.prompt = this.i18n.t('New file name')
        const result = await modal.result.catch(() => null)
        const name = result?.value?.trim()
        if (!name) {
            return
        }
        if (name.includes('/')) {
            this.notify.error(this.i18n.t('The name cannot contain "/"'))
            return
        }

        const fullPath = this.path.endsWith('/') ? `${this.path}${name}` : `${this.path}/${name}`
        // There is no `exists()` on the session, and creating over an existing
        // file would silently truncate it. Read through the parent's listing
        // rather than through `stat()`: same answer for an ordinary file, but
        // `stat()` follows links, so a *dangling* symlink of that name reported
        // the name as free — and the create then clobbered the link. Same check
        // as `renameEntry()` makes, by the same route.
        if (await readRemoteEntry(this.sftp, fullPath)) {
            this.notify.error(this.i18n.t('{name} already exists', { name }))
            return
        }

        try {
            await this.sftp.upload(fullPath, new EmptyFileUpload(name, 0o644))
            await this.navigate(this.path)
        } catch (e) {
            this.notify.error(this.i18n.t('Could not create {name}', { name }), String(e))
        }
    }

    ////// SELECTION & OPENING //////
    /**
     * Row click. Plain click replaces the whole selection with this entry;
     * Ctrl/Cmd+click toggles it in/out without touching the rest; Shift+click
     * ranges from the anchor to here, in the order the list is rendered in
     * (`displayedFiles`), replacing whatever was selected before. `event` is
     * optional so every non-interactive caller — `openEntry()` navigating
     * into a directory, for instance — keeps making a plain single selection
     * without having to fake one.
     */
    select (item: SFTPFile, event?: MouseEvent): void {
        const path = item.fullPath
        if (event?.shiftKey && this.selectionAnchor !== null) {
            this.selectRange(this.selectionAnchor, path)
            return
        }
        if (event && (event.ctrlKey || event.metaKey)) {
            if (this.selection.has(path)) {
                this.selection.delete(path)
            } else {
                this.selection.add(path)
            }
            this.selectionAnchor = path
            return
        }
        this.selection.clear()
        this.selection.add(path)
        this.selectionAnchor = path
    }

    /** The Shift+click range: replaces the selection with the anchor→target span, in display order. */
    private selectRange (anchorPath: string, targetPath: string): void {
        const files = this.displayedFiles
        const anchorIndex = files.findIndex(f => f.fullPath === anchorPath)
        const targetIndex = files.findIndex(f => f.fullPath === targetPath)
        if (anchorIndex === -1 || targetIndex === -1) {
            // The anchor is no longer part of what is on screen — filtered out,
            // or the directory changed under it. Ranging over rows that are not
            // there would be arbitrary, so this falls back to a plain single
            // selection instead, exactly as a click without Shift would.
            this.selection.clear()
            this.selection.add(targetPath)
            this.selectionAnchor = targetPath
            return
        }
        const [start, end] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex]
        this.selection.clear()
        for (let i = start; i <= end; i++) {
            this.selection.add(files[i].fullPath)
        }
    }

    isSelected (item: SFTPFile): boolean {
        return this.selection.has(item.fullPath)
    }

    /** Every selected entry still present in the current listing, in display order. Feeds bulk delete/move and the `Suppr` shortcut. */
    private selectedItems (): SFTPFile[] {
        if (this.selection.size === 0) {
            return []
        }
        return this.displayedFiles.filter(f => this.selection.has(f.fullPath))
    }

    /** Empties the selection and forgets the Shift+click anchor — background click, navigating away, or anything else where what was selected stops meaning anything. */
    private clearSelection (): void {
        this.selection.clear()
        this.selectionAnchor = null
    }

    /**
     * Overridden purely to clear the selection when the directory actually
     * changes. `goUp()`, the breadcrumb links and every other navigation
     * `SFTPPanelComponent` offers all funnel through this one inherited
     * method, so overriding it is the single point that catches all of them
     * at once rather than threading a clear through each call site. A
     * same-path call — what the "Actualiser" button sends — is a refresh, not
     * a move to somewhere else, and leaves the selection alone.
     *
     * The rendered chunk resets unconditionally though, same-path call
     * included: `navigate()` clears `fileList` before rereading it, which is
     * what already sends the panel's scroll back to the top today (the
     * `.sftp-grid` disappears behind "Chargement…" and comes back empty) —
     * resetting `renderCount` here just keeps the two in step rather than
     * leaving the previous chunk size to briefly outlive a listing it no
     * longer describes.
     */
    override async navigate (newPath: string, fallbackOnError?: boolean): Promise<void> {
        if (newPath !== this.path) {
            this.clearSelection()
        }
        this.resetRenderChunk()
        await super.navigate(newPath, fallbackOnError)
    }

    /**
     * Overridden purely to reset the rendered chunk: the search bar can turn
     * a five-thousand-entry directory into fifty matches, and what was on
     * screen before has nothing to do with what belongs on screen now.
     */
    override onFilterChange (): void {
        super.onFilterChange()
        this.resetRenderChunk()
    }

    /** Same reasoning as `onFilterChange()` above, for the reverse direction. */
    override clearFilter (): void {
        super.clearFilter()
        this.resetRenderChunk()
    }

    /**
     * Double-click. Directories navigate, as they always did; files are sent
     * to the local pane's current directory instead of opening the edit
     * round-trip. Editing is still available from the context menu, where it
     * cannot be confused with the transfer gesture.
     *
     * A symlink is resolved first for the same reason `openEntry()` does it:
     * a link to a directory must navigate rather than try to transfer a file,
     * and a link to a file must be transferred *as its target* so the local
     * copy gets the target's real size and mode rather than the link's.
     */
    async openItem (item: SFTPFile): Promise<void> {
        this.select(item)
        if (this.isDirectoryEntry(item)) {
            await this.navigate(item.fullPath)
            return
        }
        if (item.isSymlink) {
            let target: SFTPFile|null
            try {
                target = await this.resolveSymlink(item)
            } catch (e) {
                this.notify.error(this.i18n.t('Could not follow the link {name}', { name: item.name }), String(e))
                return
            }
            if (!target) {
                this.notices.error(this.i18n.t('{name} points to a target that cannot be found', { name: item.name }))
                return
            }
            if (this.isDirectoryEntry(target)) {
                // Navigation stays on the link's own path — the server resolves
                // it, and that is the location the user double-clicked.
                await this.navigate(item.fullPath)
                return
            }
            if (target.name !== item.name) {
                this.notices.notice(this.i18n.t('{name} → {target}', { name: item.name, target: target.fullPath }))
            }
            this.transferRequest.emit(target)
            return
        }
        this.transferRequest.emit(item)
    }

    /**
     * Sends one local file to the remote directory currently shown.
     *
     * Called by the host when the lower pane's double-click arrives. Direct
     * path on both sides: the local file is read where it is and written to
     * `posix.join(this.path, name)`; no temporary copy is involved.
     *
     * Collisions are confirmed first. `SFTPSession.upload()` replaces its
     * target by rename, so an unnoticed same-name file would vanish without a
     * word — the same reason the drop planner asks before overwriting.
     */
    async uploadLocalFile (localPath: string): Promise<void> {
        await this.zone.run(async () => {
            if (!this.sftp) {
                return
            }
            const name = basename(localPath)
            let info: fs.Stats
            try {
                info = await fs.promises.stat(localPath)
            } catch (e) {
                this.notices.error(this.i18n.t('Could not send {name}', { name }), String(e))
                return
            }
            if (!info.isFile()) {
                this.notices.error(
                    this.i18n.t('Could not send {name}', { name }),
                    this.i18n.t('{name} is not a file', { name }),
                )
                return
            }

            const destination = this.path
            const remotePath = posix.join(destination, name)
            const existing = await readRemoteEntry(this.sftp, remotePath).catch(() => null)
            if (existing) {
                if (this.isDirectoryEntry(existing)) {
                    this.notices.error(
                        this.i18n.t('Could not send {name}', { name }),
                        this.i18n.t('{name} is a folder on the server', { name }),
                    )
                    return
                }
                // The drop planner already owns the overwrite wording; asking
                // here with a second copy of it made the two messages drift.
                if (!await this.confirmOverwrite([name], destination)) {
                    return
                }
            }

            try {
                await this.fileTransfers.upload(this.sftp, remotePath, localPath, name, info.size, info.mode & 0o7777)
                // Only refresh when the user is still looking at the target
                // directory; navigating away must not be undone by a refresh.
                if (this.path === destination) {
                    await this.refreshListing()
                }
                this.notices.notice(this.i18n.t(
                    '{sent, plural, =1 {# file} other {# files}} sent to {destination}',
                    { sent: 1, destination },
                ))
            } catch (e) {
                this.notices.error(this.i18n.t('Could not send {name}', { name }), String(e))
            }
        })
    }

    /**
     * Downloads one remote file into `localDir`.
     *
     * The destination is the directory the local pane is showing — never a
     * temporary folder. `freeLocalName()` picks an Explorer-style suffix when
     * a same-name file is already there, so nothing is overwritten silently.
     *
     * Answers the path actually written, or null when there is nothing to
     * refresh (no session, failed transfer).
     */
    async downloadToLocal (item: SFTPFile, localDir: string): Promise<string|null> {
        return await this.zone.run(async () => {
            if (!this.sftp) {
                return null
            }
            const target = freeLocalName(localDir, item.name)
            try {
                await this.fileTransfers.download(this.sftp, item.fullPath, target, item.name, item.size, item.mode)
                this.notices.notice(this.i18n.t('{name} downloaded to {base}', { name: item.name, base: localDir }))
                return target
            } catch (e) {
                this.notices.error(this.i18n.t('Could not download {name}', { name: item.name }), String(e))
                return null
            }
        })
    }

    /**
     * `isDirectory` is not enough on its own.
     *
     * `SFTPSession` fills it from `metadata.type`, a field the SFTP v3 wire
     * format does not carry — servers answer `SSH_FXP_STAT` with a permissions
     * word and nothing else, so a `stat()` on a symlink's target can come back
     * with `isDirectory === false` for a directory. The mode does carry the
     * type (Tabby's own `getModeString()` reads it the same way), so the two
     * are checked together. Without this, a symlink to a directory fell through
     * to the download path and the server answered `Failure` — "Impossible de
     * télécharger <nom>", found in testing on 2026-07-30.
     */
    private static readonly S_IFMT = 0o170000
    private static readonly S_IFDIR = 0o040000

    private isDirectoryEntry (f: SFTPFile): boolean {
        return f.isDirectory || (f.mode & SidebarPlusSftpBrowserComponent.S_IFMT) === SidebarPlusSftpBrowserComponent.S_IFDIR
    }

    /** A symlink chain longer than this is a loop as far as we are concerned. */
    /**
     * Follows a symlink to the entry it really designates — the shared
     * resolver in remoteEntry.ts, kept behind a method so the many call sites
     * of this file did not all have to change when it moved there.
     */
    private async resolveSymlink (item: SFTPFile): Promise<SFTPFile|null> {
        return resolveRemoteSymlink(this.sftp, item)
    }

    /**
     * Opens an entry: directories navigate, files take the edit round-trip.
     *
     * A symlink is resolved to its target **and the target is what gets
     * edited** — path included. Keeping the link's own path here is what used
     * to make three things go wrong at once, none of them visible at the time:
     * the mode read for the download came from `stat()` and was 0, so the local
     * copy was created read-only and the editor could not save; the mode
     * restored after an upload was the *link's* (`0o120777`), so the file came
     * back world-writable; and the freshness check compared the link's size and
     * date, which never move when the target changes, so conflict detection was
     * dead. Writing to the resolved path settles all three, and has a fourth
     * effect worth stating: `SFTPSession.upload()` unlinks its target before
     * renaming over it, so editing "through" the link used to replace it with a
     * regular file. It no longer touches the link at all.
     */
    private async openEntry (item: SFTPFile, mode: OpenMode): Promise<void> {
        this.select(item)
        if (this.isDirectoryEntry(item)) {
            await this.navigate(item.fullPath)
            return
        }
        if (item.isSymlink) {
            let target: SFTPFile|null
            try {
                target = await this.resolveSymlink(item)
            } catch (e) {
                this.notify.error(this.i18n.t('Could not follow the link {name}', { name: item.name }), String(e))
                return
            }
            if (!target) {
                this.notices.error(this.i18n.t('{name} points to a target that cannot be found', { name: item.name }))
                return
            }
            if (this.isDirectoryEntry(target)) {
                // Navigation stays on the link's own path: that is the location
                // the user asked for, and the server resolves it on its own.
                await this.navigate(item.fullPath)
                return
            }
            // Said out loud when the names differ: the editor is about to open
            // something else than the row that was double-clicked.
            if (target.name !== item.name) {
                this.notices.notice(this.i18n.t('{name} → {target}', { name: item.name, target: target.fullPath }))
            }
            await this.editor.edit(this.sftp, target, mode)
            return
        }
        await this.editor.edit(this.sftp, item, mode)
    }

    /** The panel's one yes/no question, in HTML rather than a native dialog (piège #42). */
    private async ask (message: string, confirmLabel: string): Promise<boolean> {
        const modal = this.ngbModalService.open(ConfirmModalComponent)
        modal.componentInstance.message = message
        modal.componentInstance.confirmLabel = confirmLabel
        modal.componentInstance.defaultButton = 'cancel'
        return await modal.result.catch(() => false)
    }

    /**
     * The overwrite question shared with the local-pane upload path.
     *
     * The wording itself lives in `sftpMessages.ts`, also used by
     * `SftpDropController`; only the dialog is per-caller.
     */
    private async confirmOverwrite (collisions: string[], destination: string): Promise<boolean> {
        const message = overwritePrompt(
            collisions,
            destination,
            (key, params) => this.i18n.t(key, params),
        )
        return await this.ask(message, this.i18n.t('Overwrite'))
    }

    ////// DRAG & DROP //////
    // Drag-out, drop-upload and the internal move live in SftpDropController;
    // the template binds to these reads and handlers.
    get dropTargetPath (): string|null {
        return this.drop.dropTargetPath
    }

    get dropOnUpRow (): boolean {
        return this.drop.dropOnUpRow
    }

    isDragPreparing (item: SFTPFile): boolean {
        return this.drop.isDragPreparing(item)
    }

    isDropTarget (item: SFTPFile): boolean {
        return this.drop.isDropTarget(item)
    }

    get dropInCurrentDirectory (): boolean {
        return this.drop.dropInCurrentDirectory
    }

    isDragSource (item: SFTPFile): boolean {
        return this.drop.isDragSource(item)
    }

    onDragStart (item: SFTPFile, event: DragEvent): void {
        this.drop.onDragStart(item, event)
    }

    onDragEnd (event?: DragEvent): void {
        this.drop.onDragEnd(event)
    }

    onDragOver (event: DragEvent): void {
        this.drop.onDragOver(event)
    }

    onDragLeave (event: DragEvent): void {
        this.drop.onDragLeave(event)
    }

    onDrop (event: DragEvent): void {
        this.drop.onDrop(event)
    }

    ////// DELETE //////
    /**
     * Overridden rather than left inherited: the native `showContextMenu()`
     * (`SFTPPanelComponent`/`CommonSFTPContextMenu`) confirms its "Delete"
     * entry with `platform.showMessageBox()` — a native OS dialog, exactly
     * what this plugin's confirmations are meant never to be (piège #42).
     * `CommonSFTPContextMenu` is the only built-in provider, and always
     * pushes its "Delete" entry last (verified on the installed source), so
     * it is dropped by position unconditionally — the label is only checked
     * to `console.warn` if a future Tabby version ever reorders it, rather
     * than gating the removal on a translation string this plugin doesn't
     * control (Tabby's own catalogs translate it — 删除 on zh-CN, Löschen on
     * de-DE, Eliminar on es-ES, Supprimer on fr-FR — hence the label list,
     * not a single expected string).
     *
     * Every entry pushed below — "Ouvrir avec...", "Renommer...", "Supprimer"
     * — acts on `item`, the row that was right-clicked, never on the
     * selection as a whole; same for the double-click handler above. Only the
     * bulk delete entry appended last is selection-aware, and only appears
     * when `item` itself is part of one.
     */
    async showContextMenu (item: SFTPFile, event: MouseEvent): Promise<void> {
        event.preventDefault()
        const items = await this.buildContextMenu(item)
        const last = items.pop()
        if (last && !/^(delete|supprimer|löschen|eliminar|删除)/i.test(String(last.label ?? ''))) {
            console.warn('sidebar-plus: expected the native SFTP context menu to end with "Delete"', last)
        }
        // Pushed after the pop() above, never before: the native "Delete" entry
        // is dropped by position, so inserting anything first would remove the
        // wrong item.
        items.push({
            label: this.i18n.t('Copy full path'),
            click: () => this.platform.setClipboard({ text: item.fullPath }),
        })
        // The one route to the OS association, and only from here —
        // a double-click can never reach it. Windows-only: `OpenAs_RunDLL` has
        // no equivalent elsewhere, and this plugin is published publicly.
        if (!this.isDirectoryEntry(item) && this.editors.canOpenWith) {
            items.push({
                label: this.i18n.t('Open with...'),
                click: () => { void this.openEntry(item, 'openWith') },
            })
        }
        // Double-click is the transfer gesture now, so editing has to stay
        // reachable from an explicit entry instead of disappearing with it.
        if (!this.isDirectoryEntry(item)) {
            items.push({
                label: this.i18n.t('Edit on the server...'),
                click: () => { void this.openEntry(item, 'editor') },
            })
        }
        items.push({
            label: this.i18n.t('Rename...'),
            click: () => { void this.renameEntry(item) },
        })
        items.push({
            label: this.i18n.t('Delete'),
            click: () => { void this.confirmAndDelete(item) },
        })
        const selected = this.selectedItems()
        if (selected.length > 1 && this.selection.has(item.fullPath)) {
            items.push({
                label: this.i18n.t('Delete selection ({count})', { count: selected.length }),
                click: () => { void this.confirmAndDeleteSelection(selected) },
            })
        }
        this.platform.popupContextMenu(items, event)
    }

    /**
     * Clicking the empty area below the rows clears the selection.
     *
     * The listing has no separate background element — the empty space is the
     * body's own padding — so this fires for row clicks as well and has to
     * ignore them. `closest('.sftp-row')` rather than a target equality test:
     * a click lands on the icon or the label inside a row, never on the row
     * element itself.
     */
    clearSelectionFromBackground (event: MouseEvent): void {
        // `.sftp-row` covers the header row and the "go up" row too, both of
        // which carry that class — clicking either must not clear a selection
        // the user made on purpose.
        if ((event.target as HTMLElement).closest('.sftp-row')) {
            return
        }
        this.clearSelection()
    }

    private async renameEntry (item: SFTPFile): Promise<void> {
        await this.fileOps.renameEntry(item)
    }

    /** `Suppr` on the selection — a single entry takes the same confirm-then-delete path as the context menu's "Supprimer", several take the bulk one further down. */
    @HostListener('document:keydown', ['$event'])
    onDocumentKeydown (event: KeyboardEvent): void {
        this.fileOps.onDocumentKeydown(event)
    }

    async confirmAndDelete (item: SFTPFile): Promise<void> {
        await this.fileOps.confirmAndDelete(item)
    }

    async confirmAndDeleteSelection (items: SFTPFile[]): Promise<void> {
        await this.fileOps.confirmAndDeleteSelection(items)
    }

    ////// COLUMNS //////
    /** Configured columns, in the order declared by `availableColumns`, ignoring ids that no longer exist. */
    private columnCache: { key: string, result: SftpColumn[] }|null = null

    /**
     * Cached for its *identity*, not to save the filter.
     *
     * This getter feeds an `*ngFor` inside every row and the grid template of
     * every row. Returning a fresh array each time made Angular re-diff the
     * columns of each row on every cycle — the single biggest cost on a large
     * directory. The config's own column list is the invalidation key — the
     * active locale rides along in it too, since `availableColumns` now
     * translates its labels on every read: without this, a language change
     * would sit uninvalidated behind an unchanged column selection and the
     * header row would keep showing the previous locale's captions.
     */
    get visibleColumns (): SftpColumn[] {
        const selected: string[] = this.config.store.sidebarPlus?.sftpColumns ?? []
        const key = `${selected.join('\0')}\0${this.locale.getLocale()}`
        if (this.columnCache?.key === key) {
            return this.columnCache.result
        }
        const result = this.availableColumns.filter(c => selected.includes(c.id))
        this.columnCache = { key, result }
        return result
    }

    /**
     * Both the header and every row carry this, rather than the grid being
     * declared once on the container with rows as `display: contents` — a row
     * that generates no box cannot take a hover background or a bottom border.
     */
    get gridTemplate (): string {
        const columns = this.visibleColumns
        if (this.gridCache?.columns === columns) {
            return this.gridCache.result
        }
        const result = ['1.15rem', 'minmax(0, 1fr)', ...columns.map(c => c.width)].join(' ')
        this.gridCache = { columns, result }
        return result
    }

    private gridCache: { columns: SftpColumn[], result: string }|null = null

    isColumnVisible (column: SftpColumn): boolean {
        return this.visibleColumns.some(c => c.id === column.id)
    }

    isToggleOn (key: string): boolean {
        return this.config.store.sidebarPlus?.[key] ?? false
    }

    toggleDisplayOption (key: string): void {
        this.config.store.sidebarPlus[key] = !this.isToggleOn(key)
        this.config.save()
        // Folders-first reorders the listing and hidden-files resizes it —
        // both belong on the reset list on their own merits. The other two
        // (zebra, column borders) are purely cosmetic and never touch which
        // rows exist, but resetting alongside them is harmless: this only
        // ever runs from an explicit menu click, never from the background.
        this.resetRenderChunk()
    }

    private displayCache: {
        source: SFTPFile[]
        showHidden: boolean
        foldersFirst: boolean
        result: SFTPFile[]
    }|null = null

    /**
     * What the list actually renders: `filteredFileList` sorted, and with the
     * dotfiles dropped when the user asked for it.
     *
     * A getter rather than a field kept in sync, because `filteredFileList` is
     * rebuilt by the inherited — and private — `updateFilteredList()`, with no
     * hook to piggyback on. Which makes this run on every change detection
     * pass, hence the cache: sorting a large directory several times a second,
     * and handing Angular a new array each time for it to diff, is a cost
     * neither side needs to pay. `updateFilteredList()` always *reassigns*
     * `filteredFileList` rather than mutating it, so reference equality is a
     * sound invalidation signal.
     */
    get displayedFiles (): SFTPFile[] {
        const showHidden = this.isToggleOn('sftpShowHidden')
        const foldersFirst = this.isToggleOn('sftpFoldersFirst')
        const cached = this.displayCache
        if (cached
            && cached.source === this.filteredFileList
            && cached.showHidden === showHidden
            && cached.foldersFirst === foldersFirst) {
            return cached.result
        }

        const files = sortAndFilterListing(this.filteredFileList, {
            showHidden,
            foldersFirst,
            locale: this.locale.getLocale(),
            isHidden: file => this.isHidden(file),
        })

        this.displayCache = { source: this.filteredFileList, showHidden, foldersFirst, result: files }
        return files
    }

    trackByPath (_index: number, item: SFTPFile): string {
        return item.fullPath
    }

    trackByRow (_index: number, row: SftpRow): string {
        return row.item.fullPath
    }

    private rowCache: { source: SFTPFile[], columns: SftpColumn[], result: SftpRow[] }|null = null

    /**
     * The rows as the template consumes them: everything formatted up front.
     *
     * Recomputed only when the sorted list or the visible columns change, both
     * of which are compared by reference — `displayedFiles` and
     * `visibleColumns` each hand back a stable array until something real
     * changes. `isSelected()` and `isDragPreparing()` stay as calls in the
     * template on purpose: they are a `Set`/`Map` lookup, and they change
     * without the list changing at all.
     */
    get rows (): SftpRow[] {
        const source = this.displayedFiles
        const columns = this.visibleColumns
        const cached = this.rowCache
        if (cached && cached.source === source && cached.columns === columns) {
            return cached.result
        }
        // Rows whose entry object survived the merge are reused as they are:
        // after a refresh where one file changed, only that file is formatted
        // again. `applyListing()` is what makes this work — it keeps the
        // existing object for every unchanged entry.
        const previous = cached?.columns === columns ? cached.result : []
        const result = reuseListingRows(source, previous, item => ({
            item,
            icon: this.getIcon(item),
            tooltip: this.rowTooltip(item),
            hidden: this.isHidden(item),
            cells: columns.map(column => this.cellValue(column, item)),
        }))
        this.rowCache = { source, columns, result }
        return result
    }

    ////// RENDER CHUNKING (lazy list) //////
    /**
     * How many rows a single growth step adds — first paint included, since
     * `renderCount` starts at exactly this value. Large enough to fill a tall
     * sidebar without the sentinel showing up immediately, small enough that
     * a directory of several thousand entries never lays out more than a
     * handful of chunks' worth of DOM at once. This bounds the *rendering*
     * cost only — `readdir` already brought the whole listing over the wire,
     * `displayedFiles`/`rows` above are computed over all of it, and
     * scrolling still reaches every entry; nothing here is a cap on what can
     * be browsed.
     */
    private static readonly RENDER_CHUNK = 200

    /**
     * How many of `rows` the template currently renders. Everything past it
     * still exists in `rows` — sorted, formatted, zebra-striped, selected,
     * exactly as if the whole directory were on screen — it simply has no
     * DOM node yet. That is what keeps `selectRange()` correct without any
     * change on its part: a Shift+click can only ever land on a row that is
     * actually rendered, so ranging over `displayedFiles` up to that row is
     * already bounded to what is visible, and the multi-selection `Set`
     * itself is never bounded by this at all — entries scrolled past stay
     * selected.
     */
    private renderCount = SidebarPlusSftpBrowserComponent.RENDER_CHUNK

    /** The observer watching the "load more" sentinel — created and torn down by `loadMoreSentinelRef`'s setter below as the sentinel itself appears and disappears. */
    private loadMoreObserver: IntersectionObserver|null = null

    /**
     * What the template's `*ngFor` actually loops over. Bounding the DOM
     * node count is the entire point of this section, so the slice has to be
     * what is consumed, not `rows` itself — sort, zebra, columns and
     * selection all stay computed over the full list upstream of this.
     * `slice()` on an array that never grew past `renderCount` costs nothing
     * of note, and a short directory never pays for anything past this call.
     */
    get visibleRows (): SftpRow[] {
        return this.rows.slice(0, this.renderCount)
    }

    /** Whether more of `rows` exists past what is rendered — gates the sentinel row and, through it, the observer. False for any listing at or under `RENDER_CHUNK`, which is what makes a short directory render exactly as it did before this feature existed: no sentinel, no observer, nothing new. */
    get hasMoreRows (): boolean {
        return this.renderCount < this.rows.length
    }

    /** What the sentinel's "… encore X éléments" line reports. */
    get remainingRowCount (): number {
        return Math.max(0, this.rows.length - this.renderCount)
    }

    /**
     * Back to the first chunk. Called from every action that changes *which*
     * entries belong on screen — `navigate()` (a real move, or the
     * "Actualiser" button rereading the same path), the filter box, and the
     * display toggles that reorder, restrict or resize the listing — rather
     * than from a single shared cache-invalidation branch on `rows` or
     * `displayedFiles`, tempting as that looks. Those getters also recompute
     * on the *background* auto-refresh diff `applyListing()` merges in every
     * few seconds, which is deliberately built to update quietly in place —
     * `trackBy` keeps the rows already on screen, and nothing about the view
     * is supposed to jump (see the doc comment on `applyListing()`).
     * Resetting the chunk there would silently undo exactly that.
     */
    private resetRenderChunk (): void {
        this.renderCount = SidebarPlusSftpBrowserComponent.RENDER_CHUNK
    }

    /**
     * `#loadMoreSentinel` lives under `*ngIf='hasMoreRows'`, so a plain
     * `@ViewChild` field — the pattern `filterInput` uses on the tree — would
     * go stale the moment the sentinel is added or removed: nothing would
     * tell this component to start or stop watching it. The setter form
     * fires on *both* transitions instead, which is what lets the observer's
     * lifecycle track the sentinel's exactly: built the moment the node
     * exists, torn down the moment it does not. `filterInput` never needed
     * this because it is only ever read on demand, never reacted to.
     */
    @ViewChild('loadMoreSentinel') set loadMoreSentinelRef (ref: ElementRef<HTMLElement>|undefined) {
        this.teardownLoadMoreObserver()
        if (!ref) {
            return
        }
        // `.sftp-body` is the element with `overflow-y: auto` — the actual
        // scrolling ancestor. The component's own host merely flexes to fill
        // the sidebar and never scrolls itself.
        const root = this.elementRef.nativeElement.querySelector<HTMLElement>('.sftp-body')
        this.loadMoreObserver = new IntersectionObserver(entries => {
            if (!entries.some(entry => entry.isIntersecting)) {
                return
            }
            // `IntersectionObserver` is a native browser API zone.js does not
            // patch (piège #41) — this callback runs outside Angular, so the
            // mutation that actually grows the rendered slice has to be
            // wrapped for the extra rows to be painted.
            this.zone.run(() => {
                this.renderCount += SidebarPlusSftpBrowserComponent.RENDER_CHUNK
            })
        }, { root, rootMargin: '200px' })
        this.loadMoreObserver.observe(ref.nativeElement)
    }

    /** Shared by the setter above (every appearance/disappearance of the sentinel) and `ngOnDestroy()` (a component torn down outright, which never runs that setter with `undefined`). */
    private teardownLoadMoreObserver (): void {
        this.loadMoreObserver?.disconnect()
        this.loadMoreObserver = null
    }

    toggleColumn (column: SftpColumn): void {
        const selected: string[] = [...(this.config.store.sidebarPlus?.sftpColumns ?? [])]
        const at = selected.indexOf(column.id)
        if (at === -1) {
            selected.push(column.id)
        } else {
            selected.splice(at, 1)
        }
        this.config.store.sidebarPlus.sftpColumns = selected
        this.config.save()
        this.resetRenderChunk()
    }

    cellValue (column: SftpColumn, item: SFTPFile): string {
        switch (column.id) {
            case 'size':
                // A directory's own byte size says nothing useful about it.
                return item.isDirectory ? '' : this.humanSize(item.size)
            case 'date':
                return this.shortDate(item.modified)
            case 'mode':
                return this.octalMode(item)
            case 'modeLong':
                return this.longMode(item)
            case 'type':
                return this.typeLabel(item)
            case 'ext':
                return this.extension(item)
            default:
                return ''
        }
    }

    ////// FORMATTING //////
    /**
     * Date only, no time — the full timestamp lives in the row tooltip.
     *
     * The locale is taken from Tabby rather than left to the JS default:
     * Electron reports en-US whatever the OS says, which would put `7/23/2026`
     * in an otherwise French panel — and, worse, silently swap day and month.
     */
    shortDate (value: Date): string {
        return formatShortDate(value, this.locale.getLocale())
    }

    fullDate (value: Date): string {
        return formatFullDate(value, this.locale.getLocale())
    }

    /** Permissions as the octal triplet — see [[formatOctalMode]]. */
    octalMode (item: SFTPFile): string {
        return formatOctalMode(item)
    }

    /** The `drwxrwxr-x` form — see [[formatLongMode]] for why it is not the inherited one. */
    longMode (item: SFTPFile): string {
        return formatLongMode(item)
    }

    humanSize (bytes: number): string {
        return formatSize(bytes)
    }

    typeLabel (item: SFTPFile): string {
        if (item.isSymlink) {
            return this.i18n.t('Link')
        }
        if (item.isDirectory) {
            return this.i18n.t('Folder')
        }
        const ext = this.extension(item)
        return ext === '' ? this.i18n.t('File') : ext.toUpperCase()
    }

    extension (item: SFTPFile): string {
        return formatExtension(item)
    }

    /** Dotfiles. Dimmed when shown, and shown by default — see [[formatIsHidden]]. */
    isHidden (item: SFTPFile): boolean {
        return formatIsHidden(item)
    }

    /**
     * Everything the columns had to drop to stay narrow: full name, exact
     * size, complete timestamp, and the long `drwxr-xr-x` form alongside the
     * octal one.
     */
    rowTooltip (item: SFTPFile): string {
        const lines = [item.name]
        if (!item.isDirectory) {
            lines.push(this.i18n.t('Size: {size} ({bytes} bytes)', { size: this.humanSize(item.size), bytes: item.size.toLocaleString() }))
        }
        const modified = this.fullDate(item.modified)
        if (modified !== '') {
            lines.push(this.i18n.t('Modified: {date}', { date: modified }))
        }
        lines.push(this.i18n.t('Permissions: {octal} — {long}', { octal: this.octalMode(item), long: this.longMode(item) }))
        lines.push(this.i18n.t('Type: {type}', { type: this.typeLabel(item) }))
        if (item.isSymlink) {
            lines.push(this.i18n.t('Symbolic link'))
        }
        return lines.join('\n')
    }

    ////// TEMPLATE HELPERS //////
    // The getters and thin wrappers below exist so the template never has to
    // contain a string literal. Pug delimits attribute values with one quote
    // style and HTML-entity-escapes the other inside them, which mangles
    // Angular expressions — the same trap already worked around in
    // SidebarPlusTreeComponent.
    get canGoUp (): boolean {
        return this.path !== '/'
    }

    get hasActiveFilter (): boolean {
        return this.showFilter && this.filterText.trim() !== ''
    }

    get filterFoundNothing (): boolean {
        return this.fileList !== null && this.displayedFiles.length === 0 && this.hasActiveFilter
    }

    goRoot (): void {
        void this.navigate('/')
    }

    get showColumnBorders (): boolean {
        return this.isToggleOn('sftpColumnBorders')
    }

    get showZebra (): boolean {
        return this.isToggleOn('sftpZebra')
    }
}
