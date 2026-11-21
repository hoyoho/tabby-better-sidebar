import { Component, EventEmitter, Output } from '@angular/core'
import { AppService, BaseTabComponent, ConfigService } from 'tabby-core'
import { hostSupports } from '../hostCompat'
import { ActiveSession, SessionGroup, SidebarPlusLiveStateService } from '../liveState.service'
import { focusTab } from '../tabs'

/**
 * The "Active sessions" block.
 *
 * Extracted from the sidebar tree once the live projection moved into
 * [[SidebarPlusLiveStateService]]: this component only renders that state and
 * forwards the two gestures the parent owns (focus is generic, opening SFTP
 * needs the parent's panel).
 */
@Component({
    selector: 'sidebar-plus-active-sessions',
    template: require('./activeSessions.component.pug'),
    styles: [':host { display: contents; }'],
})
export class SidebarPlusActiveSessionsComponent {
    /** Opening SFTP is the parent's gesture: it owns the panel and the mode switch. */
    @Output() openSftp = new EventEmitter<{ session: ActiveSession, event: MouseEvent }>()

    /** Per-machine UI state, same pattern as the sidebar's other collapsed blocks. */
    activeSessionsCollapsed = window.localStorage.sidebarPlusActiveSessionsCollapsed === 'true'

    constructor (
        private app: AppService,
        private config: ConfigService,
        private live: SidebarPlusLiveStateService,
    ) { }

    get showActiveSessions (): boolean {
        return (this.config.store.sidebarPlus?.showActiveSessions ?? true) && hostSupports('ssh-tab')
    }

    get visibleActiveSessions (): ActiveSession[] {
        return this.live.visibleActiveSessions
    }

    get sessionGroups (): SessionGroup[] {
        return this.live.sessionGroups
    }

    toggleActiveSessions (): void {
        this.activeSessionsCollapsed = !this.activeSessionsCollapsed
        window.localStorage.sidebarPlusActiveSessionsCollapsed = this.activeSessionsCollapsed
    }

    trackGroup (_: number, group: SessionGroup): string {
        return group.category
    }

    trackSession (_: number, session: ActiveSession): BaseTabComponent {
        return session.tab
    }

    sessionDotClass (session: ActiveSession): string {
        return this.live.sessionDotClass(session)
    }

    sessionTooltip (session: ActiveSession): string {
        return this.live.sessionTooltip(session)
    }

    onSessionHover (session: ActiveSession, hovering: boolean): void {
        this.live.onSessionHover(session, hovering)
    }

    sessionUptime (session: ActiveSession): string {
        return this.live.sessionUptime(session)
    }

    focusSession (session: ActiveSession, event?: MouseEvent): void {
        event?.preventDefault()
        focusTab(this.app, session.tab)
    }

    openSftpFor (session: ActiveSession, event: MouseEvent): void {
        event.preventDefault()
        event.stopPropagation()
        this.openSftp.emit({ session, event })
    }
}
