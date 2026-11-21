import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { ConfigService, NotificationsService, PromptModalComponent } from 'tabby-core'
import { SFTPFile, SFTPPanelComponent } from 'tabby-ssh'
import { readRemoteEntry } from './remoteEntry'
import { SidebarPlusNoticesService } from './notices.service'
import { SidebarPlusI18nService } from './i18n'
import { ConfirmModalComponent } from './components/confirmModal.component'

/** The live SFTP transport, borrowed from the one member that publicly exposes its type. */
type SftpSession = SFTPPanelComponent['sftp']

/**
 * What the delete/rename controller needs from the browser component.
 *
 * Selection lives on the component — the template and the click handlers own
 * it — so it is read and mutated through this host rather than duplicated.
 */
export interface SftpFileOperationsHost {
    getSftp: () => SftpSession
    getPath: () => string
    getSelection: () => Set<string>
    getSelectionAnchor: () => string|null
    setSelectionAnchor: (path: string|null) => void
    getSelectedItems: () => SFTPFile[]
    refreshListing: () => Promise<void>
    navigate: (path: string) => Promise<void>
    /** False while the panel is cached-but-detached for another SSH tab. */
    isPanelAttached: () => boolean
}

/** The remote path `item` is renamed to, or null when `name` is not a plain name. */
export function renameTargetPath (path: string, name: string): string|null {
    if (!name || name.includes('/')) {
        return null
    }
    return path.endsWith('/') ? `${path}${name}` : `${path}/${name}`
}

/**
 * Renames an entry in place and deletes one or several — including the
 * recursive directory walk — with the panel's own HTML confirmations.
 *
 * Kept out of `SidebarPlusSftpBrowserComponent` because all of it is one
 * destructive operation with several entry points (context menu, `Suppr`,
 * bulk entry), and the guard flag has to cover every one of them.
 */
export class SftpFileOperationsController {
    /**
     * Set for the duration of confirm-then-delete, from either trigger.
     * Without it, holding Delete re-fires the keydown handler at keyboard
     * repeat rate while the confirm modal is up (focus lands on one of its
     * *buttons*, not an input, so the input/textarea check doesn't help), and
     * a second click on the context menu entry before the first delete
     * finishes would race two deletions of the same path.
     */
    private deleteInFlight = false

    /** Read by the panel's auto-refresh, which must not re-list mid-deletion. */
    get isDeleting (): boolean {
        return this.deleteInFlight
    }

    constructor (
        private config: ConfigService,
        private ngbModal: NgbModal,
        private notify: NotificationsService,
        private notices: SidebarPlusNoticesService,
        private i18n: SidebarPlusI18nService,
        private host: SftpFileOperationsHost,
    ) { }

    /**
     * Renames a remote entry, extension included.
     *
     * The field is prefilled with the **whole** name rather than the stem: the
     * user asked to be able to change the extension, so it has to be there to
     * be edited. Nothing warns about changing it either — on a remote server
     * that is a deliberate act, not a slip.
     *
     * Only a rename, never a move: a `/` is refused rather than quietly
     * relocating the entry somewhere else. `rename()` would accept a path
     * happily, which is exactly why it is worth blocking here.
     */
    async renameEntry (item: SFTPFile): Promise<void> {
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = this.i18n.t('New name for "{name}"', { name: item.name })
        modal.componentInstance.value = item.name
        const result = await modal.result.catch(() => null)
        const name = result?.value?.trim()
        if (!name || name === item.name) {
            return
        }
        const target = renameTargetPath(this.host.getPath(), name)
        if (!target) {
            this.notices.error(this.i18n.t('The name cannot contain "/" — this renames, it does not move'))
            return
        }

        // Checked rather than left to the server: SFTP v3 lets an
        // implementation decide what a rename onto an existing name does, and
        // some overwrite it. Refusing outright is the only answer that cannot
        // destroy something.
        if (await readRemoteEntry(this.host.getSftp(), target)) {
            this.notices.error(this.i18n.t('{name} already exists in this folder', { name }))
            return
        }

        try {
            await this.host.getSftp().rename(item.fullPath, target)
        } catch (e) {
            this.notices.error(this.i18n.t('Could not rename {name}', { name: item.name }), String(e))
            return
        }

        // The selection follows the entry rather than being dropped: the file
        // the user was working on is still the one they are working on.
        const selection = this.host.getSelection()
        if (selection.has(item.fullPath)) {
            selection.delete(item.fullPath)
            selection.add(target)
            if (this.host.getSelectionAnchor() === item.fullPath) {
                this.host.setSelectionAnchor(target)
            }
        }
        await this.host.refreshListing()
        this.notices.notice(this.i18n.t('{old} renamed to {new}', { old: item.name, new: name }))
    }

    /** `Suppr` on the selection — a single entry takes the same confirm-then-delete path as the context menu's "Supprimer", several take the bulk one further down. */
    onDocumentKeydown (event: KeyboardEvent): void {
        if (event.key !== 'Delete' || event.repeat || this.host.getSelection().size === 0 || this.deleteInFlight) {
            return
        }
        // Guards against firing while this panel is cached-but-detached for a
        // different SSH tab: the host calls `.remove()` on the root node rather
        // than merely hiding it (only the currently focused tab's browser is
        // ever attached to `document`), so `offsetParent` is reliably null on
        // every other cached instance.
        if (!this.host.isPanelAttached()) {
            return
        }
        const target = event.target as HTMLElement
        if (target.closest('input, textarea, [contenteditable]')) {
            return
        }
        // A local-pane Delete belongs to that pane's own host listener; if
        // propagation ever reaches here, never act on it.
        if (target.closest('sidebar-plus-sftp-local')) {
            return
        }
        // Any open modal — the local pane's delete confirmation included —
        // owns the keyboard. Without this, a second Delete would stack a
        // remote confirmation on top of the local one.
        if (document.querySelector('ngb-modal-window')) {
            return
        }
        const items = this.host.getSelectedItems()
        if (items.length === 1) {
            void this.confirmAndDelete(items[0])
        } else if (items.length > 1) {
            void this.confirmAndDeleteSelection(items)
        }
    }

    async confirmAndDelete (item: SFTPFile): Promise<void> {
        if (this.deleteInFlight) {
            return
        }
        this.deleteInFlight = true
        try {
            await this.runDeleteConfirmation(item)
        } finally {
            this.deleteInFlight = false
        }
    }

    private async runDeleteConfirmation (item: SFTPFile): Promise<void> {
        const modal = this.ngbModal.open(ConfirmModalComponent)
        modal.componentInstance.message = item.isDirectory
            ? this.i18n.t('Delete folder "{name}" and everything in it?', { name: item.name })
            : this.i18n.t('Confirm deletion of "{name}"?', { name: item.name })
        modal.componentInstance.confirmLabel = this.i18n.t('Delete')
        // Which button `Entrée` hits, from the settings tab. Applied to both
        // triggers, not just the `Suppr` key that prompted the request: the
        // same modal answering the same question differently depending on how
        // it was opened would be a trap, not a feature.
        modal.componentInstance.defaultButton = this.config.store.sidebarPlus?.sftpDeleteDefaultButton ?? 'cancel'
        const confirmed = await modal.result.catch(() => false)
        if (!confirmed) {
            return
        }
        try {
            await this.deleteRecursive(item)
            this.notices.notice(this.i18n.t('{name} deleted', { name: item.name }))
            this.host.getSelection().delete(item.fullPath)
            await this.host.navigate(this.host.getPath())
        } catch (e) {
            this.notify.error(this.i18n.t('Could not delete {name}', { name: item.name }), String(e))
        }
    }

    /**
     * `Suppr` / context menu "Supprimer la sélection (N)" when more than one
     * entry is selected. One confirmation for the whole batch — a count and
     * an irreversibility reminder, since it now stands in for every item —
     * then the same `deleteRecursive()` as the single-entry path above,
     * sequentially rather than in parallel: a directory recursion already
     * issues many requests of its own, and racing several of those against
     * the same SFTP session is not a trade worth making for a background
     * operation. Same `deleteInFlight` guard as `confirmAndDelete()`, held for
     * the whole batch rather than re-acquired per entry.
     */
    async confirmAndDeleteSelection (items: SFTPFile[]): Promise<void> {
        if (this.deleteInFlight || items.length < 2) {
            return
        }
        this.deleteInFlight = true
        try {
            await this.runBulkDeleteConfirmation(items)
        } finally {
            this.deleteInFlight = false
        }
    }

    private async runBulkDeleteConfirmation (items: SFTPFile[]): Promise<void> {
        const modal = this.ngbModal.open(ConfirmModalComponent)
        modal.componentInstance.message = this.i18n.t('Delete {count} items? This action is irreversible.', { count: items.length })
        modal.componentInstance.confirmLabel = this.i18n.t('Delete')
        modal.componentInstance.defaultButton = this.config.store.sidebarPlus?.sftpDeleteDefaultButton ?? 'cancel'
        const confirmed = await modal.result.catch(() => false)
        if (!confirmed) {
            return
        }

        // Per-entry arbitration, exactly as the single-item path above: one
        // failure is reported and skipped rather than aborting entries that
        // were perfectly fine.
        let succeeded = 0
        let firstError: string|null = null
        for (const item of items) {
            try {
                await this.deleteRecursive(item)
                succeeded++
                this.host.getSelection().delete(item.fullPath)
            } catch (e) {
                firstError = firstError ?? this.i18n.t('{name}: {error}', { name: item.name, error: String(e) })
            }
        }

        const failed = items.length - succeeded
        if (failed === 0) {
            this.notices.notice(this.i18n.t('{count} items deleted', { count: succeeded }))
        } else {
            this.notices.error(this.i18n.t('{succeeded} deleted, {failed} failed', { succeeded, failed }), firstError ?? undefined)
        }
        await this.host.navigate(this.host.getPath())
    }

    /** Same recursion as the native (non-exported) `SFTPDeleteModalComponent.run()` — no progress UI. Shared by the single-entry and the bulk delete above, entry by entry either way. */
    private async deleteRecursive (item: SFTPFile): Promise<void> {
        const sftp = this.host.getSftp()
        if (item.isDirectory) {
            for (const child of await sftp.readdir(item.fullPath)) {
                await this.deleteRecursive(child)
            }
            await sftp.rmdir(item.fullPath)
        } else {
            await sftp.unlink(item.fullPath)
        }
    }
}
