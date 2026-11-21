import { test } from 'node:test'
import assert from 'node:assert/strict'

import { overwritePrompt } from '../src/sftpMessages.ts'

/** A translator that keeps the key and parameters visible, so branches are assertable. */
const t = (key, params) => JSON.stringify({ key, params })

test('overwritePrompt uses the singular sentence for one collision', () => {
    const text = JSON.parse(overwritePrompt(['a.txt'], '/w', t))
    assert.equal(text.key, 'A file already exists under {destination} and will be overwritten: {list}. Continue?')
    assert.equal(text.params.destination, '/w')
    assert.equal(text.params.list, 'a.txt')
})

test('overwritePrompt uses the plural sentence and counts the remainder past the named limit', () => {
    const text = JSON.parse(overwritePrompt(['a', 'b', 'c', 'd'], '/w', t, 2))
    assert.equal(text.key, '{count} files already exist under {destination} and will be overwritten: {list}. Continue?')
    assert.equal(text.params.count, 4)
    // The list itself is another translated clause, carrying the remainder count.
    const list = JSON.parse(text.params.list)
    assert.equal(list.params.names, 'a, b')
    assert.equal(list.params.rest, 2)
})

test('overwritePrompt spells every name out when the limit is not exceeded', () => {
    const text = JSON.parse(overwritePrompt(['a', 'b'], '/w', t, 5))
    assert.equal(text.params.list, 'a, b')
})
