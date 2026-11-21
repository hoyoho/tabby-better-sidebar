import { Inject, Injectable, NgZone, OnDestroy } from '@angular/core'
import { merge, Subscription, timer } from 'rxjs'
import { AppService, BaseTabComponent, ConfigService, PartialProfile, Profile, ProfileProvider, SplitTabComponent } from 'tabby-core'
import { ForwardedPortConfig, PortForwardType, SSHTabComponent } from 'tabby-ssh'
import { SidebarPlusI18nService } from './i18n'
import { SidebarPlusNoticesService } from './notices.service'
import { PingState, SidebarPlusPingService } from './ping.service'
import { formatSpeed, SidebarPlusTransfersService } from './transfersRegistry.service'
import { hostSupports } from './hostCompat'
import { getAllOpenTabs, isLiveSSHTab, isSSHTab } from './tabs'
import { formatTunnel, tunnelKey } from './tunnels'

/** Duck-typed shape of tabs that carry a launching profile and a live session (e.g. BaseTerminalTabComponent). */
export interface ProfileBackedTab {
    profile?: { id?: string, name?: string, icon?: string, color?: string, type?: string }
    session?: unknown
}

/** One row of the "Tunnels actifs" section — a single live port forward, tied back to the session carrying it. */
export interface ActiveTunnel {
    tab: SSHTabComponent
    /** Owning session's display name, so a tunnel can be read without cross-referencing the sessions list. */
    sessionName: string
    /** What the row shows: the user's own description when there is one, since that is what they named it for. */
    label: string
    /** Technical form (`L 127.0.0.1:8181 → localhost:8181`), revealed on click rather than shown by default. */
    detail: string
    /** Browsable address, for a Local forward only — Remote listens on the far end, Dynamic is a SOCKS proxy with no page to open. */
    url: string|null
    /**
     * `live` is a mounted forward. `waiting` is remembered from a session that
     * just died — the row stays, dimmed, while the session gets a chance to
     * come back (see TUNNEL_LOSS_GRACE_MS). `lost` is the aftermath of a
     * reconnection: a forward the revived session did *not* remount, which is
     * exactly what happens to a tunnel added on the fly — Tabby only remounts
     * what the profile carries (verified in `ssh.ts:493`, nothing else is
     * replayed). Shown for a while so the loss is seen instead of silent.
     */
    state: 'live'|'waiting'|'lost'
    /** The row's whole hover text, composed once — the detail, plus what the state means when it is not `live`. */
    tooltip: string
    /** `tunnelKey()` of the forward — never displayed, carried so memory can match rows across a reconnection. */
    key: string
}

/** What `tunnelMemory` keeps per forward — enough to rebuild a row without the (dead) session. */
interface RememberedTunnel {
    key: string
    sessionName: string
    label: string
    detail: string
}

/** What `tunnelMemory` keeps per SSH tab, across the death and revival of its session. */
interface TunnelMemoryEntry {
    rows: RememberedTunnel[]
    /** When the session was first seen dead, null while it lives. */
    lostAt: number|null
    /** Rows for forwards a revived session did not bring back, each with its display deadline. */
    ghosts: { row: ActiveTunnel, until: number }[]
}

/**
 * How long a dead session's tunnels stay visible as « en attente de reprise ».
 *
 * Long enough to cover an automatic reconnection and a human clicking
 * "Reconnect" without hurrying; bounded because a session nobody revives is a
 * session that was closed, and its tunnels with it. The SFTP panel's 3 s grace
 * answers a different question (when to *leave* the view) — this one is about
 * how long a line may honestly claim it might come back.
 */
const TUNNEL_LOSS_GRACE_MS = 60_000

/** How long a « non remonté » row lingers after a reconnection before the loss is considered acknowledged. */
const TUNNEL_NOT_RESTORED_MS = 30_000

/** One row of the "Sessions actives" section — a live terminal tab, flattened out of its split if it is in one. */
export interface ActiveSession {
    tab: BaseTabComponent
    /** The tab's manual rename if it has one, else the launching profile's name, else the tab's own title (quick connect, opened outside any saved profile). */
    name: string
    icon: string
    color: string|null
    /** The tab's live title (usually `user@host: cwd`), shown as a tooltip since it moves around too much to be the label. */
    title: string
    focused: boolean
    /** Profile type (`ssh`, `local`, `serial`, `telnet`), used to group sessions in the sidebar. */
    category: string
    /** True for SSH tabs where latency probing, SFTP and tunnel listing apply. */
    isSSH: boolean
    /**
     * Number of the registry's `active` entries whose `sessionLabel` matches
     * this session's own `name` — see refreshSessionTransfers(). Zero means
     * nothing is moving on this session right now.
     */
    transferCount: number
    /** Combined speed of those entries, already formatted (shared formatSpeed()) — blank while count is 0 or no tick has produced a figure yet. */
    transferSpeedLabel: string
    /**
     * The row's whole compact segment ("3 ⇅ 2,4 Mo/s"), precomposed here
     * rather than concatenated in the template (piège #54) — blank when
     * transferCount is 0, in which case the row falls back to the uptime.
     */
    transferLabel: string
}

/** One bucket of the "Sessions actives" list when it holds several connection kinds (SSH / local / serial / telnet ...). */
export interface SessionGroup {
    category: string
    label: string
    sessions: ActiveSession[]
}

type LiveForward = NonNullable<SSHTabComponent['sshSession']>['forwardedPorts'][number]

export interface LiveStateHooks {
    /** A session gained focus, or the tab list changed — the component dismisses its profile preview. */
    onTabStateChanged: () => void
}

/**
 * Live projection of the sessions and SSH tunnels shown in the sidebar.
 *
 * Extracted from `SidebarPlusTreeComponent`: the component renders, this
 * service owns the 2 s poll, the focus subscriptions, the session uptime
 * stamps and the tunnel memory. Nothing here touches the DOM, so the rules can
 * be reasoned about (and later tested) without a component instance.
 */
@Injectable({ providedIn: 'root' })
export class SidebarPlusLiveStateService implements OnDestroy {
    activeSessions: ActiveSession[] = []
    activeTunnels: ActiveTunnel[] = []
    tunnelCounts = new Map<string, number>()
    profileActivity = new Map<string, { up: boolean, down: boolean }>()

    private _sessionGroups: SessionGroup[] = []
    /** tab → when it was first seen live, the only record of a session's age there is (see sessionUptime()). */
    private sessionOpenedAt = new Map<BaseTabComponent, number>()
    /**
     * Clock captured once per refresh pass. Template bindings derive uptime
     * from this instead of calling `Date.now()` themselves: a value read at
     * binding time can change between Angular's check and its verification
     * pass and trip NG0100 when the two straddle a second boundary.
     */
    private now = Date.now()
    /** The row under the pointer and the tooltip text held still for it — see sessionTooltip(). */
    private hoveredSessionTab: BaseTabComponent|null = null
    private hoveredSessionTooltip = ''
    /**
     * Session display name → the profile that launched it, built by
     * refreshActiveSessions() from the same live SSH tabs it already walks.
     *
     * The registry's entries carry a `sessionLabel` but no profile id — this is
     * the join back to a profile row, by the one string both sides compute the
     * same way: `tab.customTitle || tab.topmostParent?.customTitle ||
     * profile.name || tab.title`, mirrored in sftpPanel.component.ts's own
     * `sessionLabel` assignment.
     */
    private sessionLabelToProfileId = new Map<string, string>()
    /**
     * profileId → signatures of the forwards actually mounted on its live
     * session. Lets the config popup tell a tunnel Tabby is really running from
     * one merely written down — only the former resists deletion.
     */
    private liveTunnelKeys = new Map<string, Set<string>>()

    /**
     * What each SSH tab's tunnels looked like when last seen alive, kept across
     * the death of the session so a micro-cut shows as a state instead of a
     * disappearance. Pruned when the tab itself goes away.
     */
    private tunnelMemory = new Map<SSHTabComponent, TunnelMemoryEntry>()

    /** Forwards already dismounted as duplicates — the poll must not notice (or dismount) them twice while the removal is in flight. */
    private dismountedForwards = new WeakSet<LiveForward>()

    private statusSubscription: Subscription|null = null
    private activeTabFocusSub: Subscription|null = null
    private tabsChangedSubscription: Subscription|null = null
    private activeTabChangeSubscription: Subscription|null = null
    private splitFocusSubscription: Subscription|null = null
    private transfersActivitySubscription: Subscription|null = null
    private hooks: LiveStateHooks|null = null

    constructor (
        private app: AppService,
        private config: ConfigService,
        private zone: NgZone,
        private transfers: SidebarPlusTransfersService,
        private ping: SidebarPlusPingService,
        private i18n: SidebarPlusI18nService,
        private notices: SidebarPlusNoticesService,
        @Inject(ProfileProvider) private profileProviders: ProfileProvider<Profile>[],
    ) { }

    ngOnDestroy (): void {
        this.stop()
    }

    private get showActiveSessions (): boolean {
        return (this.config.store.sidebarPlus?.showActiveSessions ?? true) && hostSupports('ssh-tab')
    }

    private get showTunnels (): boolean {
        return (this.config.store.sidebarPlus?.showTunnels ?? true) && hostSupports('ssh-tab')
    }

    private get showTransfers (): boolean {
        const showSftp = (this.config.store.sidebarPlus?.showSftp ?? true) && hostSupports('sftp-panel')
        return showSftp && (this.config.store.sidebarPlus?.showTransfers ?? true)
    }

    /**
     * Starts the poll and the focus subscriptions. Safe to call again after
     * `stop()` — the service is root-scoped and outlives one sidebar mount.
     */
    start (hooks: LiveStateHooks): void {
        this.stop()
        this.hooks = hooks

        this.refreshActiveSessions()
        this.watchSplitFocus()
        // Recomputes on every meaningful registry change (an entry starting or
        // leaving `active`) rather than polling it. `showTransfers` gates both
        // this subscription's effect and the source itself.
        this.transfersActivitySubscription = this.transfers.changed.subscribe(() => {
            this.zone.run(() => {
                this.refreshTransferActivity()
                // A transfer starting or leaving `active` should show up on the
                // session row right away rather than waiting for the next poll.
                this.refreshSessionTransfers()
            })
        })
        this.statusSubscription = merge(
            this.app.tabsChanged$,
            this.app.tabOpened$,
            this.app.tabClosed$,
            this.app.tabRemoved$,
            // Drives the "focused" highlight of the active sessions list. The
            // periodic timer below would eventually catch up, but a highlight
            // trailing the user's own tab switch by up to two seconds reads as
            // a bug.
            this.app.activeTabChange$,
            // Nothing emits when a session merely *dies* (server-side drop,
            // network loss): the tab lives on showing "Reconnecter" while
            // `sshSession.open` has already flipped. Hence the poll — it is
            // what keeps a dead session from staying listed as live.
            timer(2000, 2000),
        ).subscribe(() => {
            this.refreshActiveSessions()
            this.watchSplitFocus()
        })
        // A session gaining focus takes the bottom panel back from a profile
        // preview. `activeTabChange$` is only part of the story — the active
        // tab's own focus stream is what tells us the user has (re)engaged.
        this.activeTabChangeSubscription = this.app.activeTabChange$.subscribe(() => {
            this.hooks?.onTabStateChanged()
            this.resubscribeActiveTabFocus()
        })
        // Tab list changes (a session completing or dropping) also re-drive the
        // bottom panels. Kept apart from the merged status subscription: that
        // one rides a 2s poll, and a poll must not dismiss a profile preview.
        this.tabsChangedSubscription = this.app.tabsChanged$.subscribe(() => this.hooks?.onTabStateChanged())
        this.resubscribeActiveTabFocus()
    }

    stop (): void {
        this.statusSubscription?.unsubscribe()
        this.activeTabFocusSub?.unsubscribe()
        this.tabsChangedSubscription?.unsubscribe()
        this.activeTabChangeSubscription?.unsubscribe()
        this.splitFocusSubscription?.unsubscribe()
        this.transfersActivitySubscription?.unsubscribe()
        this.statusSubscription = null
        this.activeTabFocusSub = null
        this.tabsChangedSubscription = null
        this.activeTabChangeSubscription = null
        this.splitFocusSubscription = null
        this.transfersActivitySubscription = null
        this.hooks = null
    }

    /** Re-runs every projection after a config change (block toggles, SFTP view off…). */
    refreshAll (): void {
        this.refreshTransferActivity()
        this.refreshSessionTransfers()
        this.refreshActiveSessions()
    }

    get visibleActiveSessions (): ActiveSession[] {
        const tabs = this.activeWorkspaceTabs()
        return this.activeSessions.filter(session => tabs.has(session.tab))
    }

    get sessionGroups (): SessionGroup[] {
        return this._sessionGroups
    }

    private activeWorkspaceTabs (): Set<BaseTabComponent> {
        const active = this.app.activeTab
        if (!active) {
            return new Set()
        }
        const tabs = active instanceof SplitTabComponent ? active.getAllTabs() : [active]
        return new Set(tabs as BaseTabComponent[])
    }

    /**
     * Rebuilds the list of live sessions, one row per *pane* — a split holding
     * three sessions is three rows, since focusing "the tab" would be
     * ambiguous otherwise.
     */
    private refreshActiveSessions (): void {
        const wantSessions = this.showActiveSessions
        const wantTunnels = this.showTunnels

        // Kept outside the early return below: it is a plain per-tab pass, not
        // the per-split forward scan that return exists to skip, and the
        // transfer arrows are a property of the profile row itself — they do
        // not depend on the "Sessions actives"/"Tunnels" blocks being shown.
        const sessionLabelToProfileId = new Map<string, string>()
        for (const tab of getAllOpenTabs(this.app)) {
            if (!isSSHTab(tab) || !isLiveSSHTab(tab)) {
                continue
            }
            const profile = (tab as unknown as ProfileBackedTab).profile
            if (!profile?.id) {
                continue
            }
            const renamedTitle = tab.customTitle || tab.topmostParent?.customTitle
            const sessionName = renamedTitle || profile.name || tab.title || 'Session SSH'
            sessionLabelToProfileId.set(sessionName, profile.id)
        }
        this.sessionLabelToProfileId = sessionLabelToProfileId
        this.refreshTransferActivity()

        if (!wantSessions && !wantTunnels) {
            // Neither block is on: this whole scan — every tab of every split,
            // twice a second — produces nothing anybody can see. Drop what was
            // already collected so switching a block back on starts from a
            // clean slate rather than from a stale snapshot.
            if (this.activeSessions.length) {
                this.activeSessions = []
            }
            if (this.activeTunnels.length) {
                this.activeTunnels = []
            }
            this.tunnelCounts = new Map()
            this.liveTunnelKeys = new Map()
            // A stale memory would resurrect "waiting" rows the moment the
            // block comes back on, for sessions that may be long gone.
            this.tunnelMemory.clear()
            this.recomputeSessionGroups()
            return
        }

        const focused = this.focusedTab()
        const sessions: ActiveSession[] = []
        const tunnels: ActiveTunnel[] = []
        const tunnelCounts = new Map<string, number>()
        const liveTunnelKeys = new Map<string, Set<string>>()
        const nowMs = Date.now()
        const openSSHTabs = new Set<SSHTabComponent>()
        // A multiplexed session is one object shared by several tabs, so its
        // forwards would otherwise be listed once per tab: same object, same
        // tunnel, N lines for one listener.
        const seenForwards = new Set<LiveForward>()
        // First mounted wins for a local listener — see the dedup note below.
        const localOwners = new Map<string, string>()
        for (const tab of getAllOpenTabs(this.app)) {
            const isSSH = isSSHTab(tab)
            const profile = (tab as unknown as ProfileBackedTab).profile

            if (isSSH) {
                openSSHTabs.add(tab as SSHTabComponent)
                if (!isLiveSSHTab(tab as SSHTabComponent)) {
                    // The tab still exists but its transport is gone: this is
                    // the very window a reconnection happens in. Its tunnels are
                    // shown from memory, dimmed, rather than silently dropped.
                    if (wantTunnels) {
                        this.pushWaitingTunnels(tab as SSHTabComponent, tunnels, nowMs)
                    }
                    continue
                }
            } else {
                // Non-SSH terminal tabs (local / serial / telnet): include when
                // the tab carries a profile and its session is alive.
                if (!profile || !(tab as unknown as { session?: unknown }).session) {
                    continue
                }
            }
            // A manually renamed tab wins over the profile name: with several
            // sessions open on the same machine the profile name repeats on
            // every row, and the rename is the user's own way of telling them
            // apart. The rename only ever targets the top-level tab, hence the
            // `topmostParent` fallback for a pane inside a split.
            const renamedTitle = tab.customTitle || tab.topmostParent?.customTitle
            const sessionName = renamedTitle || profile?.name || tab.title || 'Session'
            if (wantSessions) {
                sessions.push({
                    tab,
                    name: sessionName,
                    icon: profile?.icon || tab.icon || 'fas fa-terminal',
                    color: profile?.color ?? tab.color ?? null,
                    title: tab.title,
                    focused: tab === focused,
                    category: profile?.type || 'other',
                    isSSH,
                    // Filled in by refreshSessionTransfers() below, whichever
                    // array ends up as this.activeSessions — placeholder only.
                    transferCount: 0,
                    transferSpeedLabel: '',
                    transferLabel: '',
                })
            }

            // Tunnels are an SSH-only concept — non-SSH tabs carry no
            // forwardedPorts, and serial / telnet have no SFTP subsystem.
            if (!isSSH || !wantTunnels) {
                continue
            }
            // Read straight off the live transport. Tabby owns the forwarding
            // engine entirely — this plugin only mirrors its state.
            const sshTab = tab as SSHTabComponent
            const tabRows: ActiveTunnel[] = []
            for (const forward of sshTab.sshSession.forwardedPorts ?? []) {
                if (seenForwards.has(forward)) {
                    continue
                }
                seenForwards.add(forward)
                const key = tunnelKey(forward)
                // Real duplicate: two *distinct* sessions each mounted the same
                // forward — several tabs on one profile do exactly that. Only
                // one of them usefully serves; the first mounted is kept and
                // the copy is dismounted, with a notice. Remote forwards are
                // exempt: they listen on *their* server's side.
                if (forward.type !== PortForwardType.Remote) {
                    const owner = localOwners.get(key)
                    if (owner !== undefined) {
                        this.dismountDuplicate(sshTab, forward, owner, sessionName)
                        continue
                    }
                    localOwners.set(key, sessionName)
                }
                const detail = formatTunnel(forward)
                tabRows.push({
                    tab: sshTab,
                    sessionName,
                    label: forward.description?.trim() || detail,
                    detail,
                    url: SidebarPlusLiveStateService.tunnelUrl(forward),
                    state: 'live',
                    tooltip: detail,
                    key,
                })
                if (profile?.id) {
                    tunnelCounts.set(profile.id, (tunnelCounts.get(profile.id) ?? 0) + 1)
                    const keys = liveTunnelKeys.get(profile.id) ?? new Set<string>()
                    keys.add(key)
                    liveTunnelKeys.set(profile.id, keys)
                }
            }
            tunnels.push(...tabRows)
            this.rememberTunnels(sshTab, tabRows, tunnels, nowMs)
        }
        // Tabs that no longer exist take their memory with them: a closed tab
        // is a closed session, not a cut waiting to heal.
        for (const tab of [...this.tunnelMemory.keys()]) {
            if (!openSSHTabs.has(tab)) {
                this.tunnelMemory.delete(tab)
            }
        }
        // Same guard as the sessions list above, and for the same reason: this
        // runs every 2s and *ngFor tracks by object identity, so reassigning
        // unconditionally would rebuild every row twice a second and drop the
        // :hover state the open-in-browser button lives in.
        if (!SidebarPlusLiveStateService.sameTunnels(this.activeTunnels, tunnels)) {
            this.activeTunnels = tunnels
        }
        this.tunnelCounts = tunnelCounts
        this.liveTunnelKeys = liveTunnelKeys
        // Only swap the array in when something actually changed. This runs on
        // a 2s timer, and *ngFor tracks rows by object identity: reassigning
        // unconditionally would rebuild every row's DOM twice a second, which
        // drops the `:hover` state the `.actions` overlay depends on.
        if (!SidebarPlusLiveStateService.sameSessions(this.activeSessions, sessions)) {
            this.activeSessions = sessions
        }

        // Uptime is stamped here, on first sighting, and forgotten as soon as
        // the tab leaves the list — see sessionUptime() for what that implies.
        // Kept out of the ActiveSession rows for the same reason as latency: a
        // value that changes every tick would fail sameSessions().
        const now = this.now = Date.now()
        const live = new Set(sessions.map(session => session.tab))
        for (const tab of this.sessionOpenedAt.keys()) {
            if (!live.has(tab)) {
                this.sessionOpenedAt.delete(tab)
            }
        }
        for (const tab of live) {
            if (!this.sessionOpenedAt.has(tab)) {
                this.sessionOpenedAt.set(tab, now)
            }
        }

        // Rides this same 2s pass rather than bringing its own timer; the
        // service decides which sessions are actually due a probe, and does
        // nothing at all while the interval is 0. SSH only — the probe is an
        // SFTP round trip, which local/serial/telnet tabs have no use for.
        this.ping.poll(SidebarPlusLiveStateService.sshOnly(sessions))

        // Refreshes the compact transfer segment on whichever array is now
        // current — see refreshSessionTransfers() for why this mutates the
        // existing ActiveSession objects rather than swapping them.
        this.refreshSessionTransfers()
        // Rebuild the cached session-group buckets now that `activeSessions`
        // (and the active workspace's visible slice of it) may have changed.
        this.recomputeSessionGroups()
    }

    /**
     * Recomputes each active session's transfer aggregate. Mutates the existing
     * `ActiveSession` objects in place rather than reassigning the array: the
     * reassignment is gated by sameSessions() to keep row identity stable, and
     * a speed moving on the registry's own tick would defeat that guard.
     */
    private refreshSessionTransfers (): void {
        if (!this.showTransfers) {
            for (const session of this.activeSessions) {
                if (session.transferCount !== 0) {
                    session.transferCount = 0
                    session.transferSpeedLabel = ''
                    session.transferLabel = ''
                }
            }
            return
        }
        const bySessionName = new Map<string, { count: number, speed: number }>()
        for (const entry of this.transfers.entries) {
            if (entry.state !== 'active' || !entry.sessionLabel) {
                continue
            }
            const agg = bySessionName.get(entry.sessionLabel) ?? { count: 0, speed: 0 }
            agg.count++
            agg.speed += entry.speed
            bySessionName.set(entry.sessionLabel, agg)
        }
        for (const session of this.activeSessions) {
            const agg = bySessionName.get(session.name)
            session.transferCount = agg?.count ?? 0
            session.transferSpeedLabel = agg ? formatSpeed(agg.speed) : ''
            session.transferLabel = session.transferCount > 0
                ? `${session.transferCount} ⇅${session.transferSpeedLabel ? ` ${session.transferSpeedLabel}` : ''}`
                : ''
        }
    }

    /**
     * Recomputes profileId → {up, down} from the registry's entries and the
     * sessionLabel → profileId map refreshActiveSessions() just rebuilt.
     */
    private refreshTransferActivity (): void {
        if (!this.showTransfers) {
            if (this.profileActivity.size) {
                this.profileActivity = new Map()
            }
            return
        }
        const activity = new Map<string, { up: boolean, down: boolean }>()
        for (const entry of this.transfers.entries) {
            if (entry.state !== 'active' || !entry.sessionLabel) {
                continue
            }
            const profileId = this.sessionLabelToProfileId.get(entry.sessionLabel)
            if (!profileId) {
                continue
            }
            const row = activity.get(profileId) ?? { up: false, down: false }
            if (entry.direction === 'up') {
                row.up = true
            } else {
                row.down = true
            }
            activity.set(profileId, row)
        }
        this.profileActivity = activity
    }

    /** The colour of the row's one dot — latency-coloured for SSH when the probe is on, connected green otherwise. */
    sessionDotClass (session: ActiveSession): string {
        if (!session.isSSH || this.ping.intervalMs <= 0) {
            return 'status-dot-connected'
        }
        const state: PingState = this.ping.state(session.tab as SSHTabComponent)
        if (state === 'good') {
            return 'status-dot-connected'
        }
        if (state === 'fair') {
            return 'status-dot-fair'
        }
        if (state === 'poor') {
            return 'status-dot-poor'
        }
        // 'unknown' (not measured yet) and 'unavailable' (no SFTP subsystem)
        // both fall through to the dimmed base style, which is the honest
        // rendering of "no figure to show".
        return ''
    }

    /**
     * The row's tooltip, frozen for as long as the pointer stays on the row. A
     * native tooltip is torn down and rebuilt whenever its `title` attribute is
     * rewritten, and this one would be rewritten on every 2s pass as the
     * seconds move — which read as a flicker while trying to read it.
     */
    sessionTooltip (session: ActiveSession): string {
        if (this.hoveredSessionTab === session.tab) {
            return this.hoveredSessionTooltip
        }
        return this.buildSessionTooltip(session)
    }

    onSessionHover (session: ActiveSession, hovering: boolean): void {
        if (hovering) {
            this.hoveredSessionTab = session.tab
            this.hoveredSessionTooltip = this.buildSessionTooltip(session)
        } else if (this.hoveredSessionTab === session.tab) {
            this.hoveredSessionTab = null
        }
    }

    private buildSessionTooltip (session: ActiveSession): string {
        const latency = session.isSSH ? this.ping.latencyMs(session.tab as SSHTabComponent) : null
        const line = [
            session.name,
            latency === null ? null : `${latency} ms`,
            this.formatUptimePrecise(this.uptimeMs(session)),
        ].filter(Boolean).join(' | ')
        if (session.transferCount <= 0) {
            return line
        }
        const transfersLine = session.transferSpeedLabel
            ? this.i18n.t('Transfers: {count} running, total speed {speed}', { count: session.transferCount, speed: session.transferSpeedLabel })
            : this.i18n.t('Transfers: {count} running', { count: session.transferCount })
        return `${line}\n${transfersLine}`
    }

    /**
     * How long the session has been up, stamped by this service the first time
     * the tab shows up in the list.
     */
    sessionUptime (session: ActiveSession): string {
        const elapsed = this.uptimeMs(session)
        return elapsed === null ? '' : this.formatUptime(elapsed)
    }

    /** Milliseconds since the tab was first seen live, or null while it has not been stamped yet. */
    private uptimeMs (session: ActiveSession): number|null {
        const startedAt = this.sessionOpenedAt.get(session.tab)
        return startedAt === undefined ? null : this.now - startedAt
    }

    /** `1m 47s`, `3h 05m`, `2j 04h` — the tooltip's own form, precise to the second under a minute. */
    private formatUptimePrecise (ms: number|null): string {
        if (ms === null) {
            return ''
        }
        const seconds = Math.max(0, Math.floor(ms / 1000))
        if (seconds < 60) {
            return `${seconds}s`
        }
        const minutes = Math.floor(seconds / 60)
        if (minutes < 60) {
            return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
        }
        const hours = Math.floor(minutes / 60)
        if (hours < 24) {
            return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
        }
        // Only the day unit varies with the language ("2j" in French, "2d" in
        // English) — the s/m/h forms above are cross-language.
        return this.i18n.t('{d}d {h}h', { d: Math.floor(hours / 24), h: String(hours % 24).padStart(2, '0') })
    }

    /** `42 s`, `12 min`, `3 h 05`, `2 j 4 h` — coarser as it gets longer, since a session's age is read at a glance. */
    private formatUptime (ms: number): string {
        const seconds = Math.max(0, Math.floor(ms / 1000))
        if (seconds < 60) {
            return `${seconds} s`
        }
        const minutes = Math.floor(seconds / 60)
        if (minutes < 60) {
            return `${minutes} min`
        }
        const hours = Math.floor(minutes / 60)
        if (hours < 24) {
            return `${hours} h ${String(minutes % 60).padStart(2, '0')}`
        }
        return this.i18n.t('{d} d {h} h', { d: Math.floor(hours / 24), h: hours % 24 })
    }

    private static sameSessions (a: ActiveSession[], b: ActiveSession[]): boolean {
        return a.length === b.length && a.every((session, i) =>
            session.tab === b[i].tab &&
            session.focused === b[i].focused &&
            session.name === b[i].name &&
            session.icon === b[i].icon &&
            session.color === b[i].color &&
            session.title === b[i].title &&
            session.category === b[i].category &&
            session.isSSH === b[i].isSSH)
    }

    /** The SSH subset of a sessions list, for the latency probe. */
    private static sshOnly (sessions: ActiveSession[]): SSHTabComponent[] {
        return sessions.filter(s => s.isSSH).map(s => s.tab as SSHTabComponent)
    }

    /** The pane the user is actually looking at: `app.activeTab` is the split, not the session inside it. */
    focusedTab (): BaseTabComponent|null {
        const active = this.app.activeTab
        return active instanceof SplitTabComponent ? active.getFocusedTab() : active
    }

    /**
     * Keeps the focused-row highlight in step with focus moves *inside* the
     * active split, which AppService knows nothing about. Re-subscribed on
     * every refresh: dropping the old subscription unconditionally is what
     * makes switching from one split to another actually follow the new one.
     */
    private watchSplitFocus (): void {
        this.splitFocusSubscription?.unsubscribe()
        this.splitFocusSubscription = null
        const active = this.app.activeTab
        if (active instanceof SplitTabComponent) {
            this.splitFocusSubscription = active.focusChanged$.subscribe(() => this.refreshActiveSessions())
        }
    }

    /**
     * Re-subscribes to the currently active tab's focus streams. Whenever the
     * active session receives focus — whether by top-level tab click,
     * click-into-terminal, or re-selecting the same tab — the profile preview
     * is dismissed so the connection panel can take its place.
     */
    private resubscribeActiveTabFocus (): void {
        this.activeTabFocusSub?.unsubscribe()
        this.activeTabFocusSub = null
        const tab = this.app.activeTab
        if (!tab) {
            return
        }
        if (tab instanceof SplitTabComponent) {
            this.activeTabFocusSub = merge(tab.focused$, tab.focusChanged$)
                .subscribe(() => this.hooks?.onTabStateChanged())
        } else {
            this.activeTabFocusSub = tab.focused$
                .subscribe(() => this.hooks?.onTabStateChanged())
        }
    }

    private recomputeSessionGroups (): void {
        const order = ['ssh', 'local', 'serial', 'telnet']
        const buckets = new Map<string, ActiveSession[]>()
        for (const session of this.visibleActiveSessions) {
            const category = (order.includes(session.category) ? session.category : 'other')
            const bucket = buckets.get(category)
            if (bucket) {
                bucket.push(session)
            } else {
                buckets.set(category, [session])
            }
        }
        const categories = [...buckets.keys()].sort((a, b) => {
            const ia = order.indexOf(a)
            const ib = order.indexOf(b)
            return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib)
        })
        this._sessionGroups = categories.map(category => ({
            category,
            label: this.sessionCategoryLabel(category),
            sessions: buckets.get(category)!,
        }))
    }

    /** Human name for a session category — the profile provider's translated name, raw type id as fallback. */
    private sessionCategoryLabel (category: string): string {
        const provider = this.profileProviders.find(p => p.id === category)
        return provider ? this.i18n.t(provider.name) : category
    }

    /** Whether this configured tunnel is one Tabby currently has mounted — the only kind whose deletion is withheld. */
    isTunnelLive (forward: ForwardedPortConfig, profileId: string|undefined): boolean {
        if (!profileId) {
            return false
        }
        return this.liveTunnelKeys.get(profileId)?.has(tunnelKey(forward)) ?? false
    }

    /** Backs the chain badge in the tree — number of live forwards across every open session of this profile. */
    tunnelCount (profile: PartialProfile<Profile>): number {
        return (profile.id && this.tunnelCounts.get(profile.id)) || 0
    }

    /**
     * Tunnels written on the profile, mounted or not. Drives a dimmed badge so
     * a profile carrying forwards is recognisable before it is launched.
     */
    configuredTunnelCount (profile: PartialProfile<Profile>): number {
        return (profile.options as { forwardedPorts?: ForwardedPortConfig[] }|undefined)?.forwardedPorts?.length ?? 0
    }

    /** Backs the ↑/↓ badge in the tree — read from the precomputed map, never scanning the registry here. */
    transferActivity (profile: PartialProfile<Profile>): { up: boolean, down: boolean }|null {
        return (profile.id && this.profileActivity.get(profile.id)) || null
    }

    private static sameTunnels (a: ActiveTunnel[], b: ActiveTunnel[]): boolean {
        return a.length === b.length && a.every((tunnel, i) =>
            tunnel.tab === b[i].tab &&
            tunnel.label === b[i].label &&
            tunnel.detail === b[i].detail &&
            tunnel.url === b[i].url &&
            tunnel.sessionName === b[i].sessionName &&
            tunnel.state === b[i].state)
    }

    /** Emits the remembered tunnels of a dead-but-present tab, dimmed, while the reconnection window lasts. */
    private pushWaitingTunnels (tab: SSHTabComponent, into: ActiveTunnel[], now: number): void {
        const entry = this.tunnelMemory.get(tab)
        if (!entry?.rows.length) {
            return
        }
        entry.lostAt ??= now
        if (now - entry.lostAt > TUNNEL_LOSS_GRACE_MS) {
            // Nobody revived it in time: from here on the cut is treated as a
            // closure, and the rows go the way they always did before this
            // feature — away.
            this.tunnelMemory.delete(tab)
            return
        }
        for (const row of entry.rows) {
            into.push({
                tab,
                sessionName: row.sessionName,
                label: row.label,
                detail: row.detail,
                // No browser button on a dead listener: the page could not load.
                url: null,
                state: 'waiting',
                tooltip: this.i18n.t('{detail}: session cut, tunnel waiting to resume', { detail: row.detail }),
                key: row.key,
            })
        }
    }

    /**
     * Updates the memory of a live tab, and surfaces what a revival did *not*
     * bring back — Tabby only remounts the forwards written on the profile.
     */
    private rememberTunnels (tab: SSHTabComponent, live: ActiveTunnel[], into: ActiveTunnel[], now: number): void {
        const previous = this.tunnelMemory.get(tab)
        let ghosts = previous?.ghosts ?? []
        if (previous && previous.lostAt !== null) {
            const liveKeys = new Set(live.map(row => row.key))
            ghosts = previous.rows.filter(row => !liveKeys.has(row.key)).map(row => ({
                row: {
                    tab,
                    sessionName: row.sessionName,
                    label: row.label,
                    detail: row.detail,
                    url: null,
                    state: 'lost' as const,
                    tooltip: this.i18n.t(
                        '{detail}: not restored after the reconnection. Only the tunnels saved in the profile are remounted; a tunnel added on the fly disappears with its session.',
                        { detail: row.detail },
                    ),
                    key: row.key,
                },
                until: now + TUNNEL_NOT_RESTORED_MS,
            }))
        }
        // The same row objects are re-pushed every pass on purpose: their
        // fields are what sameTunnels() compares, and stable rows are what
        // keeps the DOM from being rebuilt twice a second.
        ghosts = ghosts.filter(ghost => ghost.until > now)
        into.push(...ghosts.map(ghost => ghost.row))
        this.tunnelMemory.set(tab, {
            rows: live.map(row => ({ key: row.key, sessionName: row.sessionName, label: row.label, detail: row.detail })),
            lostAt: null,
            ghosts,
        })
    }

    /**
     * Dismounts one duplicate forward and says so.
     *
     * Fire-and-forget on purpose: this runs inside the 2 s poll, and the poll
     * must not await network round trips. The WeakSet is what keeps the next
     * pass from dismounting (or announcing) the same object again while the
     * removal is still in flight.
     */
    private dismountDuplicate (tab: SSHTabComponent, forward: LiveForward, ownerName: string, sessionName: string): void {
        if (this.dismountedForwards.has(forward)) {
            return
        }
        this.dismountedForwards.add(forward)
        const detail = formatTunnel(forward)
        tab.sshSession?.removePortForward(forward).catch(() => {
            // The listener may already be gone with its session; either way the
            // next poll re-reads reality rather than trusting this call.
        })
        this.notices.notice(
            this.i18n.t('Tunnel {detail} already mounted by {owner}: duplicate dismounted ({session})', { detail, owner: ownerName, session: sessionName }),
        )
    }

    /**
     * The address a Local forward can be opened at, or null.
     *
     * Only Local is browsable: Remote listens on the far end of the connection,
     * and Dynamic is a SOCKS proxy with no page behind it. `0.0.0.0` means
     * "every interface", which is not an address a browser can be pointed at —
     * loopback is the one that reaches it. https is inferred from the usual
     * ports only; guessing further would produce links that fail to load.
     */
    private static tunnelUrl (forward: ForwardedPortConfig): string|null {
        if (forward.type !== PortForwardType.Local) {
            return null
        }
        const host = !forward.host || forward.host === '0.0.0.0' ? '127.0.0.1' : forward.host
        const scheme = forward.port === 443 || forward.targetPort === 443 ? 'https' : 'http'
        return `${scheme}://${host}:${forward.port}`
    }
}
