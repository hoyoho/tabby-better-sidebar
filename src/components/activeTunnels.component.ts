import { Component, Input } from '@angular/core'
import { AppService, ConfigService, PlatformService } from 'tabby-core'
import { hostSupports } from '../hostCompat'
import { ActiveTunnel, SidebarPlusLiveStateService } from '../liveState.service'
import { focusTab } from '../tabs'

/**
 * The "Active tunnels" block.
 *
 * The projection lives in [[SidebarPlusLiveStateService]]; this component owns
 * only the row expansion and the two link/focus gestures. `sftpMode` is the
 * parent's view switch, passed in because the block is hidden while the SFTP
 * panel is showing.
 */
@Component({
    selector: 'sidebar-plus-active-tunnels',
    template: require('./activeTunnels.component.pug'),
    styles: [':host { display: contents; }'],
})
export class SidebarPlusActiveTunnelsComponent {
    @Input() sftpMode = false

    /** Which tunnel row has its technical details unfolded, by index — clicking a row toggles it. */
    expandedTunnelIndex: number|null = null
    activeTunnelsCollapsed = window.localStorage.sidebarPlusActiveTunnelsCollapsed === 'true'

    constructor (
        private app: AppService,
        private config: ConfigService,
        private platform: PlatformService,
        private live: SidebarPlusLiveStateService,
    ) { }

    get showTunnels (): boolean {
        return (this.config.store.sidebarPlus?.showTunnels ?? true) && hostSupports('ssh-tab')
    }

    get activeTunnels (): ActiveTunnel[] {
        return this.live.activeTunnels
    }

    toggleActiveTunnels (): void {
        this.activeTunnelsCollapsed = !this.activeTunnelsCollapsed
        window.localStorage.sidebarPlusActiveTunnelsCollapsed = this.activeTunnelsCollapsed
    }

    toggleTunnelDetails (index: number, event: MouseEvent): void {
        event.preventDefault()
        this.expandedTunnelIndex = this.expandedTunnelIndex === index ? null : index
    }

    openTunnelUrl (tunnel: ActiveTunnel, event: MouseEvent): void {
        event.preventDefault()
        event.stopPropagation()
        if (tunnel.url) {
            this.platform.openExternal(tunnel.url)
        }
    }

    /** stopPropagation, not just preventDefault: the row itself folds the details open. */
    focusTunnelSession (tunnel: ActiveTunnel, event: MouseEvent): void {
        event.preventDefault()
        event.stopPropagation()
        focusTab(this.app, tunnel.tab)
    }
}
