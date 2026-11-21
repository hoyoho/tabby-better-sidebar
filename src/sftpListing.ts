import type { SFTPFile } from 'tabby-ssh'

/**
 * Pure projection of a directory listing into the rows the panel renders.
 *
 * Kept out of `SidebarPlusSftpBrowserComponent` so the ordering rules are
 * testable and the component only owns the caches that avoid re-diffing
 * Angular's `*ngFor` on every change-detection pass.
 */

export interface ListingDisplayOptions {
    showHidden: boolean
    foldersFirst: boolean
    locale: string
    /**
     * The panel's own dotfile rule. Defaults to "name starts with a dot", which
     * is exactly `sftpFormat.isHidden()` — passed in so this module stays
     * importable by Node's test runner without a local extension-qualified
     * import.
     */
    isHidden?: (file: SFTPFile) => boolean
}

/**
 * `filteredFileList` with the dotfiles dropped when asked, sorted the way the
 * panel displays it: folders first when enabled, then locale-aware and
 * case-insensitive by name.
 */
export function sortAndFilterListing (files: SFTPFile[], options: ListingDisplayOptions): SFTPFile[] {
    const isHidden = options.isHidden ?? (file => file.name.startsWith('.'))
    const result = files.filter(f => options.showHidden || !isHidden(f))
    result.sort((a, b) => {
        if (options.foldersFirst && a.isDirectory !== b.isDirectory) {
            return a.isDirectory ? -1 : 1
        }
        // Locale-aware and case-insensitive: readdir returns whatever
        // order the server felt like, which is rarely one a human reads.
        return a.name.localeCompare(b.name, options.locale, { sensitivity: 'base' })
    })
    return result
}

/**
 * Formats new rows, reusing any row whose `SFTPFile` object survived the last
 * listing merge.
 *
 * `applyListing()` keeps the existing entry object for every unchanged entry,
 * so after a refresh where one file changed, only that file is formatted again.
 */
export function reuseListingRows<TRow extends { item: SFTPFile }> (
    source: SFTPFile[],
    previous: TRow[],
    makeRow: (item: SFTPFile) => TRow,
): TRow[] {
    const byItem = new Map(previous.map(row => [row.item, row]))
    return source.map(item => byItem.get(item) ?? makeRow(item))
}
