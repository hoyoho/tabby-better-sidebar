import { posix } from 'path'
import type { SFTPFile } from 'tabby-ssh'

/**
 * Pure geometry and planning for the SFTP drop gestures: where a drop lands,
 * whether a move is legal at all, and what a dropped directory contains.
 *
 * Kept apart from `SftpDropController` so all of it can be unit-tested without
 * a DOM, an SFTP session or Angular.
 */

/**
 * What a row puts on the clipboard when it is dragged inside the panel.
 *
 * A type of our own is what tells an internal move from files coming in from
 * the OS — never the cursor's position, which says nothing about what is being
 * carried. Chromium hands custom types back verbatim within the same window,
 * and ignores them everywhere else, so the same gesture can announce this *and*
 * a `DownloadURL` for the OS without either reading the other's.
 *
 * Its value is the entry's full remote path. Read at the drop and compared to
 * the source the panel remembers: `getData()` answers an empty string during
 * `dragover` (only `types` is readable there), so the live field is what the
 * highlight is computed from, and this is what confirms it at the end.
 */
export const INTERNAL_DRAG_TYPE = 'application/x-tabby-sftp-path'

/** One file of a drop, and the remote path it is headed for. */
export interface PlannedUpload {
    file: File
    remotePath: string
}

/** A whole drop, flattened: the directories to create, then the files to send. */
export interface DropPlan {
    /** Parents before children — `planFromEntries()` walks the tree depth-first, so the order is already right. */
    directories: string[]
    files: PlannedUpload[]
}

/**
 * Reads a dropped directory **whole**.
 *
 * `readEntries()` answers with a slice, not a listing — 100 entries at a time
 * in Chromium — and the only end-of-listing signal the API gives is an empty
 * answer. So it has to be called until it returns nothing.
 */
export function readAllEntries (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
    return new Promise((resolve, reject) => {
        const all: FileSystemEntry[] = []
        const step = (): void => reader.readEntries(batch => {
            if (!batch.length) {
                resolve(all)
                return
            }
            all.push(...batch)
            step()
        }, reject)
        step()
    })
}

/** The callback-style `FileSystemFileEntry.file()`, awaited. */
export function entryFile (entry: FileSystemFileEntry): Promise<File> {
    return new Promise((resolve, reject) => entry.file(resolve, reject))
}

/** Flattens what was dropped into what has to be created and what has to be sent. */
export async function planFromEntries (entries: FileSystemEntry[], base: string): Promise<DropPlan> {
    const plan: DropPlan = { directories: [], files: [] }
    const walk = async (entry: FileSystemEntry, at: string): Promise<void> => {
        if (entry.isFile) {
            plan.files.push({
                file: await entryFile(entry as FileSystemFileEntry),
                remotePath: posix.join(at, entry.name),
            })
            return
        }
        if (!entry.isDirectory) {
            return
        }
        const directory = posix.join(at, entry.name)
        plan.directories.push(directory)
        for (const child of await readAllEntries((entry as FileSystemDirectoryEntry).createReader())) {
            await walk(child, directory)
        }
    }
    for (const entry of entries) {
        await walk(entry, base)
    }
    return plan
}

/** Whether a path is the other one or lives underneath it. */
export function isSelfOrDescendant (ancestor: string, candidate: string): boolean {
    return candidate === ancestor || candidate.startsWith(ancestor.endsWith('/') ? ancestor : `${ancestor}/`)
}

/**
 * Where a drop would land, given the directory on screen and the aimed row.
 * Pure so the `dragover`-rate decision can be tested without a DOM.
 */
export function destinationFor (currentPath: string, aimed: SFTPFile|'up'|null): string {
    if (aimed === null) {
        return currentPath
    }
    if (aimed === 'up') {
        return posix.dirname(currentPath)
    }
    return aimed.fullPath
}

/** Whether a set of dragged rows could land in `destination` at all. */
export function canMoveSourcesTo (sources: SFTPFile[], destination: string): boolean {
    if (!sources.length) {
        return false
    }
    // Already there. The common one by far: the pointer spends most of a
    // drag over rows that are not directories, all of which aim at the
    // directory the entry is already in. Every dragged row comes from the
    // same listing, so they share that parent — checking the first is
    // checking them all.
    if (posix.dirname(sources[0].fullPath) === destination) {
        return false
    }
    return sources.every(source => !isSelfOrDescendant(source.fullPath, destination))
}
