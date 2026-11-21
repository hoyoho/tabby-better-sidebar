import type { PartialProfile, PartialProfileGroup, Profile, ProfileGroup } from 'tabby-core'

/**
 * Pure tree-model helpers for the sidebar.
 *
 * These know nothing about Angular, the config store or the DOM: they parse
 * CDK container ids, order groups by nesting depth, move a multi-selection
 * inside a profile array, and keep the workspace order maps coherent. Kept in
 * one module so the rules can be tested and, later, shared with a drag/drop
 * controller.
 */

export interface CollapsableProfileGroup extends ProfileGroup {
    collapsed: boolean
    children: PartialProfileGroup<CollapsableProfileGroup>[]
}

export function intoCollapsable (group: PartialProfileGroup<ProfileGroup>, collapsed: boolean): PartialProfileGroup<CollapsableProfileGroup> {
    return { ...group, collapsed } as PartialProfileGroup<CollapsableProfileGroup>
}

export function groupIdFromContainerId (containerId: string): string {
    return containerId.replace(/^profiles-/, '')
}

/**
 * Group ids that name a view, not a folder.
 *
 * Their rows live in real folders elsewhere — "Épinglés" gathers pinned
 * profiles from anywhere, the search group flattens the whole tree — so
 * their displayed order describes nothing that can be written back.
 * `ungrouped` is deliberately absent: it really is where profiles with no
 * group live, and its order is theirs.
 */
const SYNTHETIC_GROUP_IDS = ['favorites', 'search']

export function isSyntheticGroupId (groupId: string): boolean {
    return SYNTHETIC_GROUP_IDS.includes(groupId)
}

/** `groups-<id>` → that group's id, `groups-root` → null (the shape persistGroupOrder() expects for the root level). */
export function parentGroupIdFromGroupContainerId (containerId: string): string|null {
    const id = containerId.replace(/^groups-/, '')
    return id === 'root' ? null : id
}

/**
 * CDK resolves a drop's target container by walking this array in order and
 * taking the FIRST connected list whose element contains the drop point.
 * Every nested `groups-<id>` list is rendered *inside* `#groups-root`
 * (recursive template), so `#groups-root`'s element DOM-contains all of them —
 * if it came first (as it used to), it always won, and a folder drag could
 * never register as entering a nested folder no matter how precisely the user
 * targeted it. Deepest-nested groups must be checked first, `groups-root`
 * last, so an ancestor list never shadows a descendant one it happens to
 * contain.
 */
export function sortGroupIdsByDepthDesc (groups: PartialProfileGroup<ProfileGroup>[]): string[] {
    const byId = new Map(groups.map(g => [g.id, g]))
    const depthCache = new Map<string, number>()
    const depthOf = (id: string): number => {
        if (depthCache.has(id)) {
            return depthCache.get(id)!
        }
        const parentId = byId.get(id)?.parentGroupId
        const depth = parentId && byId.has(parentId) ? depthOf(parentId) + 1 : 0
        depthCache.set(id, depth)
        return depth
    }
    return [...groups].sort((a, b) => depthOf(b.id) - depthOf(a.id)).map(g => `groups-${g.id}`)
}

/**
 * Moves the selected profiles as one block, landing under `hoveredProfileId`
 * when it names a row, otherwise at the drop index.
 *
 * The index is computed against the array minus the whole selection rather
 * than against CDK's own `currentIndex`, which only accounts for the single
 * row it tracked.
 */
export function moveSelectionWithinArray (
    data: PartialProfile<Profile>[],
    selectedIds: Set<string>,
    targetIndex: number,
    hoveredProfileId: string|null,
): void {
    const isSelected = (p: PartialProfile<Profile>): boolean => !!p.id && selectedIds.has(p.id)
    const block = data.filter(isSelected)
    const rest = data.filter(p => !isSelected(p))

    let insertAt = -1
    if (hoveredProfileId) {
        const hoveredIndex = data.findIndex(p => p.id === hoveredProfileId)
        if (hoveredIndex !== -1) {
            // The hovered row may itself be part of the block — easy to hit
            // when dragging upwards, since the selected rows travel under the
            // cursor. Anchor on the nearest *unselected* row at or above it
            // instead of giving up: that row is what the block should land
            // beneath. None above at all means the block belongs at the top.
            let anchorIndex = -1
            for (let i = hoveredIndex; i >= 0; i--) {
                if (!isSelected(data[i])) {
                    anchorIndex = i
                    break
                }
            }
            if (anchorIndex === -1) {
                insertAt = 0
            } else {
                insertAt = rest.findIndex(p => p.id === data[anchorIndex].id) + 1
            }
        }
    }
    if (insertAt === -1) {
        insertAt = 0
        for (let i = 0; i < Math.min(targetIndex, data.length); i++) {
            if (!isSelected(data[i])) {
                insertAt++
            }
        }
    }
    rest.splice(insertAt, 0, ...block)
    // Spliced in place rather than reassigned: `data` is the very array the
    // template renders and CDK holds a reference to.
    data.splice(0, data.length, ...rest)
}

/** Renames `oldId` to `newId` both as a value wherever it appears in a sibling order list, and as the map's own parent key (siblings ordered *under* that group). */
export function renameOrderKey (order: Record<string, string[]>|undefined, oldId: string, newId: string): void {
    if (!order) {
        return
    }
    for (const key of Object.keys(order)) {
        const index = order[key].indexOf(oldId)
        if (index !== -1) {
            order[key][index] = newId
        }
    }
    if (order[oldId]) {
        order[newId] = order[oldId]
        delete order[oldId]
    }
}

/**
 * True if `candidateId` is `ancestorId` itself or nested somewhere under it
 * (used to block re-parenting a group into its own subtree).
 *
 * Callers pass the workspace-*unfiltered* group list: an ancestor chain that
 * happens to pass through a group hidden in the active workspace would
 * otherwise break the walk early and under-detect a genuine cycle.
 */
export function isSelfOrDescendant (candidateId: string, ancestorId: string, groups: PartialProfileGroup<ProfileGroup>[]): boolean {
    let current = groups.find(g => g.id === candidateId)
    while (current) {
        if (current.id === ancestorId) {
            return true
        }
        const parentId: string|undefined = current.parentGroupId
        current = parentId ? groups.find(g => g.id === parentId) : undefined
    }
    return false
}
