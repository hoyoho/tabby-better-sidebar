import { test } from 'node:test'
import assert from 'node:assert/strict'

import { clampPanelWidth, DEFAULT_PANEL_WIDTH, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, readStoredWidth, SidebarResizeController, writeStoredWidth } from '../src/sidebarResize.ts'

function fakeStorage (initial = {}) {
    const values = { ...initial }
    return {
        values,
        getItem: key => (key in values ? values[key] : null),
        setItem: (key, value) => { values[key] = value },
    }
}

test('clampPanelWidth repairs NaN, too-small and too-large values', () => {
    assert.equal(clampPanelWidth(NaN), DEFAULT_PANEL_WIDTH)
    assert.equal(clampPanelWidth(100), PANEL_MIN_WIDTH)
    assert.equal(clampPanelWidth(700), PANEL_MAX_WIDTH)
    assert.equal(clampPanelWidth(100, 0), 100)
})

test('readStoredWidth falls back to the default for missing or invalid values', () => {
    assert.equal(readStoredWidth(fakeStorage()), DEFAULT_PANEL_WIDTH)
    assert.equal(readStoredWidth(fakeStorage({ sidebarPlusTreeWidth: 'abc' })), DEFAULT_PANEL_WIDTH)
    assert.equal(readStoredWidth(fakeStorage({ sidebarPlusTreeWidth: '450' })), 450)
})

test('writeStoredWidth only writes on change', () => {
    const storage = fakeStorage({ sidebarPlusTreeWidth: '300' })
    let writes = 0
    const originalSet = storage.setItem
    storage.setItem = (key, value) => { writes++; originalSet(key, value) }
    writeStoredWidth(storage, 300)
    assert.equal(writes, 0)
    writeStoredWidth(storage, 320)
    assert.equal(writes, 1)
    assert.equal(storage.values.sidebarPlusTreeWidth, '320')
})

test('a resize previews through the grabber and commits once', () => {
    const storage = fakeStorage({ sidebarPlusTreeWidth: '300' })
    const commits = []
    const cursors = []
    const resize = new SidebarResizeController(storage, {
        onCommit: (width, collapsed) => commits.push({ width, collapsed }),
        setCursor: resizing => cursors.push(resizing),
    })

    resize.start(500)
    assert.equal(resize.isResizing, true)
    assert.deepEqual(cursors, [true])
    resize.move(560)
    assert.equal(resize.grabberTransform, 'translateX(60px)')
    assert.equal(resize.width, 300)

    resize.commit()
    assert.equal(resize.isResizing, false)
    assert.equal(resize.grabberTransform, null)
    assert.equal(resize.width, 360)
    assert.deepEqual(commits, [{ width: 360, collapsed: false }])
    assert.equal(storage.values.sidebarPlusTreeWidth, '360')
    assert.deepEqual(cursors, [true, false])
})

test('releasing inside the collapse zone reports a collapsed commit and keeps a usable width', () => {
    const storage = fakeStorage({ sidebarPlusTreeWidth: '300' })
    const commits = []
    const resize = new SidebarResizeController(storage, {
        onCommit: (width, collapsed) => commits.push({ width, collapsed }),
        setCursor: () => undefined,
    })

    resize.start(500)
    resize.move(210)
    resize.commit()

    assert.deepEqual(commits, [{ width: PANEL_MIN_WIDTH, collapsed: true }])
    assert.equal(resize.width, PANEL_MIN_WIDTH)
    assert.equal(storage.values.sidebarPlusTreeWidth, String(PANEL_MIN_WIDTH))
})

test('cancel drops the gesture without committing', () => {
    const storage = fakeStorage({ sidebarPlusTreeWidth: '300' })
    const commits = []
    const cursors = []
    const resize = new SidebarResizeController(storage, {
        onCommit: (width, collapsed) => commits.push({ width, collapsed }),
        setCursor: resizing => cursors.push(resizing),
    })

    resize.start(500)
    resize.move(560)
    resize.cancel()

    assert.equal(resize.isResizing, false)
    assert.deepEqual(commits, [])
    assert.deepEqual(cursors, [true, false])
    assert.equal(resize.width, 300)
})

test('clampAndPersist repairs an out-of-range stored width', () => {
    const storage = fakeStorage({ sidebarPlusTreeWidth: '1000' })
    const resize = new SidebarResizeController(storage, {
        onCommit: () => undefined,
        setCursor: () => undefined,
    })
    assert.equal(resize.width, 1000)
    resize.clampAndPersist()
    assert.equal(resize.width, PANEL_MAX_WIDTH)
    assert.equal(storage.values.sidebarPlusTreeWidth, String(PANEL_MAX_WIDTH))
})
