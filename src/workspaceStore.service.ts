import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { SidebarWorkspace } from './configProvider'

/**
 * Storage and selection layer for the plugin's workspaces.
 *
 * The component keeps the prompts, menus and tree reloads; this service owns
 * the arrays and the active-id bookkeeping, so every mutation goes through one
 * place that writes `config.store.sidebarPlus.workspaces` and saves.
 *
 * The tree loader commits its snapshot explicitly (`commit()`), after its own
 * stale-request guard, so a superseded load can never overwrite newer state.
 */
@Injectable({ providedIn: 'root' })
export class SidebarPlusWorkspaceStore {
    workspaces: SidebarWorkspace[] = []
    activeWorkspaceId = window.localStorage.sidebarPlusActiveWorkspace ?? 'all'

    constructor (private config: ConfigService) { }

    get activeWorkspace (): SidebarWorkspace|null {
        if (this.activeWorkspaceId === 'all') {
            return null
        }
        return this.workspaces.find(w => w.id === this.activeWorkspaceId) ?? null
    }

    /** Applies the tree loader's validated snapshot; only called once it knows it is not superseded. */
    commit (workspaces: SidebarWorkspace[], activeWorkspaceId: string, persistSelection: boolean): void {
        this.workspaces = workspaces
        this.activeWorkspaceId = activeWorkspaceId
        // Persisted only while the workspaces block is on. With it off, the
        // active workspace is forced to "Tous" for display, and writing that
        // here would erase the user's real selection.
        if (persistSelection) {
            window.localStorage.sidebarPlusActiveWorkspace = activeWorkspaceId
        }
    }

    /** Explicit user choice: unlike a commit, this always persists the selection. */
    select (id: string): void {
        this.activeWorkspaceId = id
        window.localStorage.sidebarPlusActiveWorkspace = id
    }

    /** The live config array, created on demand — mutations must never act on a stale clone. */
    private current (): SidebarWorkspace[] {
        this.config.store.sidebarPlus ??= {}
        this.config.store.sidebarPlus.workspaces ??= []
        return this.config.store.sidebarPlus.workspaces
    }

    private adopt (workspaces: SidebarWorkspace[]): void {
        this.config.store.sidebarPlus ??= {}
        this.config.store.sidebarPlus.workspaces = workspaces
        this.workspaces = workspaces
    }

    async save (): Promise<void> {
        await this.config.save()
    }

    async create (name: string): Promise<SidebarWorkspace> {
        const workspaces = this.current()
        const workspace: SidebarWorkspace = {
            id: `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            name,
            hiddenProfileIds: [],
            hiddenGroupIds: [],
            favorites: [],
            favoriteGroups: [],
            groupOrder: {},
            profileOrder: {},
        }
        workspaces.push(workspace)
        this.adopt(workspaces)
        await this.save()
        return workspace
    }

    async add (workspace: SidebarWorkspace): Promise<void> {
        const workspaces = this.current()
        workspaces.push(workspace)
        this.adopt(workspaces)
        await this.save()
    }

    async rename (id: string, name: string): Promise<void> {
        const workspaces = this.current()
        const target = workspaces.find(w => w.id === id)
        if (target) {
            target.name = name
        }
        this.adopt(workspaces)
        await this.save()
    }

    async delete (id: string): Promise<void> {
        const workspaces = this.current().filter(w => w.id !== id)
        this.adopt(workspaces)
        await this.save()
    }

    async hideProfile (profileId: string): Promise<void> {
        const workspaces = this.current()
        const workspace = this.activeWorkspaceId === 'all' ? null : workspaces.find(w => w.id === this.activeWorkspaceId)
        if (!workspace || workspace.hiddenProfileIds.includes(profileId)) {
            return
        }
        workspace.hiddenProfileIds.push(profileId)
        this.adopt(workspaces)
        await this.save()
    }

    async hideGroup (groupId: string): Promise<void> {
        const workspaces = this.current()
        const workspace = this.activeWorkspaceId === 'all' ? null : workspaces.find(w => w.id === this.activeWorkspaceId)
        if (!workspace || workspace.hiddenGroupIds.includes(groupId)) {
            return
        }
        workspace.hiddenGroupIds.push(groupId)
        this.adopt(workspaces)
        await this.save()
    }

    async restoreProfile (profileId: string): Promise<void> {
        const workspaces = this.current()
        const workspace = this.activeWorkspaceId === 'all' ? null : workspaces.find(w => w.id === this.activeWorkspaceId)
        if (!workspace) {
            return
        }
        const index = workspace.hiddenProfileIds.indexOf(profileId)
        if (index === -1) {
            return
        }
        workspace.hiddenProfileIds.splice(index, 1)
        this.adopt(workspaces)
        await this.save()
    }

    async restoreGroup (groupId: string): Promise<void> {
        const workspaces = this.current()
        const workspace = this.activeWorkspaceId === 'all' ? null : workspaces.find(w => w.id === this.activeWorkspaceId)
        if (!workspace) {
            return
        }
        const index = workspace.hiddenGroupIds.indexOf(groupId)
        if (index === -1) {
            return
        }
        workspace.hiddenGroupIds.splice(index, 1)
        this.adopt(workspaces)
        await this.save()
    }
}
