import { test } from 'node:test'
import assert from 'node:assert/strict'

import { groupIdFromContainerId, intoCollapsable, isSelfOrDescendant, isSyntheticGroupId, moveSelectionWithinArray, parentGroupIdFromGroupContainerId, renameOrderKey, sortGroupIdsByDepthDesc } from '../src/sidebarTreeModel.ts'

test('container ids decode to group ids', () => {
    assert.equal(groupIdFromContainerId('profiles-abc'), 'abc')
    assert.equal(parentGroupIdFromGroupContainerId('groups-root'), null)
    assert.equal(parentGroupIdFromGroupContainerId('groups-abc'), 'abc')
})

test('view groups are recognised as synthetic', () => {
    assert.equal(isSyntheticGroupId('favorites'), true)
    assert.equal(isSyntheticGroupId('search'), true)
    assert.equal(isSyntheticGroupId('ungrouped'), false)
})

test('intoCollapsable copies the group and sets the flag', () => {
    const group = { id: 'a', name: 'A' }
    const collapsable = intoCollapsable(group, true)
    assert.equal(collapsable.id, 'a')
    assert.equal(collapsable.name, 'A')
    assert.equal(collapsable.collapsed, true)
    assert.notEqual(collapsable, group)
})

test('sortGroupIdsByDepthDesc puts the deepest groups first', () => {
    const groups = [
        { id: 'a' },
        { id: 'b', parentGroupId: 'a' },
        { id: 'c', parentGroupId: 'b' },
    ]
    assert.deepEqual(sortGroupIdsByDepthDesc(groups), ['groups-c', 'groups-b', 'groups-a'])
})

test('moveSelectionWithinArray moves the whole selection as one block', () => {
    const data = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
    moveSelectionWithinArray(data, new Set(['b', 'c']), 4, null)
    assert.deepEqual(data.map(p => p.id), ['a', 'd', 'b', 'c'])
})

test('moveSelectionWithinArray anchors below the hovered unselected row', () => {
    const data = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
    moveSelectionWithinArray(data, new Set(['b', 'c']), 0, 'd')
    assert.deepEqual(data.map(p => p.id), ['a', 'd', 'b', 'c'])
})

test('renameOrderKey renames both values and the parent key', () => {
    const order = { root: ['a', 'b'], a: ['c'] }
    renameOrderKey(order, 'a', 'x')
    assert.deepEqual(order, { root: ['x', 'b'], x: ['c'] })
})

test('isSelfOrDescendant walks the parent chain', () => {
    const groups = [{ id: 'a' }, { id: 'b', parentGroupId: 'a' }, { id: 'c', parentGroupId: 'b' }]
    assert.equal(isSelfOrDescendant('c', 'a', groups), true)
    assert.equal(isSelfOrDescendant('a', 'c', groups), false)
    assert.equal(isSelfOrDescendant('a', 'a', groups), true)
    assert.equal(isSelfOrDescendant('missing', 'a', groups), false)
})
