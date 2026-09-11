// The tabby-core typings published on npm lag behind the Tabby desktop app's
// actual runtime API (observed: npm "nightly" tag vs. locally installed 1.0.235).
// These fields/methods exist at runtime; this augmentation just restores their types.
import { Type } from '@angular/core'
import 'tabby-core'

declare module 'tabby-core' {
    // Sidebar extension point added to the app after the npm typings were cut.
    // The host renders a contribution registered under this token; `kind:
    // 'owner'` replaces the whole sidebar.
    export type SidebarContributionKind = 'owner' | 'panel' | 'widget'
    export interface SidebarContext {
        activeTab?: unknown
    }
    export abstract class SidebarContribution {
        abstract id: string
        title: string
        icon: string
        order: number
        kind: SidebarContributionKind
        minWidth: number
        defaultWidth: number
        maxWidth: number
        isAvailable (ctx: SidebarContext): boolean
        abstract getComponentType (): Type<unknown>
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    interface ProfileGroup {
        parentGroupId?: string
        icon?: string
        color?: string
    }

    interface ProfilesService {
        buildGroupTree<T extends ProfileGroup & { children: any }> (
            groups: PartialProfileGroup<T>[]
        ): PartialProfileGroup<T>[]
    }

    // Provider hook added with the sidebar work: copies provider-side state
    // (the SSH password in the vault) from a profile to its duplicate.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    interface ProfileProvider<P> {
        duplicateProfile (source: P, target: P): void|Promise<void>
    }

    // Both take a path the npm typings know nothing about, and both skip their
    // file dialog entirely when it is supplied — which is what makes them
    // usable for a transfer to a path we chose ourselves (piège #48). Declared
    // as extra overloads: the published signatures stay valid, so any call
    // written against them keeps compiling.
    interface PlatformService {
        startDownload (name: string, mode: number, size: number, filePath: string): Promise<FileDownload|null>
        startUpload (options: FileUploadOptions, paths: string[]): Promise<FileUpload[]>
        // The published signature takes no argument and claims to always answer
        // a string; the installed app takes a dialog title and button label,
        // and answers null when the user cancels. The null matters most: acting
        // on a cancelled pick as if it were a path would write into "null/".
        pickDirectory (title?: string, buttonLabel?: string): Promise<string|null>
    }
}
