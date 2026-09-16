import { Injectable } from '@angular/core'
import { HotkeyDescription, HotkeyProvider } from 'tabby-core'
import { SidebarPlusI18nService } from './i18n'

/**
 * Puts the cursor in the sidebar's filter field.
 *
 * Handled by the tree component itself rather than by a root-provided
 * service: the field is its own, one per window, and reaching it that way
 * would mean holding a reference to a component that is mounted and unmounted
 * at will.
 */
export const FOCUS_FILTER_HOTKEY = 'sidebar-plus-focus-filter'

@Injectable()
export class SidebarPlusHotkeyProvider extends HotkeyProvider {
    constructor (
        private i18n: SidebarPlusI18nService,
    ) {
        super()
    }

    async provide (): Promise<HotkeyDescription[]> {
        return [{
            id: FOCUS_FILTER_HOTKEY,
            name: this.i18n.t('Filter the profiles (Better Sidebar)'),
        }]
    }
}
