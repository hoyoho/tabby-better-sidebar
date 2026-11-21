/**
 * Remote path helpers.
 *
 * Pure so the guards around destructive operations can be tested without the
 * component, an SFTP session or Angular.
 */

/**
 * The remote path `name` renames `directory`'s entry to, or null when `name` is
 * not a plain name.
 *
 * A `/` is refused rather than quietly relocating the entry: `SFTPSession.rename()`
 * would happily accept a path, which is exactly why a rename must never become
 * a move.
 */
export function renameTargetPath (directory: string, name: string): string|null {
    if (!name || name.includes('/')) {
        return null
    }
    return directory.endsWith('/') ? `${directory}${name}` : `${directory}/${name}`
}
