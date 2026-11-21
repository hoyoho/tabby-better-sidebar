import { test } from 'node:test'
import assert from 'node:assert/strict'

import { canMoveSourcesTo, destinationFor, isSelfOrDescendant, planFromEntries } from '../src/sftpDropModel.ts'

function entry (name, fullPath = `/w/${name}`, dir = false) {
    return { name, fullPath, isDirectory: dir, isSymlink: false, mode: 0o644, size: 1, modified: new Date(0) }
}

test('destinationFor resolves the current directory, the up row and a folder row', () => {
    assert.equal(destinationFor('/w', null), '/w')
    assert.equal(destinationFor('/w/sub', 'up'), '/w')
    assert.equal(destinationFor('/w', entry('target', '/w/target', true)), '/w/target')
})

test('isSelfOrDescendant respects the separator', () => {
    assert.equal(isSelfOrDescendant('/tmp/a', '/tmp/a'), true)
    assert.equal(isSelfOrDescendant('/tmp/a', '/tmp/a/b'), true)
    assert.equal(isSelfOrDescendant('/tmp/a', '/tmp/ab'), false)
    assert.equal(isSelfOrDescendant('/tmp/a/', '/tmp/a/b'), true)
})

test('canMoveSourcesTo refuses an empty source, the same parent and a self-descendant move', () => {
    const file = entry('x', '/w/sub/x')
    assert.equal(canMoveSourcesTo([], '/w/other'), false)
    assert.equal(canMoveSourcesTo([file], '/w/sub'), false)
    assert.equal(canMoveSourcesTo([entry('d', '/w/sub', true)], '/w/sub/d'), false)
    assert.equal(canMoveSourcesTo([file], '/w/other'), true)
})

function fileEntry (name) {
    return { isFile: true, isDirectory: false, name, file: resolve => resolve({ name }) }
}

function dirEntry (name, children) {
    return {
        isFile: false,
        isDirectory: true,
        name,
        createReader: () => {
            let served = false
            return {
                readEntries: (resolve) => {
                    if (served) {
                        resolve([])
                        return
                    }
                    served = true
                    resolve(children)
                },
            }
        },
    }
}

test('planFromEntries walks directories depth-first and keeps parents before children', async () => {
    const tree = [
        fileEntry('notes.txt'),
        dirEntry('pkg', [
            dirEntry('inner', [fileEntry('deep.txt')]),
            fileEntry('one.txt'),
        ]),
    ]
    const plan = await planFromEntries(tree, '/remote')
    assert.deepEqual(plan.directories, ['/remote/pkg', '/remote/pkg/inner'])
    assert.deepEqual(plan.files.map(f => f.remotePath), ['/remote/notes.txt', '/remote/pkg/inner/deep.txt', '/remote/pkg/one.txt'])
})
