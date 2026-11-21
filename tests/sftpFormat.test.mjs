import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extension, fullDate, humanSize, isHidden, longMode, octalMode, sameEntry, shortDate } from '../src/sftpFormat.ts'

test('octalMode masks to the permission bits', () => {
    assert.equal(octalMode({ mode: 0o100755 }), '755')
    assert.equal(octalMode({ mode: 0o644 }), '644')
})

test('longMode renders directory, symlink and file type characters', () => {
    assert.equal(longMode({ mode: 0o40755, isDirectory: true, isSymlink: false }), 'drwxr-xr-x')
    assert.equal(longMode({ mode: 0o120777, isDirectory: false, isSymlink: true }), 'lrwxrwxrwx')
    assert.equal(longMode({ mode: 0o644, isDirectory: false, isSymlink: false }), '-rw-r--r--')
})

test('extension ignores hidden files and directories', () => {
    assert.equal(extension({ name: '.bashrc', isDirectory: false }), '')
    assert.equal(extension({ name: 'archive.tar.gz', isDirectory: false }), 'gz')
    assert.equal(extension({ name: 'folder.ext', isDirectory: true }), '')
})

test('isHidden only matches dotfiles', () => {
    assert.equal(isHidden({ name: '.config' }), true)
    assert.equal(isHidden({ name: 'config' }), false)
})

test('humanSize formats bytes', () => {
    assert.equal(humanSize(0), '0 B')
    assert.equal(humanSize(1536), '1.5 kB')
})

test('shortDate and fullDate return an empty string for invalid dates', () => {
    assert.equal(shortDate('not a date', 'en-US'), '')
    assert.equal(fullDate('not a date', 'en-US'), '')
    assert.match(shortDate(new Date('2026-07-23T12:00:00Z'), 'en-US'), /2026/)
})

test('sameEntry compares the listing-relevant fields', () => {
    const entry = { name: 'a', fullPath: '/a', size: 1, modified: new Date(1000), mode: 0o644, isDirectory: false, isSymlink: false }
    assert.equal(sameEntry(entry, { ...entry }), true)
    assert.equal(sameEntry(entry, { ...entry, size: 2 }), false)
    assert.equal(sameEntry(entry, { ...entry, modified: new Date(2000) }), false)
})
