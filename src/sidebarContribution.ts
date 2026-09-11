import { Injectable, Type } from '@angular/core'
import { ConfigService, SidebarContribution } from 'tabby-core'
import { SidebarPlusTreeComponent } from './components/sidebarTree.component'

/**
 * Registers the plugin's sidebar as the `owner` of the application sidebar.
 *
 * Tabby's sidebar host renders this component in place of the built-in profile
 * tree, and the component keeps managing its own width and layout (the host
 * leaves an owner's geometry alone). Disabling the plugin withdraws the
 * contribution and Tabby's own tree comes back.
 */
@Injectable()
export class SidebarPlusContribution extends SidebarContribution {
    id = 'better-sidebar'
    title = 'Better Sidebar'
    icon = 'fas fa-columns'
    kind = 'owner' as const

    constructor (private config: ConfigService) {
        super()
    }

    isAvailable (): boolean {
        return this.config.store.sidebarPlus?.enabled ?? true
    }

    getComponentType (): Type<unknown> {
        return SidebarPlusTreeComponent
    }
}
