import { CdkDragDrop, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop'
import { NgZone } from '@angular/core'
import { ConfigService, NotificationsService, PartialProfile, PartialProfileGroup, Profile, ProfileGroup, ProfilesService } from 'tabby-core'
import { readProfileGroups } from './profileGroups'
import { SidebarPlusI18nService } from './i18n'
import { SidebarPlusSnippetsService } from './snippets.service'
import { SidebarWorkspace } from './configProvider'
import {
    CollapsableProfileGroup,
    groupIdFromContainerId,
    isSelfOrDescendant,
    isSyntheticGroupId,
    moveSelectionWithinArray,
    parentGroupIdFromGroupContainerId,
    renameOrderKey,
    sortGroupIdsByDepthDesc,
} from './sidebarTreeModel'

/**
 * What the drag controller needs to read from the component and write back.
 *
 * Everything is a callback rather than a value: the tree is replaced on every
 * `config.changed$`, so a stored array reference would go stale between two
 * drags.
 */
export interface TreeDragHost {
    getProfileGroups: () => PartialProfileGroup<ProfileGroup>[]
    getRawGroupsSnapshot: () => PartialProfileGroup<ProfileGroup>[]
    getActiveWorkspace: () => SidebarWorkspace|null
    getWorkspaces: () => SidebarWorkspace[]
    /** Mirrors the workspace array back onto `config.store.sidebarPlus.workspaces`. */
    publishWorkspaces: (workspaces: SidebarWorkspace[]) => void
    moveNote: (oldId: string, newId: string|null) => void
    setPreviewProfile: (profile: PartialProfile<Profile>|null) => void
    closeContextMenu: () => void
}

/**
 * Multi-selection, drag tracking and all reorder/reparent persistence for the
 * profile tree.
 *
 * Split out of `SidebarPlusTreeComponent` because these concerns share one
 * block of state — selected ids, the row under the pointer, the order maps —
 * and every mutation has to respect the same invariants (per-workspace order,
 * id migration on reparent, dead-id pruning). The component keeps only the
 * template-facing delegates.
 */
export class SidebarPlusTreeDragController {
    ////// MULTI-SELECTION (profiles only, never groups) //////
    /**
     * Ephemeral and never persisted — and deliberately a set of *ids* rather
     * than of profile objects. Every config.save() fires config.changed$ →
     * loadTreeItems(), which structuredClone()s the whole tree and hands back
     * brand-new profile objects; a set of references would therefore empty
     * itself silently the first time the user pinned a favorite mid-selection.
     */
    selectedProfileIds = new Set<string>()
    /** Where a Shift+click extends *from*. Carries its group id because extending only ever happens within one container — see extendSelectionTo(). */
    private selectionAnchor: { groupId: string, profileId: string }|null = null

    /**
     * Transient confirmation shown in the selection bar *after* the selection
     * itself is gone. Without it the bar vanishes the instant a move lands,
     * which reads as "did that do anything?" — the tree has already
     * re-rendered elsewhere, so nothing on screen acknowledges the action.
     */
    selectionNotice: string|null = null
    private selectionNoticeTimer: ReturnType<typeof setTimeout>|null = null

    ////// DRAG DIRECTION RESCUE //////
    // CDK caches every connected list's clientRect when the drag starts and
    // never refreshes it, but its own reorder preview shifts the intervening
    // rows by `transform` — so when a folder is dragged *downwards*, each
    // candidate target's cached rect and its on-screen rect end up 29px apart
    // (one row) and never overlap. `_canReceive` needs the pointer inside
    // both at once, so there is literally no position that lets CDK see the
    // drop: every downward nest silently degrades into a root-level reorder.
    // Dragging upwards works because the pointer meets the target's drop zone
    // before crossing the row centre that triggers the shift.
    //
    // Rather than fight the cache, track the folder actually under the
    // pointer ourselves, measured live (so transforms are included — it is
    // what the user sees), and let onGroupDrop() use it to rescue a drop CDK
    // resolved to the root. Verified 2026-07-28: downward drops onto a
    // neighbour one *and* three rows below both failed before this.
    private draggedGroupId: string|null = null
    /** Folder whose row the pointer is over, or null — only meaningful while draggedGroupId is set. */
    private hoveredGroupId: string|null = null
    /** Same pair for profile rows, driving multi-selection reorder placement — see updateHoveredProfile(). */
    private draggedProfileId: string|null = null
    private hoveredProfileId: string|null = null
    /**
     * Folder whose own profile list the dragged profile is currently over —
     * feeds isNestTarget() below, kept apart from hoveredProfileId (which
     * drives *where in the list* it lands, not *which folder*). Set from
     * CDK's own (cdkDropListEntered)/(cdkDropListExited) on that list rather
     * than a live hit-test: unlike the folder-on-folder case there is no
     * upper/lower-half ambiguity to rescue here, CDK already resolves this
     * container correctly.
     */
    private hoveredProfileTargetGroupId: string|null = null
    /** The folder the dragged profile started in, captured once at drag start — tells a genuine cross into another folder apart from re-entering its own list. */
    private draggedProfileSourceGroupId: string|null = null

    constructor (
        private config: ConfigService,
        private profilesService: ProfilesService,
        private snippets: SidebarPlusSnippetsService,
        private notifications: NotificationsService,
        private i18n: SidebarPlusI18nService,
        private zone: NgZone,
        private host: TreeDragHost,
    ) { }

    get selectionActive (): boolean {
        return this.selectedProfileIds.size > 0
    }

    /** Stops the notice timer when the component is torn down. */
    dispose (): void {
        if (this.selectionNoticeTimer) {
            clearTimeout(this.selectionNoticeTimer)
            this.selectionNoticeTimer = null
        }
    }

    /**
     * Wrapped in zone.run() because every caller reaches this *after*
     * `await config.save()`, and that continuation does not resume inside
     * Angular's zone — the field was being set correctly and the view simply
     * never repainted, so the confirmation was invisible from the first
     * version (reported in manual testing: "pas de notification"). Tabby's own
     * `notifications.notice()` was unaffected, which is what made the failure
     * look selective.
     *
     * Running inside the zone also means the setTimeout below is Zone-patched,
     * so its expiry triggers a change detection pass of its own and the
     * confirmation disappears on time without further help.
     */
    private showSelectionNotice (text: string): void {
        this.zone.run(() => {
            this.selectionNotice = text
            if (this.selectionNoticeTimer) {
                clearTimeout(this.selectionNoticeTimer)
            }
            this.selectionNoticeTimer = setTimeout(() => {
                this.selectionNotice = null
                this.selectionNoticeTimer = null
            }, 3000)
        })
    }

    isProfileSelected (profile: PartialProfile<Profile>): boolean {
        return !!profile.id && this.selectedProfileIds.has(profile.id)
    }

    clearSelection (): void {
        if (!this.selectedProfileIds.size) {
            return
        }
        this.selectedProfileIds = new Set()
        this.selectionAnchor = null
    }

    /**
     * Left-click on a profile row, with the modifier semantics of any OS file
     * manager: a plain click selects that row alone, Ctrl/Cmd toggles one row
     * in or out, Shift extends from the anchor. Double-click still launches the
     * profile, so selecting costs nothing.
     *
     * The tick boxes this replaced were dropped at the user's request after
     * manual testing — the row highlight plus the selection bar carry the state
     * on their own, and the row contents no longer pay a permanent indent for a
     * control that was only visible on hover.
     *
     * preventDefault() because the row is an `<a href="#">` — without it every
     * click pushes a history entry.
     */
    onProfileClick (profile: PartialProfile<Profile>, group: PartialProfileGroup<ProfileGroup>, event: MouseEvent): void {
        event.preventDefault()
        if (!profile.id) {
            return
        }
        this.host.setPreviewProfile(profile)
        if (event.shiftKey) {
            this.extendSelectionTo(profile, group)
        } else if (event.ctrlKey || event.metaKey) {
            this.toggleProfileSelection(profile, group)
        } else if (this.selectedProfileIds.size === 1 && this.selectedProfileIds.has(profile.id)) {
            // Clicking the only selected row again clears it, so a selection
            // can always be undone with the same gesture that made it.
            this.clearSelection()
        } else {
            this.selectedProfileIds = new Set([profile.id])
            this.selectionAnchor = { groupId: group.id, profileId: profile.id }
        }
    }

    private toggleProfileSelection (profile: PartialProfile<Profile>, group: PartialProfileGroup<ProfileGroup>): void {
        if (!profile.id) {
            return
        }
        // Reassigned rather than mutated in place: cheap here, and it keeps the
        // field honest for any future OnPush-style change detection.
        const selected = new Set(this.selectedProfileIds)
        if (selected.has(profile.id)) {
            selected.delete(profile.id)
        } else {
            selected.add(profile.id)
        }
        this.selectedProfileIds = selected
        this.selectionAnchor = { groupId: group.id, profileId: profile.id }
    }

    /**
     * Extends the selection **within the anchor's own container only**.
     * "Everything between A and B in display order" has no honest answer
     * across containers here: applyFavorites() prepends a synthetic "Épinglés"
     * group rendering the very same profile ids a second time, a collapsed
     * folder renders none of its rows at all, and the filter mode replaces the
     * whole tree with one synthetic 'search' group. Anchored in a different
     * group, this degrades to a plain toggle instead of guessing.
     */
    private extendSelectionTo (profile: PartialProfile<Profile>, group: PartialProfileGroup<ProfileGroup>): void {
        const anchor = this.selectionAnchor
        if (!anchor || anchor.groupId !== group.id) {
            this.toggleProfileSelection(profile, group)
            return
        }
        const profiles = group.profiles ?? []
        const from = profiles.findIndex(p => p.id === anchor.profileId)
        const to = profiles.findIndex(p => p.id === profile.id)
        if (from === -1 || to === -1) {
            this.toggleProfileSelection(profile, group)
            return
        }
        const selected = new Set(this.selectedProfileIds)
        for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
            const id = profiles[i].id
            if (id) {
                selected.add(id)
            }
        }
        this.selectedProfileIds = selected
        // Anchor left untouched on purpose: a second Shift+click should
        // re-extend from the same origin, not from the previous endpoint.
    }

    /** Whether "Déplacer la sélection ici" should show on this folder's menu — same target rule as onProfileDrop(). */
    canMoveSelectionTo (group: PartialProfileGroup<ProfileGroup>): boolean {
        return this.selectionActive && (!!group.editable || group.id === 'ungrouped')
    }

    /**
     * Moves every selected profile into `targetGroup` in one pass.
     *
     * The whole move is snapshotted *before* the first write. writeProfile()
     * only mutates config.store.profiles (verified in the installed bundle: it
     * never calls config.save()), so nothing here can fire config.changed$ and
     * swap this.profileGroups out from under the loop — but the order writes
     * below still have to be computed against the state as it was, and a single
     * config.save() at the very end keeps the whole batch atomic from the
     * config's point of view.
     */
    async moveSelectionToGroup (
        targetGroup: PartialProfileGroup<ProfileGroup>,
        insertAfterProfileId: string|null = null,
    ): Promise<void> {
        this.host.closeContextMenu()
        if (!this.canMoveSelectionTo(targetGroup)) {
            return
        }
        // Tabby stores "no group" as an absent `group`, not as the id of its
        // synthetic 'ungrouped' bucket — same mapping onProfileDrop() applies.
        const targetGroupValue = targetGroup.id === 'ungrouped' ? undefined : targetGroup.id

        const moves: { profile: PartialProfile<Profile>, sourceGroupId: string }[] = []
        for (const group of this.host.getProfileGroups()) {
            if (group.id === targetGroup.id) {
                // Already where it is being sent: skip the write, and leave it
                // out of the moved set so the target order below keeps it in
                // place instead of shuffling it to the end.
                continue
            }
            for (const profile of group.profiles ?? []) {
                if (profile.id && this.selectedProfileIds.has(profile.id)) {
                    moves.push({ profile, sourceGroupId: group.id })
                }
            }
        }
        if (!moves.length) {
            this.clearSelection()
            return
        }

        for (const { profile } of moves) {
            profile.group = targetGroupValue
            await this.profilesService.writeProfile(profile)
        }

        // Re-persist every source's order without the profiles that left, then
        // the target's with them appended — mirrors what onProfileDrop() does
        // for its single profile. Skipping the sources would leave their ids
        // sitting in their former folder's order list indefinitely.
        const movedIds = new Set(moves.map(m => m.profile.id))
        for (const sourceGroupId of new Set(moves.map(m => m.sourceGroupId))) {
            const source = this.host.getProfileGroups().find(g => g.id === sourceGroupId)
            await this.persistProfileOrder(sourceGroupId, (source?.profiles ?? []).filter(p => !movedIds.has(p.id)))
        }
        const target = this.host.getProfileGroups().find(g => g.id === targetGroup.id)
        const remaining = (target?.profiles ?? []).filter(p => !movedIds.has(p.id))
        // Dropped straight onto the folder's own row (or moved from the context
        // menu, which has no drop point at all): the batch goes to the TOP.
        // Appending it instead buried the profiles under everything already
        // there, which reads as "nothing happened" on a well-filled folder.
        // Landing on a profile row keeps the same rule as an in-folder
        // reorder — the batch goes just below the row aimed at.
        let insertAt = 0
        if (insertAfterProfileId) {
            const anchorIndex = remaining.findIndex(p => p.id === insertAfterProfileId)
            if (anchorIndex !== -1) {
                insertAt = anchorIndex + 1
            }
        }
        const ordered = [...remaining]
        ordered.splice(insertAt, 0, ...moves.map(m => m.profile))
        await this.persistProfileOrder(targetGroup.id, ordered)

        await this.config.save()
        const where = targetGroup.name || this.i18n.t('No group')
        this.clearSelection()
        this.showSelectionNotice(
            moves.length > 1
                ? this.i18n.t('{count} profiles moved to "{where}"', { count: moves.length, where })
                : this.i18n.t('Profile moved to "{where}"', { where }),
        )
    }

    /**
     * Starting a drag on a profile that is *not* part of the current selection
     * drops that selection, exactly as right-clicking outside it does. Without
     * this the user drags one row while three others stay ticked somewhere
     * above, with nothing on screen saying which of the two the drop will act
     * on — reported as confusing in manual testing.
     */
    onProfileDragStarted (profile: PartialProfile<Profile>): void {
        if (!this.isProfileSelected(profile)) {
            this.clearSelection()
        }
        this.draggedProfileId = profile.id ?? null
        this.hoveredProfileId = null
        this.draggedProfileSourceGroupId = profile.group ?? 'ungrouped'
        this.hoveredProfileTargetGroupId = null
    }

    /**
     * Releases the tracking only — `hoveredProfileId` is deliberately kept, for
     * the same reason as onGroupDragEnded(): CDK emits `cdkDragEnded` *before*
     * `cdkDropListDropped` (piège #29), so clearing it here would wipe the value
     * a moment before the drop handler reads it.
     *
     * `hoveredProfileTargetGroupId` has no such reader downstream — it only
     * drives the nest highlight — so it is safe to clear right away.
     */
    onProfileDragEnded (): void {
        this.draggedProfileId = null
        this.hoveredProfileTargetGroupId = null
    }

    /**
     * CDK fires this on a folder's own profile list when the dragged profile's
     * pointer crosses into it — not for the list the drag started in, only for
     * a genuine move into a different container — which is exactly "this
     * folder is about to receive it". `zone.run()` guards against CDK's
     * pointer tracking running outside NgZone (piège #41): its own
     * `dropped`/`started`/`ended` outputs already re-enter the zone and are
     * relied upon elsewhere in this file, but this pair is new here.
     */
    onProfileListEntered (group: PartialProfileGroup<CollapsableProfileGroup>): void {
        this.zone.run(() => {
            this.hoveredProfileTargetGroupId = group.id
        })
    }

    onProfileListExited (group: PartialProfileGroup<CollapsableProfileGroup>): void {
        this.zone.run(() => {
            if (this.hoveredProfileTargetGroupId === group.id) {
                this.hoveredProfileTargetGroupId = null
            }
        })
    }

    /**
     * True for the selected rows that are *not* the one under the cursor, while
     * a multi-selection drag is running: they are collapsed out of the list so
     * the whole batch visibly leaves together, instead of one row vanishing and
     * the rest sitting there as if they were staying put.
     *
     * Restoration is guaranteed by `cdkDragEnded`, which CDK emits even when a
     * drag is abandoned outside any drop list — so a cancelled drag puts every
     * row back rather than leaving them hidden.
     */
    isHiddenWhileDragging (profile: PartialProfile<Profile>): boolean {
        return !!this.draggedProfileId &&
            this.selectedProfileIds.size > 1 &&
            profile.id !== this.draggedProfileId &&
            this.isProfileSelected(profile)
    }

    /**
     * The profile row physically under the pointer, measured live.
     *
     * CDK's `currentIndex` turned out not to mean what the first version
     * assumed — a block reordered from it landed above the targeted row every
     * time, whichever direction the drag came from. Rather than reverse-engineer
     * its convention, the drop point is resolved the same way the folder rescue
     * already does it: by hit-testing the rendered rows. The drag placeholder is
     * height: 0 here (piège #28), so the rows do not shift during a drag and
     * what is measured is exactly what the user is pointing at.
     */
    private updateHoveredProfile (x: number, y: number): void {
        this.hoveredProfileId = null
        const rows = document.querySelectorAll<HTMLElement>('.sidebar-plus-tree a.tree-item[data-profile-id]')
        for (const row of Array.from(rows)) {
            const rect = row.getBoundingClientRect()
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
                this.hoveredProfileId = row.dataset.profileId ?? null
                return
            }
        }
    }

    /**
     * Whether `group`'s row should carry the "drop inside" highlight right
     * now, as opposed to CDK's own reorder feedback. Purely a read of state
     * already tracked for other purposes — `hoveredGroupId`/`draggedGroupId`
     * drive the folder-on-folder rescue below, `hoveredProfileTargetGroupId`
     * tracks a profile crossing into a foreign folder — so this adds no new
     * hit-testing, and the class it feeds (`.sidebar-plus-nest-target`) is
     * background/outline only: no geometry (piège #25/#28).
     */
    isNestTarget (group: PartialProfileGroup<CollapsableProfileGroup>): boolean {
        if (this.draggedGroupId) {
            return this.hoveredGroupId === group.id &&
                group.id !== this.draggedGroupId &&
                !!group.editable &&
                !isSelfOrDescendant(group.id, this.draggedGroupId, this.host.getRawGroupsSnapshot())
        }
        if (this.draggedProfileId) {
            return this.hoveredProfileTargetGroupId === group.id &&
                group.id !== this.draggedProfileSourceGroupId &&
                (!!group.editable || group.id === 'ungrouped')
        }
        return false
    }

    ////// DRAG & DROP //////
    get profileListIds (): string[] {
        return this.host.getProfileGroups().map(g => `profiles-${g.id}`)
    }

    async onProfileDrop (
        event: CdkDragDrop<PartialProfile<Profile>[]>,
        targetGroup: PartialProfileGroup<ProfileGroup>,
    ): Promise<void> {
        // Nothing happens on a drop that resolves to no usable target, and the
        // selection is deliberately left intact so the user can simply try
        // again. A drop released outside every drop list never reaches this
        // handler at all — CDK only emits `cdkDropListDropped` for a container
        // it recognises — and `cdkDragEnded` fires either way, which is what
        // brings the hidden rows back.
        const isRealTarget = targetGroup.editable || targetGroup.id === 'ungrouped'
        if (!isRealTarget) {
            return
        }

        // Dragging one row of a multi-selection moves the whole batch. The
        // roadmap had ruled multi-drag out as too fragile, which was true while
        // it would have meant teaching onProfileDrop() and the drag preview to
        // carry N items; now that moveSelectionToGroup() exists and is tested,
        // the drop just delegates to it. Only when the profile actually leaves
        // its container: a drop inside the same folder is a reorder, which the
        // selection has nothing to say about.
        //
        // Known cosmetic limit: CDK's drag preview still shows the single row
        // being dragged, not the stack.
        const draggedProfile = event.previousContainer.data[event.previousIndex]
        if (
            event.previousContainer !== event.container &&
            this.selectedProfileIds.size > 1 &&
            this.isProfileSelected(draggedProfile)
        ) {
            await this.moveSelectionToGroup(targetGroup, this.hoveredProfileId)
            return
        }

        const sourceGroupId = groupIdFromContainerId(event.previousContainer.id)

        if (event.previousContainer === event.container) {
            // Reordering inside one folder goes through the same placement
            // rule whether one row or a whole selection is moving: the batch
            // lands just below the row actually under the pointer. A single
            // row used to take CDK's own moveItemInArray() path instead, which
            // dropped it *above* the row aimed at — the same mismatch already
            // fixed for multi-selections.
            const movingIds = this.selectedProfileIds.size > 1 && this.isProfileSelected(draggedProfile)
                ? this.selectedProfileIds
                : new Set(draggedProfile.id ? [draggedProfile.id] : [])
            moveSelectionWithinArray(
                event.container.data,
                movingIds,
                event.currentIndex,
                this.hoveredProfileId,
            )
        } else {
            const profile = event.previousContainer.data[event.previousIndex]
            transferArrayItem(event.previousContainer.data, event.container.data, event.previousIndex, event.currentIndex)
            profile.group = targetGroup.id === 'ungrouped' ? undefined : targetGroup.id
            await this.profilesService.writeProfile(profile)
            // Only when the source is a real folder. CDK resolves a drop target
            // among the lists connected to the *source*, so a profile can be
            // dragged out of "Épinglés" even though nothing can be dropped into
            // it — and persisting that list's order on the "Tous" workspace
            // rewrote `weight` on every profile still pinned, ranking them by
            // their position among the favorites instead of within their own
            // folders.
            if (!isSyntheticGroupId(sourceGroupId)) {
                await this.persistProfileOrder(sourceGroupId, event.previousContainer.data)
            }
        }
        await this.persistProfileOrder(targetGroup.id, event.container.data)
        this.config.save()
    }

    /**
     * Sibling order is per-workspace (see configProvider.ts SidebarWorkspace)
     * — outside "Tous", reordering never touches the profile's own native
     * `weight` (which stays whatever "Tous" last set it to) and instead
     * writes the displayed order into the active workspace's own
     * `profileOrder[groupId]`. This is safe against hidden items: a
     * workspace's order list only needs to describe the profiles actually
     * visible in it, since a hidden profile is never rendered there
     * regardless of its recorded position.
     */
    private async persistProfileOrder (groupId: string, profiles: PartialProfile<Profile>[]): Promise<void> {
        // Before the write, never after: pruning replaces the order maps with
        // fresh objects, so pruning last would discard the entry just made.
        this.pruneDeadOrderIds()
        const activeWorkspace = this.host.getActiveWorkspace()
        if (activeWorkspace) {
            activeWorkspace.profileOrder ??= {}
            activeWorkspace.profileOrder[groupId] = profiles.map(p => p.id).filter((id): id is string => !!id)
            this.config.store.sidebarPlus ??= {}
            this.host.publishWorkspaces(this.host.getWorkspaces())
            return
        }
        await this.persistProfileWeights(profiles)
    }

    private async persistProfileWeights (profiles: PartialProfile<Profile>[]): Promise<void> {
        await Promise.all(profiles.map((profile, index) => {
            if ((profile.weight ?? 0) === index) {
                return Promise.resolve()
            }
            profile.weight = index
            return this.profilesService.writeProfile(profile)
        }))
    }

    /** CDK must see the deepest nested lists first; see [[sortGroupIdsByDepthDesc]]. */
    get groupListIds (): string[] {
        return [...sortGroupIdsByDepthDesc(this.host.getProfileGroups()), 'groups-root']
    }

    async onGroupDrop (
        event: CdkDragDrop<PartialProfileGroup<CollapsableProfileGroup>[]>,
        targetParentGroupId: string|null,
    ): Promise<void> {
        const dragged = event.previousContainer.data[event.previousIndex]
        if (!dragged.editable) {
            return
        }

        if (event.previousContainer === event.container) {
            // Before treating this as a plain reorder, check whether the
            // pointer was actually sitting on another folder's row — see the
            // "drag direction rescue" note above: on a downward drag CDK
            // cannot see the nested list at all and reports a root reorder
            // even though the user clearly aimed inside a folder.
            const rescued = this.rescueTargetGroupId(dragged.id)
            if (rescued) {
                // Drop it out of the sibling list we are about to persist:
                // it is leaving this level, so recording it here would write
                // an order entry for a folder that no longer belongs to it.
                const siblings = event.container.data.filter(g => g.id !== dragged.id)
                await this.reparentDraggedGroup(dragged, rescued, targetParentGroupId, siblings)
                return
            }
            moveItemInArray(event.container.data, event.previousIndex, event.currentIndex)
            this.persistGroupOrder(targetParentGroupId, event.container.data)
            await this.config.save()
            return
        }

        if (targetParentGroupId) {
            const targetParent = this.host.getProfileGroups().find(g => g.id === targetParentGroupId)
            if (!targetParent?.editable || isSelfOrDescendant(targetParentGroupId, dragged.id, this.host.getRawGroupsSnapshot())) {
                return
            }
        }

        transferArrayItem(event.previousContainer.data, event.container.data, event.previousIndex, event.currentIndex)
        // The folder is leaving this list, so the parent it came from must be
        // re-persisted without it — mirrors what onProfileDrop() already does
        // for the source group. Skipping it left the moved folder's id sitting
        // in its former parent's order list forever (seen in the user's real
        // config on 2026-07-29: the same id listed both under `root` and under
        // the folder it had been nested into).
        this.persistGroupOrder(
            parentGroupIdFromGroupContainerId(event.previousContainer.id),
            event.previousContainer.data,
        )
        await this.reparentDraggedGroup(dragged, targetParentGroupId, targetParentGroupId, event.container.data)
    }

    onGroupDragStarted (group: PartialProfileGroup<CollapsableProfileGroup>): void {
        this.draggedGroupId = group.id
        this.hoveredGroupId = null
    }

    /**
     * Only stops the tracking — `hoveredGroupId` is deliberately left set.
     * CDK emits `cdkDragEnded` *before* `cdkDropListDropped`, so clearing it
     * here would wipe the value a fraction of a millisecond before
     * onGroupDrop() reads it, and the rescue would never once fire.
     * onGroupDragStarted() resets it instead.
     */
    onGroupDragEnded (): void {
        this.draggedGroupId = null
    }

    /**
     * Hit-tests the folder rows directly rather than going through
     * `document.elementFromPoint`: the drop-zone overlays defined in the scss
     * cover the lower half of a row and would answer instead of the row
     * itself, and they are exactly what is unreliable here.
     */
    private updateHoveredGroup (x: number, y: number): void {
        this.hoveredGroupId = null
        const rows = document.querySelectorAll<HTMLElement>('.sidebar-plus-tree a.tree-item[data-group-id]')
        for (const row of Array.from(rows)) {
            const rect = row.getBoundingClientRect()
            // Lower half only: the upper half keeps meaning "reorder next to
            // this folder", matching the resting drop-zone geometry so the
            // gesture is the same whichever way CDK happens to resolve it.
            if (x >= rect.left && x <= rect.right && y >= rect.top + rect.height / 2 && y <= rect.bottom) {
                this.hoveredGroupId = row.dataset.groupId ?? null
                return
            }
        }
    }

    /** Called from the component's single document:mousemove HostListener — see onDocumentMouseMove() there. */
    onDragMouseMove (event: MouseEvent): void {
        if (this.draggedGroupId) {
            this.updateHoveredGroup(event.clientX, event.clientY)
        }
        if (this.draggedProfileId) {
            this.updateHoveredProfile(event.clientX, event.clientY)
        }
    }

    /**
     * The folder the pointer was really over, when it is a legal nest target
     * for `draggedId` — or null, meaning the drop should stay a plain
     * reorder. See the "drag direction rescue" note above for why CDK cannot
     * be trusted to have noticed it on a downward drag.
     */
    private rescueTargetGroupId (draggedId: string): string|null {
        const hovered = this.hoveredGroupId
        if (!hovered || hovered === draggedId) {
            return null
        }
        const target = this.host.getProfileGroups().find(g => g.id === hovered)
        if (!target?.editable || isSelfOrDescendant(hovered, draggedId, this.host.getRawGroupsSnapshot())) {
            return null
        }
        // Already sitting in that folder: nesting would be a no-op that still
        // pays the full recreate/migrate/delete cost (and a new id), so let
        // the normal reorder run instead.
        if (this.host.getRawGroupsSnapshot().find(g => g.id === draggedId)?.parentGroupId === hovered) {
            return null
        }
        return hovered
    }

    private async reparentDraggedGroup (
        dragged: PartialProfileGroup<CollapsableProfileGroup>,
        newParentGroupId: string|null,
        orderKeyParentGroupId: string|null,
        siblingsToPersist: PartialProfileGroup<CollapsableProfileGroup>[],
    ): Promise<void> {
        const allGroups = await readProfileGroups(this.profilesService, this.config)
        try {
            const newId = await this.reparentGroup(dragged.id, dragged, newParentGroupId, allGroups)
            // The folder now lives under a brand-new id, but `dragged` is the
            // rendered tree node and still carries the old one — and it is a
            // member of siblingsToPersist. Without this, persistGroupOrder()
            // below writes the OLD id into the new parent's order list, right
            // after migrateWorkspaceGroupId() has carefully rewritten every
            // other reference to the new one: the entry then points at a group
            // that no longer exists, the folder has no recorded position in
            // its new parent, and it silently falls back to being sorted last.
            // Found in the user's real config on 2026-07-29 as a dead id
            // (`526eac40: [a776a5b3]`) after a nesting drag.
            //
            // Safe to mutate: this node comes from the structuredClone() taken
            // in loadTreeItems(), never from a live config.store object
            // (piège #12).
            dragged.id = newId
        } catch (err) {
            // Deliberately not rethrown: this runs as an async Angular event
            // handler, so a rethrow becomes an unhandled promise rejection —
            // noise on top of the toast the user already gets, and it would
            // skip the config.save() below that persists whatever partial
            // migration did land. console.error keeps it diagnosable.
            // eslint-disable-next-line no-console
            console.error('[sidebarPlus] reparentGroup a échoué', err)
            this.notifications.error(this.i18n.t('Moving the folder failed'), String(err))
        }
        this.persistGroupOrder(orderKeyParentGroupId, siblingsToPersist)
        await this.config.save()
    }

    /**
     * Drops ids that match no existing group/profile from every order map —
     * top-level and per workspace, keys as well as values.
     *
     * Order lists accumulate dead ids on their own: re-parenting a folder
     * retires its id (piège #12 forces a recreate), deleting a group or
     * profile retires it outright, and neither path can rewrite every list
     * that happened to mention it. Left alone they are mostly inert, but they
     * make the maps unreadable when diagnosing an ordering problem, and one
     * of them masked a real bug once (piège #31: a list holding nothing but
     * dead ids still counted as "non-empty").
     *
     * Runs on every order write rather than on load: self-repairing without
     * ever rewriting config.yaml behind a user who is only reading the tree.
     */
    private pruneDeadOrderIds (): void {
        const groups = this.config.store.groups
        const profiles = this.config.store.profiles
        // Guard against wiping every order map if the store is momentarily
        // empty (mid-load, or a config that failed to parse): no groups means
        // no evidence, not "nothing exists".
        if (!groups?.length) {
            return
        }
        const liveGroupIds = new Set<string>(groups.map((g: PartialProfileGroup<ProfileGroup>) => g.id))
        const liveProfileIds = new Set<string>((profiles ?? []).map((p: PartialProfile<Profile>) => p.id).filter(Boolean))

        // config.store holds the *user's* entries only. The tree also shows
        // profiles contributed by providers (getProfileGroups() is called with
        // includeNonUserGroup, which passes includeBuiltin down to
        // getProfiles()) and the synthetic groups they are filed under —
        // 'built-in' plus one per provider-declared group name. None of those
        // exist in config.store, so judging liveness on it alone would call a
        // builtin profile's position dead and reset it without a word.
        // rawGroupsSnapshot is the same unfiltered snapshot deleteGroup() and
        // rescueTargetGroupId() already consult.
        for (const group of this.host.getRawGroupsSnapshot()) {
            liveGroupIds.add(group.id)
            for (const profile of group.profiles ?? []) {
                if (profile.id) {
                    liveProfileIds.add(profile.id)
                }
            }
        }

        // 'root' is the top level itself and 'ungrouped' is Tabby's synthetic
        // catch-all — neither is a real group, both are legitimate keys.
        const keptKey = (key: string): boolean => key === 'root' || key === 'ungrouped' || liveGroupIds.has(key)

        // Returns a fresh object rather than mutating in place: the result is
        // assigned back explicitly below, which is what actually makes the
        // change persist (piège #23).
        const prune = (order: Record<string, string[]>|undefined, liveValues: Set<string>): Record<string, string[]> => {
            const pruned: Record<string, string[]> = {}
            for (const [key, ids] of Object.entries(order ?? {})) {
                if (keptKey(key)) {
                    pruned[key] = ids.filter(id => liveValues.has(id))
                }
            }
            return pruned
        }

        const sidebarPlus = this.config.store.sidebarPlus
        if (!sidebarPlus) {
            return
        }
        sidebarPlus.groupOrder = prune(sidebarPlus.groupOrder, liveGroupIds)
        const workspaces: SidebarWorkspace[] = sidebarPlus.workspaces ?? []
        for (const ws of workspaces) {
            ws.groupOrder = prune(ws.groupOrder, liveGroupIds)
            ws.profileOrder = prune(ws.profileOrder, liveProfileIds)
        }
        sidebarPlus.workspaces = workspaces
    }

    /**
     * Drops every trace of an id that has just been deleted — the mirror image
     * of migrateWorkspaceGroupId(), which carries those same traces over when
     * an id *changes*. Same list, same consequence if one is forgotten, one
     * difference: a leftover here costs nothing visible, it just accumulates.
     *
     * Done at the point of deletion rather than by sweeping the config against
     * the live entries, which is what pruneDeadOrderIds() does for the order
     * maps and what this deliberately does not copy. A sweep has to answer
     * "does this id still exist?", and the honest answer needs the *unfiltered*
     * snapshot — builtin profiles and their synthetic groups included, see the
     * note in pruneDeadOrderIds(). Here the deleted id is known outright, so
     * nothing has to be inferred and a favourite can never be dropped by
     * mistake.
     *
     * Every workspace is visited, not only the active one: hiding and pinning
     * are per-workspace, and the entry the user is not looking at is precisely
     * the one nobody would clean up by hand.
     */
    forgetDeletedId (kind: 'profile'|'group', id: string): void {
        this.config.store.sidebarPlus ??= {}
        const sidebarPlus = this.config.store.sidebarPlus
        const without = (list: string[]|undefined): string[] => (list ?? []).filter(x => x !== id)

        // Explicit reassignment on every write, here as everywhere else in this
        // file: a nested in-place mutation is never picked up as a change to
        // persist (piège #23).
        if (kind === 'profile') {
            sidebarPlus.favorites = without(sidebarPlus.favorites)
        } else {
            sidebarPlus.favoriteGroups = without(sidebarPlus.favoriteGroups)
        }

        const workspaces: SidebarWorkspace[] = sidebarPlus.workspaces ?? []
        for (const ws of workspaces) {
            if (kind === 'profile') {
                ws.favorites = without(ws.favorites)
                ws.hiddenProfileIds = without(ws.hiddenProfileIds)
            } else {
                ws.favoriteGroups = without(ws.favoriteGroups)
                ws.hiddenGroupIds = without(ws.hiddenGroupIds)
            }
        }
        sidebarPlus.workspaces = workspaces

        // Attachments, variables and behaviour of that id — the library itself
        // is deliberately untouched, see the service.
        this.snippets.forget(id)
        this.host.moveNote(id, null)

        if (kind === 'group') {
            // Collapsed state lives in localStorage, not in config.yaml — same
            // reasoning as in migrateWorkspaceGroupId(), and unreadable storage
            // is not worth failing a deletion over.
            try {
                const collapsed = JSON.parse(window.localStorage.sidebarPlusGroupCollapsed ?? '{}')
                if (id in collapsed) {
                    delete collapsed[id]
                    window.localStorage.sidebarPlusGroupCollapsed = JSON.stringify(collapsed)
                }
            } catch {
                // Nothing to clean if it cannot be read.
            }
        }

        // Called *after* the entry is gone from config.store, so the id it has
        // to collect actually reads as dead.
        this.pruneDeadOrderIds()
    }

    /** Sibling order is per-workspace — see persistProfileOrder() above for the same reasoning applied to groups. */
    private persistGroupOrder (parentGroupId: string|null, groups: PartialProfileGroup<CollapsableProfileGroup>[]): void {
        const key = parentGroupId ?? 'root'
        const orderedIds = groups.filter(g => g.editable).map(g => g.id)
        this.config.store.sidebarPlus ??= {}
        this.pruneDeadOrderIds()
        const activeWorkspace = this.host.getActiveWorkspace()
        if (activeWorkspace) {
            activeWorkspace.groupOrder ??= {}
            activeWorkspace.groupOrder[key] = orderedIds
            this.host.publishWorkspaces(this.host.getWorkspaces())
            return
        }
        // this.config.store.sidebarPlus is Tabby's reactive config store —
        // mutating a nested property in place (`.groupOrder[key] = ...`)
        // without a final explicit assignment back onto `sidebarPlus` is
        // never picked up as a change to persist, unlike every other write
        // in this file (favorites/recentIcons/workspaces), which all end
        // with an explicit `this.config.store.sidebarPlus.X = value`. Real
        // bug found 2026-07-28: root-level (and nested) group reordering on
        // "Tous" silently never persisted, snapping back on every reload.
        const groupOrder = this.config.store.sidebarPlus.groupOrder ?? {}
        groupOrder[key] = orderedIds
        this.config.store.sidebarPlus.groupOrder = groupOrder
    }

    /**
     * profilesService.writeProfileGroup() only updates an existing flat
     * top-level config.store.groups entry — it cannot relocate a group
     * between parents (see roadmap piège #12: a naive parentGroupId
     * reassignment corrupted real user data). Instead, recreate an
     * equivalent group under the new parent, migrate its profiles and child
     * groups into it one at a time (writeProfile/newProfileGroup/
     * deleteProfileGroup are all already proven safe), then delete the
     * now-empty original.
     *
     * Migrates from `allGroups` — a full, workspace-*unfiltered* snapshot
     * fetched once by the caller — rather than the dragged item's own
     * `.children`/`.profiles` (which come from the displayed, possibly
     * workspace-filtered tree). Using the filtered tree would silently
     * orphan anything hidden in the active workspace: its parentGroupId
     * would keep pointing at the original group id after that id is
     * deleted below.
     */
    private async reparentGroup (
        groupId: string,
        meta: { name: string, icon?: string, color?: string },
        newParentGroupId: string|null,
        allGroups: PartialProfileGroup<ProfileGroup>[],
    ): Promise<string> {
        const fullGroup = allGroups.find(g => g.id === groupId)
        // Carried over wholesale rather than field by field. Listing the four
        // fields the sidebar knows about silently dropped `defaults` — the
        // per-provider group defaults Tabby merges into the ConfigProxy of
        // *every profile of the folder* — so re-parenting a folder stripped its
        // profiles of everything they inherited from it. Anything a future
        // tabby-core adds to ProfileGroup now follows on its own.
        //
        // Three fields are deliberately left out: `id`, which has to be empty
        // for `genId` to mint a new one; `profiles`, whose members are migrated
        // one at a time below; and `children`, which only exists on a tree node
        // and would be stale the moment the recursion rebuilds it.
        const { id: _id, profiles: _profiles, children: _children, ...carried } =
            (fullGroup ?? {}) as PartialProfileGroup<ProfileGroup> & { children?: unknown }
        const replacement = {
            ...carried,
            id: '',
            // From `meta` rather than from the snapshot: the caller hands over
            // the node as displayed, which is the one carrying a rename made
            // in this very gesture.
            name: meta.name,
            icon: meta.icon,
            color: meta.color,
            parentGroupId: newParentGroupId ?? undefined,
        } as PartialProfileGroup<ProfileGroup>
        await this.profilesService.newProfileGroup(replacement, { genId: true })

        for (const profile of (fullGroup?.profiles ?? []).filter(p => !p.isTemplate)) {
            profile.group = replacement.id
            await this.profilesService.writeProfile(profile)
        }
        for (const child of allGroups.filter(g => g.parentGroupId === groupId)) {
            await this.reparentGroup(child.id, child, replacement.id, allGroups)
        }

        // The group just got a brand-new id — every workspace's hide/order
        // state that referenced the old one must follow, or the move
        // silently drops it out of whatever hide/order state it had
        // everywhere (not just in the workspace the move was made from).
        this.migrateWorkspaceGroupId(groupId, replacement.id)

        // No forgetDeletedId() after this one, unlike deleteGroup(): the
        // migration just above renamed every trace of the old id, so there is
        // nothing left of it to collect. Order matters — migrate, then delete.
        await this.profilesService.deleteProfileGroup((fullGroup ?? { id: groupId }) as PartialProfileGroup<ProfileGroup>)
        // Returned so the caller can persist the sibling order under the NEW
        // id — see reparentDraggedGroup().
        return replacement.id
    }

    /**
     * Carries every trace of a group's id over to the one it was just given.
     *
     * Everything keyed by group id has to be listed here — a state left behind
     * does not fail, it silently reverts to its default the next time the tree
     * loads. `favoriteGroups` was the one missing: re-parenting a pinned folder
     * dropped its star and left a dead id nobody ever collects, since
     * `pruneDeadOrderIds()` only walks the order maps.
     */
    private migrateWorkspaceGroupId (oldId: string, newId: string): void {
        this.config.store.sidebarPlus ??= {}
        const workspaces: SidebarWorkspace[] = this.config.store.sidebarPlus.workspaces ?? []
        for (const ws of workspaces) {
            const hiddenIndex = ws.hiddenGroupIds.indexOf(oldId)
            if (hiddenIndex !== -1) {
                ws.hiddenGroupIds[hiddenIndex] = newId
            }
            const favoriteIndex = ws.favoriteGroups?.indexOf(oldId) ?? -1
            if (favoriteIndex !== -1) {
                ws.favoriteGroups[favoriteIndex] = newId
            }
            renameOrderKey(ws.groupOrder, oldId, newId)
        }
        this.config.store.sidebarPlus.workspaces = workspaces

        // The "Tous" workspace's own favorites, which live at the top level
        // rather than in an entry of `workspaces`.
        const favorites: string[] = this.config.store.sidebarPlus.favoriteGroups ?? []
        const topLevelIndex = favorites.indexOf(oldId)
        if (topLevelIndex !== -1) {
            favorites[topLevelIndex] = newId
            this.config.store.sidebarPlus.favoriteGroups = favorites
        }

        this.config.store.sidebarPlus.groupOrder ??= {}
        renameOrderKey(this.config.store.sidebarPlus.groupOrder, oldId, newId)

        // Snippet attachments, variables and behaviour, keyed by the folder's
        // id. Forgotten here, dragging a folder into another would silently
        // strip it of its snippets — and of every snippet its profiles
        // inherited from it.
        this.snippets.migrate(oldId, newId)
        this.host.moveNote(oldId, newId)

        // Collapsed state lives in localStorage, not in config.yaml — same
        // reasoning, same consequence if forgotten: the folder came back
        // expanded after every re-parenting.
        try {
            const collapsed = JSON.parse(window.localStorage.sidebarPlusGroupCollapsed ?? '{}')
            if (oldId in collapsed) {
                collapsed[newId] = collapsed[oldId]
                delete collapsed[oldId]
                window.localStorage.sidebarPlusGroupCollapsed = JSON.stringify(collapsed)
            }
        } catch {
            // Unreadable storage is not worth failing a move over.
        }
    }
}
