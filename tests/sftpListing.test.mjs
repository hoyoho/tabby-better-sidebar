import { test } from 'node:test'
import assert from 'node:assert/strict'

import { reuseListingRows, sortAndFilterListing } from '../src/sftpListing.ts'

function entry (name, { dir = false } = {}) {
    return { name, fullPath: `/w/${name}`, isDirectory: dir, isSymlink: false, mode: 0o644, size: 1, modified: new Date(0) }
}

test('sortAndFilterListing drops hidden files unless asked for them', () => {
    const files = [entry('.env'), entry('b.txt'), entry('a.txt')]
    assert.deepEqual(sortAndFilterListing(files, { showHidden: false, foldersFirst: false, locale: 'en' }).map(f => f.name), ['a.txt', 'b.txt'])
    assert.equal(sortAndFilterListing(files, { showHidden: true, foldersFirst: false, locale: 'en' }).length, 3)
})

test('sortAndFilterListing keeps folders first only when enabled', () => {
    const files = [entry('z.txt'), entry('a-dir', { dir: true }), entry('b.txt')]
    assert.deepEqual(
        sortAndFilterListing(files, { showHidden: true, foldersFirst: true, locale: 'en' }).map(f => f.name),
        ['a-dir', 'b.txt', 'z.txt'],
    )
    assert.deepEqual(
        sortAndFilterListing(files, { showHidden: true, foldersFirst: false, locale: 'en' }).map(f => f.name),
        ['a-dir', 'b.txt', 'z.txt'],
    )
})

test('sortAndFilterListing is case-insensitive', () => {
    const files = [entry('Beta'), entry('alpha')]
    assert.deepEqual(
        sortAndFilterListing(files, { showHidden: true, foldersFirst: false, locale: 'en' }).map(f => f.name),
        ['alpha', 'Beta'],
    )
})

test('reuseListingRows reuses the row of an unchanged entry object', () => {
    const a = entry('a')
    const b = entry('b')
    const previous = [{ item: a, label: 'old-a' }, { item: b, label: 'old-b' }]
    const rows = reuseListingRows([a, b], previous, item => ({ item, label: `new-${item.name}` }))
    assert.equal(rows[0], previous[0])
    assert.equal(rows[1], previous[1])
})

test('reuseListingRows formats only the entries that changed identity', () => {
    const a = entry('a')
    const previous = [{ item: a, label: 'old-a' }]
    const b = entry('b')
    const rows = reuseListingRows([a, b], previous, item => ({ item, label: `new-${item.name}` }))
    assert.equal(rows[0].label, 'old-a')
    assert.equal(rows[1].label, 'new-b')
})
