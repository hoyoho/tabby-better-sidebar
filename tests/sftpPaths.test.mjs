import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renameTargetPath } from '../src/sftpPaths.ts'

test('renameTargetPath joins a plain name onto the current directory', () => {
    assert.equal(renameTargetPath('/w/sub', 'a.txt'), '/w/sub/a.txt')
})

test('renameTargetPath does not double the separator', () => {
    assert.equal(renameTargetPath('/w/sub/', 'a.txt'), '/w/sub/a.txt')
})

test('renameTargetPath refuses names that would turn a rename into a move', () => {
    assert.equal(renameTargetPath('/w', '../etc/passwd'), null)
    assert.equal(renameTargetPath('/w', 'sub/a.txt'), null)
    assert.equal(renameTargetPath('/w', ''), null)
})
