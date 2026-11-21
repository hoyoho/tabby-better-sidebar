import { filesize } from 'filesize'
import type { SFTPFile } from 'tabby-ssh'

/**
 * Pure display helpers for the SFTP listing.
 *
 * They are kept out of `SidebarPlusSftpBrowserComponent` so the formatting
 * rules can be unit-tested and reused by any other view that renders an
 * `SFTPFile` — none of them needs Angular, the translator or the filesystem.
 */

export interface ModeInfo {
    mode: number
    isDirectory: boolean
    isSymlink: boolean
}

export interface NameInfo {
    name: string
    isDirectory: boolean
}

export function humanSize (bytes: number): string {
    return filesize(bytes, { round: 1 }) as string
}

/** Permissions as the octal triplet (`755`, `644`), the form actually used when typing a chmod. */
export function octalMode (item: Pick<ModeInfo, 'mode'>): string {
    // eslint-disable-next-line no-bitwise
    return (item.mode & 0o777).toString(8).padStart(3, '0')
}

/**
 * The `drwxrwxr-x` form, computed here rather than through the inherited
 * `getModeString()`.
 *
 * That one masks `item.mode` against Node's `constants.S_IXUSR`,
 * `S_IRGRP`, `S_IWOTH` and friends — and **Windows only defines
 * `S_IRUSR`, `S_IWUSR` and `S_IFDIR`**. The rest come back `undefined`,
 * `mode & undefined` is 0, and every one of those bits renders as a dash:
 * a 775 directory displays as `drw-------` on Windows, regardless of its
 * real permissions. Verified against this very panel on 2026-07-29.
 */
export function longMode (item: ModeInfo): string {
    const type = item.isDirectory ? 'd' : item.isSymlink ? 'l' : '-'
    const flags = 'rwxrwxrwx'
    let out = type
    for (let i = 0; i < flags.length; i++) {
        // Bit 8 is the owner's read flag (0o400) down to bit 0, other's execute.
        // eslint-disable-next-line no-bitwise
        out += item.mode & 1 << flags.length - 1 - i ? flags[i] : '-'
    }
    return out
}

export function extension (item: NameInfo): string {
    if (item.isDirectory) {
        return ''
    }
    // A leading dot is the name of a hidden file, not an extension:
    // `.bashrc` has none.
    const at = item.name.lastIndexOf('.')
    return at > 0 ? item.name.slice(at + 1) : ''
}

/**
 * Dotfiles. Dimmed when shown, and shown by default: the `sftpShowHidden`
 * toggle in the header menu is what decides, `displayedFiles` filtering them
 * out when it is off.
 */
export function isHidden (item: Pick<NameInfo, 'name'>): boolean {
    return item.name.startsWith('.')
}

/**
 * Date only, no time — the full timestamp lives in the row tooltip.
 *
 * The locale is passed in rather than left to the JS default: Electron reports
 * en-US whatever the OS says, which would put `7/23/2026` in an otherwise
 * French panel — and, worse, silently swap day and month.
 */
export function shortDate (value: Date|string|number, locale: string): string {
    const d = value instanceof Date ? value : new Date(value)
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString(locale)
}

export function fullDate (value: Date|string|number, locale: string): string {
    const d = value instanceof Date ? value : new Date(value)
    return isNaN(d.getTime()) ? '' : d.toLocaleString(locale)
}

/**
 * Whether two listings describe the same entry. Used by the auto-refresh to
 * keep the rendered rows stable when nothing changed.
 */
export function sameEntry (a: SFTPFile, b: SFTPFile): boolean {
    return a.size === b.size
        && a.modified.getTime() === b.modified.getTime()
        && a.mode === b.mode
        && a.isDirectory === b.isDirectory
        && a.isSymlink === b.isSymlink
}
