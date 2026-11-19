import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Component, ElementRef, EventEmitter, HostBinding, HostListener, NgZone, OnInit, Output } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { ConfigService, MenuItemOptions, PlatformService, PromptModalComponent } from 'tabby-core'
import { filesize } from 'filesize'
import { SidebarPlusI18nService } from '../i18n'
import { SidebarPlusNoticesService } from '../notices.service'
import { ConfirmModalComponent } from './confirmModal.component'

/**
 * One rendered row of the local listing.
 *
 * Precomputed like the remote `SftpRow`: the template must not call `filesize`
 * or format a date on every change-detection pass, and a local directory can
 * hold thousands of entries.
 */
interface LocalRow {
    name: string
    fullPath: string
    isDirectory: boolean
    isSymlink: boolean
    /** A symlink whose target cannot be read — it can be listed, not transferred. */
    broken: boolean
    /** Dotfiles, dimmed so the ordinary entries read first. */
    hidden: boolean
    icon: string
    sizeLabel: string
    dateLabel: string
    tooltip: string
}

/** Name column flexible, the two numeric ones fixed — same reasoning as the remote list. */
const LOCAL_GRID_TEMPLATE = '1.4rem minmax(0, 1fr) 4.2rem 5.2rem'

/**
 * The local half of the split SFTP view.
 *
 * Deliberately knows nothing about SSH: it lists a local directory and emits
 * the absolute path of a file that was double-clicked. The panel above owns
 * the session and performs the upload, so this pane stays usable — and
 * testable — while no SSH tab is bound.
 *
 * Double-clicking a directory navigates *here*; double-clicking a file is the
 * transfer gesture, the exact mirror of the remote pane. The old double-click
 * behaviour on the remote side opened the edit round-trip through a temporary
 * directory; that is now an explicit context-menu entry, and transfers go
 * straight to the directory shown in this pane.
 */
@Component({
    selector: 'sidebar-plus-sftp-local',
    template: require('./sftpLocal.component.pug'),
})
export class SidebarPlusSftpLocalComponent implements OnInit {
    /** Absolute path of the local file the user asked to send to the remote pane. */
    @Output() uploadRequest = new EventEmitter<string>()

    path = os.homedir()
    rows: LocalRow[] = []
    pathSegments: { name: string, path: string }[] = []
    canGoUp = false
    loading = true
    error: string|null = null
    selectedPath: string|null = null
    editingPath: string|null = null
    readonly gridTemplate = LOCAL_GRID_TEMPLATE
    /** Path separator of the host OS — the breadcrumb renders it explicitly, never a hard-coded '/'. */
    readonly pathSeparator = path.sep

    /**
     * Makes the pane focusable so `Delete` can target it. The remote pane keeps
     * its document-level shortcut; this one listens on the host only, so the
     * two never delete each other's selection (see `onKeydown()`).
     */
    @HostBinding('attr.tabindex')
    readonly tabindex = '0'

    /** Guards against a key-repeat or a second menu click racing the same deletion. */
    private deleteInFlight = false

    /**
     * Navigation is asynchronous (one `readdir` plus one `stat` per entry), and
     * a fast click on two breadcrumb segments can land the first answer after
     * the second one. Only the most recently started navigation may commit.
     */
    private navigateRequestId = 0

    /**
     * `fs.promises` answers are not guaranteed to re-enter the Angular zone,
     * and this pane's whole state is what they produce. Running the navigation
     * in the zone is the same guard `receiveDrop()` uses on the remote side
     * (piège #41).
     */
    constructor (
        private i18n: SidebarPlusI18nService,
        private zone: NgZone,
        private ngbModal: NgbModal,
        private platform: PlatformService,
        private notices: SidebarPlusNoticesService,
        private elementRef: ElementRef<HTMLElement>,
        private config: ConfigService,
    ) { }

    ngOnInit (): void {
        void this.navigate(this.path)
    }

    /** Read by the host when a remote file is double-clicked — the download lands here. */
    get currentPath (): string {
        return this.path
    }

    /**
     * The two display toggles the remote list already honours. Both panes are
     * the same kind of table, and the shared stylesheet has rules for both, so
     * reading the same settings is what keeps them looking alike.
     */
    get showColumnBorders (): boolean {
        return this.config.store.sidebarPlus?.sftpColumnBorders ?? false
    }

    get showZebra (): boolean {
        return this.config.store.sidebarPlus?.sftpZebra ?? false
    }

    trackByPath = (_index: number, row: LocalRow): string => row.fullPath

    trackSegment = (_index: number, segment: { path: string }): string => segment.path

    /** Public so the host can show a file that just arrived without rebuilding the pane. */
    async refresh (): Promise<void> {
        await this.navigate(this.path)
    }

    async navigate (newPath: string): Promise<void> {
        const target = path.resolve(newPath)
        const request = ++this.navigateRequestId
        await this.zone.run(async () => {
            this.loading = true
            this.error = null
            try {
                const entries = await fs.promises.readdir(target, { withFileTypes: true })
                const rows = (await Promise.all(entries.map(entry => this.toRow(target, entry))))
                    .filter((row): row is LocalRow => row !== null)
                if (request !== this.navigateRequestId) {
                    return
                }
                this.path = target
                this.rows = rows.sort((a, b) => {
                    if (a.isDirectory !== b.isDirectory) {
                        return a.isDirectory ? -1 : 1
                    }
                    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
                })
                this.selectedPath = null
                this.updatePathMeta()
            } catch (e) {
                if (request !== this.navigateRequestId) {
                    return
                }
                // Keep the previous directory on screen: a typo in the path editor
                // must not cost the user the place they were browsing.
                this.error = `${this.i18n.t('Could not read {path}', { path: target })} — ${String((e as Error)?.message ?? e)}`
            } finally {
                if (request === this.navigateRequestId) {
                    this.loading = false
                }
            }
        })
    }

    select (row: LocalRow): void {
        this.selectedPath = row.fullPath
    }

    /** Double-click: directories navigate, files ask the host to upload them. */
    open (row: LocalRow): void {
        this.selectedPath = row.fullPath
        if (row.isDirectory) {
            void this.navigate(row.fullPath)
            return
        }
        this.uploadRequest.emit(row.fullPath)
    }

    goUp (): void {
        if (this.canGoUp) {
            void this.navigate(path.dirname(this.path))
        }
    }

    home (): void {
        void this.navigate(os.homedir())
    }

    editPath (): void {
        this.editingPath = this.path
    }

    cancelEditPath (): void {
        this.editingPath = null
    }

    async confirmPath (): Promise<void> {
        const target = this.editingPath?.trim()
        this.editingPath = null
        if (target) {
            await this.navigate(target)
        }
    }

    clearSelectionFromBackground (event: MouseEvent): void {
        if ((event.target as HTMLElement).closest('.sftp-row')) {
            return
        }
        this.selectedPath = null
    }

    /** Gives the pane keyboard focus without waiting for a tab stop to be reached by Tab. */
    focusPane (): void {
        this.elementRef.nativeElement.focus()
    }

    /**
     * `Delete` on the selected local entry.
     *
     * A host listener, not a document one: the remote browser already owns a
     * document-level Delete, and two of those would delete a remote file and a
     * local file on the same key. Focusing this pane (see focusPane()) makes
     * this listener the one that fires; stopping propagation keeps the
     * document-level remote handler out of it even when nothing local is
     * selected.
     */
    @HostListener('keydown', ['$event'])
    onKeydown (event: KeyboardEvent): void {
        if (event.key !== 'Delete' || event.ctrlKey || event.metaKey || event.altKey) {
            return
        }
        const target = event.target as HTMLElement
        if (target.closest('input, textarea, [contenteditable]')) {
            return
        }
        event.stopPropagation()
        const row = this.selectedRow()
        if (!row) {
            return
        }
        event.preventDefault()
        void this.confirmDelete(row)
    }

    onRowContextMenu (row: LocalRow, event: MouseEvent): void {
        event.preventDefault()
        event.stopPropagation()
        this.select(row)
        this.focusPane()
        const items: MenuItemOptions[] = []
        // Files are what a double-click sends to the remote pane. A folder has
        // no single-file transfer of its own (trees go through the remote
        // drop), so the entry is only offered where it means something.
        if (!row.isDirectory) {
            items.push({
                label: this.i18n.t('Send to the remote pane'),
                click: () => this.zone.run(() => this.uploadRequest.emit(row.fullPath)),
            })
        }
        items.push({
            label: this.i18n.t('Copy full path'),
            click: () => this.platform.setClipboard({ text: row.fullPath }),
        })
        items.push({
            label: this.i18n.t('Rename...'),
            click: () => this.zone.run(() => void this.renameRow(row)),
        })
        items.push({
            label: this.i18n.t('Delete'),
            click: () => this.zone.run(() => void this.confirmDelete(row)),
        })
        this.platform.popupContextMenu(items, event)
    }

    onBackgroundContextMenu (event: MouseEvent): void {
        event.preventDefault()
        this.selectedPath = null
        this.focusPane()
        const items: MenuItemOptions[] = [
            {
                label: this.i18n.t('Copy full path'),
                click: () => this.platform.setClipboard({ text: this.path }),
            },
            {
                label: this.i18n.t('New folder...'),
                click: () => this.zone.run(() => void this.createFolder()),
            },
            {
                label: this.i18n.t('Refresh'),
                click: () => this.zone.run(() => void this.refresh()),
            },
        ]
        this.platform.popupContextMenu(items, event)
    }

    private selectedRow (): LocalRow|null {
        return this.rows.find(row => row.fullPath === this.selectedPath) ?? null
    }

    private async confirmDelete (row: LocalRow): Promise<void> {
        if (this.deleteInFlight) {
            return
        }
        this.deleteInFlight = true
        try {
            const modal = this.ngbModal.open(ConfirmModalComponent)
            modal.componentInstance.message = row.isDirectory && !row.isSymlink
                ? this.i18n.t('Delete folder "{name}" and everything in it?', { name: row.name })
                : this.i18n.t('Delete "{name}"? This action is irreversible.', { name: row.name })
            modal.componentInstance.confirmLabel = this.i18n.t('Delete')
            modal.componentInstance.defaultButton = 'cancel'
            const confirmed = await modal.result.catch(() => false)
            if (!confirmed) {
                return
            }
            await fs.promises.rm(row.fullPath, { recursive: true, force: true })
            await this.refresh()
        } catch (e) {
            this.notices.error(this.i18n.t('Could not delete {name}', { name: row.name }), String(e))
        } finally {
            this.deleteInFlight = false
        }
    }

    private async renameRow (row: LocalRow): Promise<void> {
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = this.i18n.t('New name for "{name}"', { name: row.name })
        modal.componentInstance.value = row.name
        const result = await modal.result.catch(() => null)
        const name = result?.value?.trim()
        if (!name || name === row.name) {
            return
        }
        if (this.hasPathSeparator(name)) {
            this.notices.error(this.i18n.t('The name cannot contain path separators'))
            return
        }
        const target = path.join(this.path, name)
        if (await this.pathExists(target)) {
            this.notices.error(this.i18n.t('{name} already exists', { name }))
            return
        }
        try {
            await fs.promises.rename(row.fullPath, target)
            await this.refresh()
            this.zone.run(() => { this.selectedPath = target })
        } catch (e) {
            this.notices.error(this.i18n.t('Could not rename {name}', { name: row.name }), String(e))
        }
    }

    private async createFolder (): Promise<void> {
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = this.i18n.t('Folder name')
        const result = await modal.result.catch(() => null)
        const name = result?.value?.trim()
        if (!name) {
            return
        }
        if (this.hasPathSeparator(name)) {
            this.notices.error(this.i18n.t('The name cannot contain path separators'))
            return
        }
        const target = path.join(this.path, name)
        if (await this.pathExists(target)) {
            this.notices.error(this.i18n.t('{name} already exists', { name }))
            return
        }
        try {
            await fs.promises.mkdir(target)
            await this.refresh()
        } catch (e) {
            this.notices.error(this.i18n.t('Could not create {name}', { name }), String(e))
        }
    }

    /** `/` and `\` are both refused, whichever host this runs on: a rename is not a move. */
    private hasPathSeparator (name: string): boolean {
        return name.includes('/') || name.includes('\\')
    }

    /** `lstat`, not `existsSync`: a dangling symlink is still an occupied name. */
    private async pathExists (target: string): Promise<boolean> {
        return await fs.promises.lstat(target).then(() => true).catch(() => false)
    }

    /**
     * Breadcrumbs and the up/home buttons are built once per navigation rather
     * than from template getters: `pathSegments` used to be a getter returning
     * a fresh array, which `*ngFor` would diff on every change-detection pass.
     */
    private updatePathMeta (): void {
        const root = path.parse(this.path).root
        const segments = [{ name: root, path: root }]
        let current = root
        for (const part of this.path.slice(root.length).split(path.sep).filter(Boolean)) {
            current = path.join(current, part)
            segments.push({ name: part, path: current })
        }
        this.pathSegments = segments
        this.canGoUp = path.dirname(this.path) !== this.path
    }

    /**
     * One directory entry, with the information the list actually displays.
     *
     * `stat` follows a symlink while `lstat` describes the link itself, and the
     * pane needs both: the target's type and size decide navigation/transfer,
     * the link flag marks the row and `lstat` is what still works when the
     * target is gone. A vanished entry is skipped rather than rendered with
     * invented figures.
     */
    private async toRow (dir: string, entry: fs.Dirent): Promise<LocalRow|null> {
        const fullPath = path.join(dir, entry.name)
        const linkInfo = await fs.promises.lstat(fullPath).catch(() => null)
        if (!linkInfo) {
            return null
        }
        const isSymlink = linkInfo.isSymbolicLink()
        const targetInfo = isSymlink
            ? await fs.promises.stat(fullPath).catch(() => null)
            : null
        const broken = isSymlink && targetInfo === null
        const info = targetInfo ?? linkInfo
        const isDirectory = info.isDirectory()
        const size = isDirectory ? 0 : info.size
        const modified = info.mtime
        const sizeLabel = isDirectory || broken ? '' : filesize(size)
        const icon = broken
            ? 'fas fa-unlink'
            : isDirectory
                ? 'fas fa-folder'
                : isSymlink ? 'fas fa-link' : 'fas fa-file-alt'
        return {
            name: entry.name,
            fullPath,
            isDirectory,
            isSymlink,
            broken,
            hidden: entry.name.startsWith('.'),
            icon,
            sizeLabel,
            dateLabel: modified.toLocaleString(undefined, {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
            }),
            tooltip: `${fullPath}\n${sizeLabel ? `${sizeLabel}\n` : ''}${modified.toLocaleString()}`,
        }
    }
}
