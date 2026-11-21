import './sidebarTree.component.scss'
// Shown in the footer bar. Imported from package.json (resolveJsonModule) so it
// tracks the real version at every bump rather than a hand-kept copy.
import { version as PLUGIN_VERSION } from '../../package.json'
import FuzzySearch from 'fuzzy-search'
import { Subscription } from 'rxjs'
import { CdkDragDrop } from '@angular/cdk/drag-drop'
import { AfterViewChecked, ChangeDetectorRef, Component, ElementRef, HostBinding, HostListener, Inject, Injector, Input, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import {
    AppService,
    ConfigService,
    HotkeysService,
    NotificationsService,
    PartialProfile,
    PlatformService,
    PartialProfileGroup,
    Profile,
    ProfileGroup,
    ProfileProvider,
    ProfilesService,
    TAB_COLORS,
} from 'tabby-core'
import { SettingsTabComponent } from 'tabby-settings'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { SidebarPlusSettingsTabComponent } from './settingsTab.component'
import { SidebarPlusSftpComponent } from './sftpPanel.component'
import { SnippetsModalComponent, SnippetsModalResult } from './snippetsModal.component'
import { NoteModalComponent } from './noteModal.component'
import { PasteGroupModalComponent, PasteResolution } from './pasteGroupModal.component'
import { TunnelsModalComponent } from './tunnelsModal.component'
import { IconPickerModalComponent } from './iconPickerModal.component'
import { ForwardedPortConfig, SSHTabComponent } from 'tabby-ssh'
import { SidebarSnippet, SidebarWorkspace } from '../configProvider'
import { SidebarPlusI18nService } from '../i18n'
import { SidebarPlusSnippetsService } from '../snippets.service'
import { SidebarPlusNoticesService } from '../notices.service'
import { FOCUS_FILTER_HOTKEY } from '../hotkeys'
import { focusTab, getAllOpenTabs, isSSHTab } from '../tabs'
import { hostSupports } from '../hostCompat'
import { readProfileGroups } from '../profileGroups'
import { buildPayload, countPayload, describePurge, isEmptyReport, parsePayload, PurgeLevel, PurgeReport, SharedGroup } from '../groupShare'
import { buildWorkspacePayload, generateWorkspaceId, parseWorkspacePayload, uniqueWorkspaceName } from '../workspaceShare'
import { BetterPanelContribution, electBetterPanelHost, SIDEBAR_PANEL_TOKEN } from '../betterPanel'
import { openProfileModal, PROFILE_MODAL_UNAVAILABLE } from '../profileModal'
import { TranslatableMessage } from '../i18nMessage'
import { clampInViewport } from '../viewport'
import { SidebarResizeController } from '../sidebarResize'
import { CollapsableProfileGroup, intoCollapsable } from '../sidebarTreeModel'
import { ActiveSession, ProfileBackedTab, SidebarPlusLiveStateService } from '../liveState.service'
import { SidebarPlusWorkspaceStore } from '../workspaceStore.service'
import { SidebarPlusTreeDragController } from '../treeDrag'

@Component({
    selector: 'sidebar-plus-tree',
    template: require('./sidebarTree.component.pug'),
})
export class SidebarPlusTreeComponent implements OnInit, OnDestroy, AfterViewChecked {
    /** Shown in the footer bar next to the plugin name. */
    readonly pluginVersion = PLUGIN_VERSION
    /** Footer links. Constants rather than template literals: the template must not compute (piège #54). */
    readonly repositoryUrl = 'https://github.com/hoyoho/tabby-better-sidebar'
    readonly authorUrl = 'https://github.com/hoyoho'
    profileGroups: PartialProfileGroup<ProfileGroup>[] = []
    rootGroups: PartialProfileGroup<ProfileGroup>[] = []

    @Input() filter = ''

    /**
     * The filter field itself, so the hotkey can put the cursor in it.
     *
     * Optional on purpose: it lives under `*ngIf='!sftpMode'`, so it is simply
     * absent while the sidebar shows the SFTP view.
     */
    @ViewChild('filterInput') filterInput?: ElementRef<HTMLInputElement>
    /**
     * Reference to the mounted SFTP panel, so openSessionSftp() can reach
     * past its own focus-follows-tab handshake and unfreeze a pin left
     * standing from an earlier navigation. Optional: absent whenever
     * `showSftp` is off, since the tag itself is `*ngIf`'d out then.
     */
    @ViewChild(SidebarPlusSftpComponent) private sftpPanel?: SidebarPlusSftpComponent
    private hotkeySubscription: Subscription|null = null
    /** Multi-selection, drag tracking and order/reparent persistence live in the controller. */
    readonly drag: SidebarPlusTreeDragController

    ////// WORKSPACES //////
    // Per-machine UI state, not synced config: switching workspaces is not
    // something that should dirty config.yaml on every click. The active id
    // and the arrays live in the workspace store; assigning the id here is for
    // internal reconciliation and never writes localStorage (select() does).
    get workspaces (): SidebarWorkspace[] {
        return this.workspaceStore.workspaces
    }

    get activeWorkspaceId (): string {
        return this.workspaceStore.activeWorkspaceId
    }

    set activeWorkspaceId (id: string) {
        this.workspaceStore.activeWorkspaceId = id
    }

    contextMenuWorkspace: SidebarWorkspace|null = null
    newWorkspaceName = ''
    renameWorkspaceValue = ''
    /** Toggles the sidebar between the normal tree and the "hidden items of this workspace" panel — see hiddenGroupsInWorkspace/hiddenProfilesInWorkspace. */
    showHiddenPanel = false

    /**
     * 'tabs' (the original `.workspace-bar` strip, wraps onto more rows as
     * workspaces pile up) or 'dropdown' (a single-line "active workspace +
     * chevron" trigger opening the full list as a popup) — an explicit
     * per-user setting (workspaceSelectorMode in configProvider.ts's
     * defaults, exposed in the settings tab next to showWorkspaces), not an
     * auto-detected one. An earlier pass here drove this off a
     * ResizeObserver instead and was rejected in testing (2026-08-07): it
     * picked the layout out from under the user mid-session, and its
     * right-click handling inside the dropdown popup — opening a *second*
     * `.group-context-menu`-classed popup as a side effect of the very click
     * that removed the first one, both matched by the same
     * `document.querySelector()` in clampContextMenuPosition() — turned out
     * unreliable (the same class of ambiguity as piège #30, just never
     * exercised by any earlier feature the way this one does). See
     * openWorkspaceMenuFromSwitcher() below for how list mode manages a
     * workspace instead (each row's "⋯" button, fixed anchor, list kept
     * open underneath — not a right-click).
     */
    get workspaceSelectorMode (): 'tabs'|'dropdown' {
        return this.config.store.sidebarPlus?.workspaceSelectorMode ?? 'tabs'
    }

    ////// SFTP //////
    /**
     * Swaps the whole sidebar between the profile tree and the SFTP view of
     * the focused SSH session. Deliberately a *global* toggle for this first
     * pass rather than one state per tab: the roadmap leaves the question open
     * ("bascule par onglet ou globale ?"), and a single mode is the version
     * that can be judged in use before committing to per-tab bookkeeping.
     *
     * **Never restored across restarts**, by explicit user request
     * (2026-08-01): the sidebar always comes back on Profils. The SFTP view
     * only makes sense next to the session it was opened for, and that session
     * is gone after a restart — landing in it meant switching back by hand
     * every single time. The toggle stays session-local state, held in this
     * field alone.
     */
    sftpMode = false

    /**
     * Groups (isTemplate/blacklist already filtered, like profileGroups) but
     * *not* filtered by the active workspace's visibility — kept around so
     * the "show hidden" panel can still render a name/icon for something the
     * main tree currently excludes. Refreshed by every successful
     * loadTreeItems() call.
     */
    private rawGroupsSnapshot: PartialProfileGroup<ProfileGroup>[] = []
    /** Monotonic counter guarding against overlapping loadTreeItems() calls (e.g. a config.changed$ reload racing an explicit workspace switch) — only the most recently *started* call's results are ever committed, see loadTreeItems(). */
    private loadTreeRequestId = 0

    /**
     * Width committed to the sidebar and persisted across restarts. The host
     * binding is what actually sizes the element; the controller owns the
     * gesture state machine and the localStorage value (see sidebarResize.ts).
     */
    private resize = new SidebarResizeController(window.localStorage, {
        onCommit: (_width, collapsed) => {
            if (collapsed) {
                // Dragged shut: hide the sidebar. `showProfileTree` gates the
                // whole sidebar area, this owner contribution included. The
                // committed width is usable, so re-opening is not 0px.
                this.config.store.showProfileTree = false
                this.config.save()
            }
        },
        setCursor: resizing => {
            // Set on <body> rather than only on the grabber: the pointer
            // routinely leaves the 6px handle mid-drag, and the cursor has to
            // stay a resize cursor over the terminal until release.
            document.body.style.cursor = resizing ? 'col-resize' : ''
        },
    })

    @HostBinding('style.width.px')
    get panelWidth (): number {
        return this.resize.width
    }

    ////// RECENT PROFILES //////
    /**
     * Ids of the last profiles launched through launchProfile() — the single
     * point every launch path in this component funnels through — most
     * recent first, deduplicated, capped at MAX_RECENT_PROFILES.
     *
     * Persisted to `localStorage.sidebarPlusRecentProfiles`, deliberately
     * *not* `config.store.sidebarPlus`: this is per-machine usage, not
     * something a synced config.yaml should carry between machines — the
     * exact reasoning documented for `sidebarPlusActiveWorkspace` (switching
     * what you're looking at, here what you last launched, must not follow
     * you to another machine). See ROADMAP #historique-profils.
     *
     * Also deliberately not filtered by workspace, neither on write nor on
     * read: a launch is a fact of the app, the same reasoning already applied
     * to `activeSessions` above.
     */
    private recentProfileIds: string[] = SidebarPlusTreeComponent.loadRecentProfileIds()
    /** Per-machine UI state, same pattern as activeSessionsCollapsed. */
    recentProfilesCollapsed = window.localStorage.sidebarPlusRecentProfilesCollapsed === 'true'
    private static readonly MAX_RECENT_PROFILES = 5

    private static loadRecentProfileIds (): string[] {
        try {
            const raw = window.localStorage.sidebarPlusRecentProfiles
            if (!raw) {
                return []
            }
            const parsed = JSON.parse(raw)
            return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
        } catch {
            // Malformed localStorage (hand-edited, older format…) — worth
            // starting empty rather than throwing the sidebar's constructor.
            return []
        }
    }

    ////// SSH TUNNELS //////
    /** Live forwards are rendered by SidebarPlusActiveTunnelsComponent. */

    /** Profile clicked in the tree, previewed in the bottom panel. */
    previewProfile: PartialProfile<Profile>|null = null
    private configSubscription: Subscription|null = null

    contextMenuGroup: PartialProfileGroup<CollapsableProfileGroup>|null = null
    contextMenuProfile: PartialProfile<Profile>|null = null
    contextMenuRoot = false
    contextMenuX = 0
    contextMenuY = 0
    contextMenuMode:
        'menu'|'createGroup'|'createProfile'|'confirmDeleteProfile'|'rename'|
        'workspaceMenu'|'createWorkspace'|'renameWorkspace'|'confirmDeleteWorkspace'|'workspaceColor'
        = 'menu'
    /** Set whenever a context menu/popup opens or switches mode — checked once in ngAfterViewChecked() to clamp it back on-screen after Angular renders it at its real size. */
    private menuPositionDirty = false

    ////// LATERAL SUBMENUS (Manage / More, folder + profile menus) //////
    // Windows-style side panels for the folder and profile context menus,
    // which had grown to 13 top-level entries each and kept "extending
    // towards infinity" (user report). Only one plugin-wide field: the two
    // menus are mutually exclusive (contextMenuGroup xor contextMenuProfile),
    // so nothing needs to know which parent it belongs to.
    /** Which submenu is open, or none — opening either replaces the other, so a single field is enough. */
    activeSubmenu: 'manage'|'more'|null = null
    submenuX = 0
    submenuY = 0
    // The carrying entry's own rect at the moment it opened the submenu —
    // not just the x/y the submenu renders at, which clampSubmenuPosition()
    // is free to move. Needed to decide whether to flip the panel to the
    // entry's LEFT once its real width is known (piège #30's clamp only
    // pulls a box back inside the viewport, it never flips a side panel to
    // the other side of its anchor).
    private submenuAnchorLeft = 0
    private submenuAnchorRight = 0
    private submenuAnchorTop = 0
    /** Set whenever the submenu opens or moves — checked once in ngAfterViewChecked(), same pattern as menuPositionDirty above and for the same reason (the DOM must have rendered the panel at its real size first). */
    private submenuPositionDirty = false
    /**
     * Debounces the submenu's close-on-mouseleave so the diagonal path from
     * the carrying entry to the panel beside it doesn't trip it — the pointer
     * briefly leaves the entry before it reaches the panel. Cancelled by
     * cancelSubmenuClose() if the pointer lands back on the entry or on the
     * panel itself before it fires. Deliberately simple (a flat delay, no
     * triangle-of-tolerance geometry): the user asked to keep this part
     * simple, and ~150-200ms already covers the normal case.
     */
    private submenuCloseTimer: ReturnType<typeof setTimeout>|null = null

    ////// WORKSPACE SWITCHER (list mode) //////
    // Deliberately NOT a contextMenuMode value: the modes are mutually
    // exclusive, so as one the switcher died the moment any popup it spawned
    // opened (the "⋯" menu, rename, colour…) — every step of a manage flow
    // dismissed the panel underneath it, which is exactly what the user
    // rejected in testing (2026-08-07, "au moindre clic le panneau précédent
    // disparaît"). As its own flag it stays put while the ordinary
    // contextMenuMode machinery opens and closes popups NEXT to it, and
    // closeContextMenu() landing back on 'menu' leaves the list on screen.
    workspaceSwitcherOpen = false
    workspaceSwitcherX = 0
    workspaceSwitcherY = 0

    newGroupName = ''
    renameValue = ''
    profileTemplates: { provider: ProfileProvider<Profile>, template: PartialProfile<Profile> }[] = []

    // One getter per value of `contextMenuMode`, so the template never has to
    // spell the string out.
    //
    // The escaping this was once thought to work around is real but harmless:
    // pug does serialize `contextMenuMode === "icon"` as
    // `contextMenuMode === &quot;icon&quot;` in the compiled template, and
    // Angular decodes the entities before parsing the expression. Verified by
    // compiling this very template — sixteen bindings elsewhere in it rely on
    // quoted literals and work (`activeWorkspaceId === "all"`,
    // `group.icon ?? "far fa-folder"`, and the connection status dot among
    // them). So these getters are a readability choice, not a workaround: a
    // new mode does not *have* to get one.
    get isMenuMode (): boolean {
        return this.contextMenuMode === 'menu'
    }

    get isCreateGroupMode (): boolean {
        return this.contextMenuMode === 'createGroup'
    }

    get isCreateProfileMode (): boolean {
        return this.contextMenuMode === 'createProfile'
    }

    get isConfirmDeleteProfileMode (): boolean {
        return this.contextMenuMode === 'confirmDeleteProfile'
    }

    get isRenameMode (): boolean {
        return this.contextMenuMode === 'rename'
    }

    get isWorkspaceMenuMode (): boolean {
        return this.contextMenuMode === 'workspaceMenu'
    }

    get isCreateWorkspaceMode (): boolean {
        return this.contextMenuMode === 'createWorkspace'
    }

    get isRenameWorkspaceMode (): boolean {
        return this.contextMenuMode === 'renameWorkspace'
    }

    get isConfirmDeleteWorkspaceMode (): boolean {
        return this.contextMenuMode === 'confirmDeleteWorkspace'
    }

    get isWorkspaceColorMode (): boolean {
        return this.contextMenuMode === 'workspaceColor'
    }

    constructor (
        private config: ConfigService,
        private profilesService: ProfilesService,
        private app: AppService,
        private notifications: NotificationsService,
        private ngbModal: NgbModal,
        private zone: NgZone,
        private cdr: ChangeDetectorRef,
        private platform: PlatformService,
        private hotkeys: HotkeysService,
        private snippets: SidebarPlusSnippetsService,
        // Not `notifications` for anything the user has to read: Tabby's
        // `notice()` hard-codes a one-second timeout, which is gone before it
        // is seen. See notices.service.ts.
        private notices: SidebarPlusNoticesService,
        @Inject(ProfileProvider) private profileProviders: ProfileProvider<Profile>[],
        private injector: Injector,
        private i18n: SidebarPlusI18nService,
        private elementRef: ElementRef<HTMLElement>,
        private live: SidebarPlusLiveStateService,
        private workspaceStore: SidebarPlusWorkspaceStore,
    ) {
        this.drag = new SidebarPlusTreeDragController(
            this.config,
            this.profilesService,
            this.snippets,
            this.notifications,
            this.i18n,
            this.zone,
            {
                getProfileGroups: () => this.profileGroups,
                getRawGroupsSnapshot: () => this.rawGroupsSnapshot,
                getActiveWorkspace: () => this.activeWorkspace,
                getWorkspaces: () => this.workspaces,
                publishWorkspaces: workspaces => {
                    this.config.store.sidebarPlus ??= {}
                    this.config.store.sidebarPlus.workspaces = workspaces
                },
                moveNote: (oldId, newId) => this.moveNote(oldId, newId),
                setPreviewProfile: profile => {
                    this.previewProfile = profile
                },
                closeContextMenu: () => this.closeContextMenu(),
            },
        )
    }

    /**
     * Reads the background plugin's transparency settings (if installed) and
     * mirrors them onto this sidebar via CSS variables. This keeps the two
     * plugins decoupled: background never has to know about sidebar-plus, and
     * sidebar-plus opt-in to the background plugin's sliders on its own terms.
     *
     * Safe to call when the background plugin is absent — `backgroundPlugin`
     * is simply undefined on the store, and both custom properties fall back
     * to their SCSS defaults.
     */
    private applyBackgroundTransparency (): void {
        const host = this.elementRef.nativeElement
        const bg = (this.config.store as { backgroundPlugin?: {
            backgroundEnabled?: boolean
            backgroundSidebarTransparent?: number
            backgroundFooterTransparent?: number
        } }).backgroundPlugin

        // Each surface gets its own transparency factor so popups and inputs
        // stay more legible than the tree rows when the sidebar is translucent.
        // `t` is 0..100 from the background plugin's sidebar slider. When the
        // plugin is off or t === 0 every variable falls back to the fully
        // opaque theme colour via the SCSS defaults.
        if (bg?.backgroundEnabled && (bg.backgroundSidebarTransparent ?? 0) > 0) {
            const t = bg.backgroundSidebarTransparent!
            const mix = (color: string, factor: number): string =>
                `color-mix(in srgb, ${color} ${100 - t * factor}%, transparent)`

            host.style.setProperty(
                '--sidebar-plus-bg',
                `color-mix(in srgb, var(--theme-bg-more-2) ${100 - t}%, transparent)`,
            )
            // Tree rows: hover lighter, selected a touch stronger.
            host.style.setProperty('--sidebar-plus-hover-bg', mix('var(--theme-secondary)', 0.6))
            host.style.setProperty('--sidebar-plus-selected-bg', mix('var(--theme-secondary)', 0.8))
            // Action button strip behind the row's right edge.
            host.style.setProperty('--sidebar-plus-actions-bg', mix('var(--theme-secondary)', 0.7))
            // View-mode tabs (profiles / sessions / sftp).
            host.style.setProperty('--sidebar-plus-tab-bg', mix('var(--theme-bg-more-2)', 0.55))
            host.style.setProperty('--sidebar-plus-tab-hover-bg', mix('var(--theme-secondary)', 0.6))
            host.style.setProperty('--sidebar-plus-tab-active-bg', mix('var(--theme-primary)', 0.3))
            // Filter input.
            host.style.setProperty('--sidebar-plus-input-bg', mix('var(--theme-bg-more-2)', 0.55))
            host.style.setProperty('--sidebar-plus-input-focus-bg', mix('var(--theme-bg-more-2)', 0.3))
            // Floating popups: keep mostly opaque so they stay readable.
            host.style.setProperty('--sidebar-plus-popup-bg', mix('var(--theme-bg)', 0.25))
            host.style.setProperty('--sidebar-plus-popup-hover-bg', mix('var(--theme-secondary)', 0.4))
        } else {
            ;[
                '--sidebar-plus-bg',
                '--sidebar-plus-hover-bg',
                '--sidebar-plus-selected-bg',
                '--sidebar-plus-actions-bg',
                '--sidebar-plus-tab-bg',
                '--sidebar-plus-tab-hover-bg',
                '--sidebar-plus-tab-active-bg',
                '--sidebar-plus-input-bg',
                '--sidebar-plus-input-focus-bg',
                '--sidebar-plus-popup-bg',
                '--sidebar-plus-popup-hover-bg',
            ].forEach(v => host.style.removeProperty(v))
        }

        if (bg?.backgroundEnabled && bg.backgroundFooterTransparent != null) {
            const t = bg.backgroundFooterTransparent
            host.style.setProperty(
                '--sidebar-plus-footer-bg',
                `color-mix(in srgb, rgba(0,0,0,1) ${100 - t}%, transparent)`,
            )
        } else {
            host.style.removeProperty('--sidebar-plus-footer-bg')
        }
    }

    /**
     * Translates a `{ message, params }` handed back by a module with no
     * injector access of its own — `profileModal.ts`, `groupShare.ts`,
     * `workspaceShare.ts`, `svgSanitizer.ts` — at the one place that holds
     * `this.i18n`.
     */
    private tMsg (msg: TranslatableMessage): string {
        return this.i18n.t(msg.message, msg.params)
    }

    /**
     * `describePurge()`'s clauses, translated and joined — the sentence that
     * function used to build itself before it lost injector access. Empty
     * string when nothing was taken out, same as before.
     */
    private describePurgeText (report: PurgeReport): string {
        return describePurge(report).map(part => this.tMsg(part)).join(', ')
    }

    async ngOnInit (): Promise<void> {
        // Clamp the persisted width before the first paint: a hand-edited or
        // stale value (e.g. left behind by a drag past the window edge) can
        // fall outside the usable range. The controller re-persists the
        // repaired value right away so every later startup starts from it.
        this.resize.clampAndPersist()
        // Apply the background plugin's transparency settings (if any) before
        // the first paint so the sidebar doesn't flash opaque.
        this.applyBackgroundTransparency()
        await this.loadTreeItems()
        // Kept so ngOnDestroy can drop it. The component *is* destroyed —
        // SidebarPlusMountService unmounts it when `sidebarPlus.enabled` goes
        // false — and an orphaned subscription here means a dead component
        // still rebuilding the whole tree on every config.save() of the
        // application, twice cloned, for as long as the window lives.
        this.configSubscription = this.config.changed$.subscribe(() => {
            // The background plugin's transparency sliders live under
            // backgroundPlugin — re-apply whenever any config changes.
            this.applyBackgroundTransparency()
            // Before the reload, not after: switching a block off can change
            // the active workspace or drop the filter, both of which decide
            // what loadTreeItems() is supposed to build.
            this.reconcileHiddenBlocks()
            void this.loadTreeItems()
            // Block toggles and the SFTP view switch are all read directly by
            // the live projection; rebuild it now rather than waiting for the
            // next poll or registry event.
            this.live.refreshAll()
        })

        // hotkey$, not unfilteredHotkey$: the filtered stream stays quiet while
        // a text field holds the focus, which is what keeps this from firing
        // while the user is typing in the filter field it would focus.
        this.hotkeySubscription = this.hotkeys.hotkey$.subscribe(id => {
            if (id === FOCUS_FILTER_HOTKEY) {
                this.focusFilter()
            }
        })

        // Starts the 2s poll and the focus subscriptions that keep the live
        // sessions/tunnels list and the profile preview in step with the app.
        this.live.start({
            onTabStateChanged: () => this.tabStateChanged(),
        })
    }

    ngOnDestroy (): void {
        // A resize gesture can outlive the component — SidebarPlusMountService
        // unmounts it when the plugin is disabled — so clear the app-wide
        // cursor and the drag state here instead of leaving them stuck.
        this.resize.cancel()
        this.live.stop()
        this.configSubscription?.unsubscribe()
        this.hotkeySubscription?.unsubscribe()
        this.drag.dispose()
    }

    ngAfterViewChecked (): void {
        if (this.submenuPositionDirty) {
            this.submenuPositionDirty = false
            setTimeout(() => this.clampSubmenuPosition())
        }
        if (!this.menuPositionDirty) {
            return
        }
        this.menuPositionDirty = false
        // Deferred by one turn of the event loop instead of measuring right
        // here. When a menu item swaps one popup for another (mode 'menu' →
        // 'createGroup'), both *ngIf branches flip in the SAME change
        // detection pass, and the DOM read from ngAfterViewChecked still
        // contains the OUTGOING element: the clamp then measures the old
        // menu's height instead of the new popup's and concludes there is
        // nothing to correct. Measured 2026-07-29 on the real bug:
        // `mode=createGroup elt=group-context-menu h=74` while the popup that
        // actually rendered was 109px tall — off-screen by exactly the 35px
        // difference. Opening a menu by right-click was unaffected only
        // because the previous popup had been destroyed in an earlier pass,
        // leaving the DOM already consistent.
        //
        // setTimeout is patched by Zone.js, so the callback runs inside
        // Angular and the corrected contextMenuX/Y are picked up by the pass
        // it schedules. No loop: menuPositionDirty is already false and the
        // clamp never sets it back.
        setTimeout(() => this.clampContextMenuPosition())
    }

    /** Keeps whichever context menu/popup is currently open fully within the viewport — a right-click near the bottom/right edge of a tall sidebar would otherwise render partially under the taskbar or off-screen and be unusable. */
    private clampContextMenuPosition (): void {
        // :not(.workspace-switcher-menu): the switcher has its own fixed
        // anchor and its own coordinates, and can be on screen at the same
        // time as the contextMenuMode popup this clamp is aimed at — without
        // the exclusion, whichever comes first in DOM order would be measured
        // and the other one nudged to its position (piège #30's ambiguity,
        // made permanent now that the two coexist by design).
        const menu = document.querySelector<HTMLElement>('.group-context-menu:not(.workspace-switcher-menu), .create-popup')
        if (!menu) {
            return
        }
        const { x, y } = clampInViewport(menu, this.contextMenuX, this.contextMenuY)
        if (x !== this.contextMenuX || y !== this.contextMenuY) {
            this.contextMenuX = x
            this.contextMenuY = y
            // Written straight onto the element as well as onto the bound
            // fields. This runs in ngAfterViewChecked, i.e. *after* Angular
            // has already rendered [style.left.px]/[style.top.px] for this
            // pass, so updating the fields alone only reaches the DOM if some
            // later event happens to schedule another change-detection pass.
            //
            // That is exactly why the bug looked selective: a right-click menu
            // is opened on `contextmenu`, which is followed by `mouseup` —
            // that extra event ran another pass and the corrected position
            // landed by luck. A popup opened from a menu item (new folder,
            // rename, delete confirmation) is opened on `click`,
            // the LAST event of its sequence, so nothing ever repainted it and
            // it stayed wherever it first rendered, off-screen included.
            // Assigning the style here makes the clamp land on the same frame
            // the popup appears, for every popup, whatever opened it.
            // detectChanges() would also work but risks a loop from inside
            // ngAfterViewChecked.
            menu.style.left = `${x}px`
            menu.style.top = `${y}px`
        }
    }

    /**
     * Positions the open lateral submenu beside the entry that carries it —
     * flipped to the entry's LEFT when there is no room to its right — then
     * runs the result through clampInViewport(), the plugin's one point for
     * pulling a floating element back on screen (piège #30). Same deferred
     * pattern as clampContextMenuPosition() and for the same reason: the
     * panel's real width is only known once Angular has actually rendered it.
     */
    private clampSubmenuPosition (): void {
        const panel = document.querySelector<HTMLElement>('.group-context-submenu')
        if (!panel) {
            return
        }
        const width = panel.getBoundingClientRect().width
        const fitsRight = this.submenuAnchorRight + width <= window.innerWidth
        const x = fitsRight ? this.submenuAnchorRight : this.submenuAnchorLeft - width
        const { x: clampedX, y: clampedY } = clampInViewport(panel, x, this.submenuAnchorTop)
        this.submenuX = clampedX
        this.submenuY = clampedY
        panel.style.left = `${clampedX}px`
        panel.style.top = `${clampedY}px`
    }

    /**
     * Returns whether this call's results were actually applied to
     * this.profileGroups/this.rootGroups. False means a newer loadTreeItems()
     * call was started (by config.changed$ or an explicit workspace switch)
     * before this one finished, and its results were discarded in favor of
     * that newer call's — see the requestId guard at the end.
     */
    private async loadTreeItems (): Promise<boolean> {
        const requestId = ++this.loadTreeRequestId
        const profileGroupCollapsed = JSON.parse(window.localStorage.sidebarPlusGroupCollapsed ?? '{}')

        // Snapshot workspace state now, before the first await below.
        // Re-reading this.activeWorkspaceId/this.workspaces *after* an await
        // would risk this call picking up a mutation made by a different,
        // concurrently-running call (e.g. switching workspaces twice in
        // quick succession) partway through its own computation — exactly
        // the class of bug the final requestId check guards against.
        const workspaces = this.config.store.sidebarPlus?.workspaces ?? []
        let activeWorkspaceId = this.activeWorkspaceId
        if (activeWorkspaceId !== 'all' && !workspaces.some(w => w.id === activeWorkspaceId)) {
            // Active workspace was deleted (e.g. from another machine's sync) — fall back rather than filtering on stale ids forever.
            activeWorkspaceId = 'all'
        }
        const workspace = activeWorkspaceId === 'all' ? null : (workspaces.find(w => w.id === activeWorkspaceId) ?? null)

        // Cloned by readProfileGroups(), which is the only place this plugin
        // calls getProfileGroups() — buildGroupTree() below writes a computed
        // `.children` onto whatever it is handed, and that must never be a live
        // config.store object (piège #12).
        let groups = await readProfileGroups(this.profilesService, this.config)

        for (const group of groups) {
            if (group.profiles?.length) {
                group.profiles = group.profiles.filter(x => !x.isTemplate)
                group.profiles = group.profiles.filter(x => x.id && !this.config.store.profileBlacklist.includes(x.id))
            }
        }

        // Independent copy, kept *not* filtered by workspace visibility —
        // the "show hidden" panel (hiddenGroupsInWorkspace/
        // hiddenProfilesInWorkspace) needs to render name/icon for groups
        // and profiles the tree below is about to filter out. Must be a
        // separate clone, not just a reference to `groups`: the profile
        // sort/filter below mutates each group's `.profiles` in place.
        const rawGroupsSnapshot = structuredClone(groups)

        const { hiddenGroupIds, hiddenProfileIds } = SidebarPlusTreeComponent.computeWorkspaceFilterState(groups, workspace)

        if (hiddenGroupIds.size) {
            groups = groups.filter(g => !hiddenGroupIds.has(g.id))
        }

        // Sibling order (both groups and profiles) is independent per
        // workspace: a workspace's own groupOrder/profileOrder takes
        // priority when it has an entry for that parent/group, otherwise
        // falls back to the "Tous" order (top-level groupOrder / native
        // weight) — so a freshly created workspace starts out matching the
        // current visual order until the user reorders within it.
        for (const group of groups) {
            if (group.profiles?.length) {
                if (hiddenProfileIds.size) {
                    group.profiles = group.profiles.filter(x => !hiddenProfileIds.has(x.id!))
                }
                const workspaceProfileOrder = workspace?.profileOrder?.[group.id]
                if (workspaceProfileOrder?.length) {
                    // Same per-item fallback as groupOrderIndex() below: a
                    // profile the user never reordered in this workspace keeps
                    // its "Tous" position (native weight) instead of being
                    // dumped at the end of the list.
                    const profileOrderIndex = (p: PartialProfile<Profile>): number =>
                        (p.id ? workspaceProfileOrder.indexOf(p.id) : -1)
                    group.profiles.sort((a, b) => {
                        const ia = profileOrderIndex(a)
                        const ib = profileOrderIndex(b)
                        if (ia !== -1 && ib !== -1) {
                            return ia - ib
                        }
                        return (a.weight ?? 0) - (b.weight ?? 0)
                    })
                } else {
                    group.profiles.sort((a, b) => (a.weight ?? 0) - (b.weight ?? 0))
                }
            }
        }

        if (!this.config.store.terminal.showBuiltinProfiles) {
            groups = groups.filter(g => g.id !== 'built-in')
        }
        groups = groups.filter(g => g.id !== 'ungrouped' || (g.profiles?.length ?? 0) > 0)

        const topGroupOrder: Record<string, string[]> = this.config.store.sidebarPlus?.groupOrder ?? {}
        // Fallback resolved PER ITEM, not per parent key. The roadmap's rule
        // is "a folder not yet reordered in this workspace falls back to the
        // Tous order", and gating on the whole list (`workspaceOrder?.length
        // ? ... : ...`) did not implement it: as soon as a workspace had any
        // entry for that parent, every folder missing from it — including one
        // the user had never touched there — skipped the "Tous" order entirely
        // and went to MAX_SAFE_INTEGER, i.e. straight to alphabetical.
        // A list holding only dead ids (which the reparent bug above produced)
        // is the extreme case: non-empty, so it suppressed the fallback
        // completely while ordering nothing at all.
        const groupOrderIndex = (g: PartialProfileGroup<ProfileGroup>): number => {
            const parentKey = (g as any).parentGroupId ?? 'root'
            const workspaceIndex = workspace?.groupOrder?.[parentKey]?.indexOf(g.id) ?? -1
            if (workspaceIndex !== -1) {
                return workspaceIndex
            }
            const topIndex = topGroupOrder[parentKey]?.indexOf(g.id) ?? -1
            return topIndex === -1 ? Number.MAX_SAFE_INTEGER : topIndex
        }
        groups.sort((a, b) => groupOrderIndex(a) - groupOrderIndex(b) || a.name.localeCompare(b.name))
        groups.sort((a, b) => (a.id === 'built-in' || !a.editable ? 1 : 0) - (b.id === 'built-in' || !b.editable ? 1 : 0))
        groups.sort((a, b) => (a.id === 'ungrouped' ? 0 : 1) - (b.id === 'ungrouped' ? 0 : 1))

        const profileGroups = groups.map(g => intoCollapsable(g, profileGroupCollapsed[g.id] ?? false))
        const rootGroups = this.applyFavorites(this.profilesService.buildGroupTree(profileGroups), workspace, profileGroups)

        if (requestId !== this.loadTreeRequestId) {
            // Superseded by a newer call started while we were awaiting above — discard, the newer call owns the final state.
            return false
        }

        this.workspaceStore.commit(workspaces, activeWorkspaceId, this.showWorkspaces)
        this.rawGroupsSnapshot = rawGroupsSnapshot
        // The snippet service walks a profile up to the root and has no
        // snapshot of its own — see `useGroups()` for why it is handed one
        // rather than fetching it.
        this.snippets.useGroups(rawGroupsSnapshot)
        this.profileGroups = profileGroups
        this.rootGroups = rootGroups
        return true
    }

    /**
     * Computes, from the *unfiltered* raw group list, the cascaded set of
     * hidden group ids (a hidden parent hides its descendants too, for
     * rendering — buildGroupTree() would otherwise silently drop orphaned
     * children rather than promoting them) and the hidden profile ids. Pure
     * function of its arguments so loadTreeItems() can call it safely
     * regardless of what this.activeWorkspace might have changed to by the
     * time an overlapping call resumes.
     */
    private static computeWorkspaceFilterState (
        rawGroups: PartialProfileGroup<ProfileGroup>[],
        workspace: SidebarWorkspace|null,
    ): { hiddenGroupIds: Set<string>, hiddenProfileIds: Set<string> } {
        if (!workspace) {
            return { hiddenGroupIds: new Set(), hiddenProfileIds: new Set() }
        }

        const byId = new Map(rawGroups.map(g => [g.id, g]))
        const directHidden = new Set(workspace.hiddenGroupIds)
        const cache = new Map<string, boolean>()
        const isHiddenById = (id: string): boolean => {
            if (cache.has(id)) {
                return cache.get(id)!
            }
            let result: boolean
            if (directHidden.has(id)) {
                result = true
            } else {
                const parentId = byId.get(id)?.parentGroupId
                result = parentId ? isHiddenById(parentId) : false
            }
            cache.set(id, result)
            return result
        }

        return {
            hiddenGroupIds: new Set(rawGroups.filter(g => isHiddenById(g.id)).map(g => g.id)),
            hiddenProfileIds: new Set(workspace.hiddenProfileIds),
        }
    }

    async launchProfile<P extends Profile> (profile: PartialProfile<P>): Promise<any> {
        this.noticeUnansweredVariables(profile)
        this.recordRecentProfile(profile)
        return this.profilesService.launchProfile(this.withWorkspaceColor(profile))
    }

    /**
     * Pushes a launch onto the MRU trail — gated on showRecentProfiles so
     * that switching the block off stops the recording, not just the
     * display (the project's "un interrupteur de bloc coupe la source" rule).
     * Silently does nothing for a profile with no id (a template preview,
     * never actually reachable through launchProfile(), but nothing here
     * should assume it).
     */
    private recordRecentProfile (profile: PartialProfile<Profile>): void {
        if (!this.showRecentProfiles || !profile.id) {
            return
        }
        const id = profile.id
        this.recentProfileIds = [id, ...this.recentProfileIds.filter(existing => existing !== id)]
            .slice(0, SidebarPlusTreeComponent.MAX_RECENT_PROFILES)
        window.localStorage.sidebarPlusRecentProfiles = JSON.stringify(this.recentProfileIds)
    }

    /**
     * Resolves the MRU ids against the same in-memory profile list the tree
     * itself is built from — `rawGroupsSnapshot`, the workspace-*unfiltered*
     * snapshot `loadTreeItems()` refreshes on every reload — rather than
     * `config.store.profiles`, which omits provider-supplied profiles
     * entirely (piège #74: testing existence there would silently drop a
     * still-live entry, not just fail to show a dead one).
     *
     * An id that fails to resolve is skipped here, never removed from
     * `recentProfileIds`: unlike a deleted profile (which forgetDeletedId()
     * actively forgets from every workspace's state), a provider-supplied
     * profile can be resolvable again the next time its provider lists it,
     * so dropping it from the trail on one miss would be premature.
     *
     * Not filtered by the active workspace, on purpose — same "fact of the
     * app" reasoning as `activeSessions`, see ROADMAP #historique-profils.
     */
    get recentProfiles (): PartialProfile<Profile>[] {
        if (!this.showRecentProfiles || !this.recentProfileIds.length) {
            return []
        }
        const byId = new Map<string, PartialProfile<Profile>>()
        for (const group of this.rawGroupsSnapshot) {
            for (const profile of group.profiles ?? []) {
                if (profile.id) {
                    byId.set(profile.id, profile)
                }
            }
        }
        const resolved: PartialProfile<Profile>[] = []
        for (const id of this.recentProfileIds) {
            const profile = byId.get(id)
            if (profile) {
                resolved.push(profile)
            }
        }
        return resolved
    }

    toggleRecentProfiles (): void {
        this.recentProfilesCollapsed = !this.recentProfilesCollapsed
        window.localStorage.sidebarPlusRecentProfilesCollapsed = this.recentProfilesCollapsed
    }

    /** The row's whole click target — a relaunch, nothing else (no context menu, no favorite, no status: a pure re-engagement shortcut, per ROADMAP #historique-profils). */
    launchRecentProfile (profile: PartialProfile<Profile>, event: MouseEvent): void {
        event.preventDefault()
        void this.launchProfile(profile)
    }

    /**
     * Tints a launch with the active workspace's color — on a *clone*, never
     * the live profile (piège #12: a mutation of the profile the tree still
     * renders is exactly what corrupted the user's config.yaml once).
     *
     * No new coloring mechanism: `ProfilesService.newTabParametersForProfile()`
     * (tabby-core, services/profiles.service.ts) already reads
     * `fullProfile.color` and forwards it as the new tab's `color` input —
     * the same field `profile-icon` colors its glyph with and
     * `TabHeaderComponent` draws a `.colorbar` from. `TAB_COLORS`
     * (tabby-core/utils.ts) is the very palette this plugin's workspace color
     * picker offers, so a workspace-tinted session looks identical to one
     * colored by hand from a tab's own native menu. This only decides which
     * value reaches that existing field.
     *
     * "Tous" never colors anything — `activeWorkspace` is already null there
     * — and a profile's own explicit color always wins: the workspace only
     * fills in what the profile left blank, it never overrides a choice
     * already made on the profile itself.
     */
    private withWorkspaceColor<P extends Profile> (profile: PartialProfile<P>): PartialProfile<P> {
        const workspace = this.activeWorkspace
        if (!workspace?.color || profile.color) {
            return profile
        }
        const tinted = structuredClone(profile)
        tinted.color = workspace.color
        return tinted
    }

    /**
     * Says, when a session opens, that snippets of this profile are waiting on
     * a value.
     *
     * The one moment worth saying it: a snippet edited in the settings tab can
     * introduce a placeholder that every profile already attached to it now
     * needs, and nothing else would surface that until someone clicked the
     * snippet and got a refusal. Here it arrives while the user is looking at
     * the profile.
     *
     * Keyed on the *set of missing names*, not on the profile: the same profile
     * has to speak up again when a snippet changes what it asks for, and stay
     * quiet when nothing has changed. That is also what keeps a folder-wide
     * launch from stacking one toast per session.
     */
    private noticeUnansweredVariables (profile: PartialProfile<Profile>): void {
        // Switched off means gone, not merely hidden: no menu entry, and no
        // work done on every launch for a feature nobody is using.
        if (!this.showSnippets) {
            return
        }
        const missing = this.snippets.unansweredFor(profile)
        if (!missing.length) {
            return
        }
        // Named per snippet, never merged into one list: the same placeholder
        // can be asked by two commands and mean two different things, so a bare
        // "{{path}} manque" would point at the wrong field.
        const detail = missing
            .map(entry => `${entry.snippet} : ${entry.names.map(name => `{{${name}}}`).join(', ')}`)
            .join(' · ')
        const key = `${profile.id ?? ''}|${detail}`
        if (this.variableNoticesShown.has(key)) {
            return
        }
        this.variableNoticesShown.add(key)
        this.notices.notice(
            this.i18n.t('Variables to fill in on "{name}"', { name: profile.name }),
            this.i18n.t('{detail}: right-click the profile, "Snippets", then the snippet settings button.', { detail }),
        )
    }

    /** What noticeUnansweredVariables() has already said this session — see there for why the key is the missing set and not the profile. */
    private readonly variableNoticesShown = new Set<string>()

    async launchProfileFromMenu (profile: PartialProfile<Profile>): Promise<void> {
        this.closeContextMenu()
        await this.launchProfile(profile)
    }

    /**
     * Launches the group's direct profiles, each in its own tab.
     *
     * No recursion into sub-groups, no split panes, no synced multi-input —
     * and none of the three is a gap left for later. They were the whole of
     * the "Group Exec" roadmap item, and all three were declined on 2026-08-03
     * once put as a question: recursion because forty sessions leave as easily
     * as four, splits because they only read well on the few servers one would
     * not have targeted a whole folder for, and broadcast because typing into
     * twelve production machines must not be a side effect of "open
     * everything". Tabby's own multi-input remains reachable by its hotkeys,
     * which is where it belongs.
     */
    async launchGroupSessions (group: PartialProfileGroup<CollapsableProfileGroup>): Promise<void> {
        this.closeContextMenu()
        const profiles = group.profiles ?? []
        if (!profiles.length) {
            this.notifications.notice(this.i18n.t('This folder contains no profile to launch'))
            return
        }
        await Promise.all(profiles.map(profile => this.launchProfile(profile)))
    }

    /**
     * Puts the cursor in the filter field, selecting whatever is already in it
     * so a second search overwrites the first instead of appending to it.
     *
     * Switches back to the profile tree first when the sidebar is showing SFTP:
     * the field does not exist in that view, and doing nothing at all would
     * make the hotkey look broken. The focus is deferred one turn because the
     * field is only rendered on the change detection pass that follows.
     */
    focusFilter (): void {
        if (!this.showFilter) {
            // Switching the view to the profiles for a field that is not there
            // would be worse than doing nothing: the hotkey would appear to
            // work, and take the user out of SFTP for nothing.
            return
        }
        this.zone.run(() => {
            this.sftpMode = false
            this.showHiddenPanel = false
        })
        setTimeout(() => {
            const input = this.filterInput?.nativeElement
            input?.focus()
            input?.select()
        })
    }

    /**
     * Whether the tree currently shows search results rather than itself.
     *
     * Drag and drop is switched off while it does, and that is a fix, not a
     * restriction: the results are a flat rearrangement of the real tree, so
     * dropping inside them writes an order nobody asked for. On "Tous" it goes
     * straight to the profiles' native `weight` — the search order becoming the
     * real order — and inside a workspace it files a `profileOrder` under the
     * fake `search` group id, which nothing ever reads again.
     */
    get filtering (): boolean {
        return this.filter.trim().length > 0
    }

    /** `Échap` in the field: drop the filter and hand the focus back, rather than leave a filter nobody can see the cause of. */
    clearFilter (): void {
        this.filter = ''
        this.filterInput?.nativeElement.blur()
        void this.onFilterChange()
    }

    async onFilterChange (): Promise<void> {
        const q = this.filter.trim().toLowerCase()

        if (q.length === 0) {
            this.rootGroups = this.applyFavorites(this.profilesService.buildGroupTree(this.profileGroups))
            return
        }

        const profiles = await this.profilesService.getProfiles({
            includeBuiltin: this.config.store.terminal.showBuiltinProfiles,
            clone: true,
        })

        // Deliberately searches everywhere, ignoring the active workspace's
        // visibility filter — a workspace only controls what the *tree*
        // shows by default, it shouldn't make something unfindable by name.
        //
        // `options.host`/`options.user` alongside the name: fuzzy-search walks
        // a dotted key, and a server one only remembers by address would
        // otherwise be unreachable from here. Absent on a non-SSH profile,
        // which the search simply skips.
        const searchable = profiles.filter(p => !p.isTemplate)
        const matches: PartialProfile<Profile>[] = new FuzzySearch(
            searchable,
            ['name', 'description', 'options.host', 'options.user'],
            { sort: false },
        ).search(q)

        // Notes are searched in a second pass rather than as one more key of
        // the fuzzy search, which would have meant grafting the text onto each
        // profile: those very objects are what the tree renders and what
        // launch/duplicate are handed, so a computed field riding along into
        // `config.store` is piège #12's exact shape.
        //
        // A plain substring match, not fuzzy: what one looks for in a memo is a
        // ticket number or a hostname, where an approximate hit is noise.
        if (this.showNotes) {
            const needle = q.toLowerCase()
            const alreadyFound = new Set(matches.map(p => p.id))
            matches.push(...searchable.filter(p =>
                !alreadyFound.has(p.id) && this.noteFor(p.id).toLowerCase().includes(needle)))
        }

        this.rootGroups = [
            ...this.matchingGroups(q),
            {
                id: 'search',
                editable: false,
                name: 'Filter results',
                icon: 'fas fa-magnifying-glass',
                profiles: matches,
            },
        ]
    }

    /**
     * Folders whose own name matches, rendered above the profile results with
     * their contents — searching for a folder and being shown only the profiles
     * inside it was the gap here.
     *
     * Built from `rawGroupsSnapshot` for the same reason the profile search
     * uses the full profile list: a workspace hides things from the tree, it
     * does not make them unfindable. Collapsed state is forced open, since a
     * folder returned by a search that renders shut says nothing at all.
     */
    private matchingGroups (q: string): PartialProfileGroup<ProfileGroup>[] {
        const matches = new FuzzySearch(this.rawGroupsSnapshot, ['name'], { sort: false }).search(q)
        if (!matches.length) {
            return []
        }
        // `buildGroupTree` over the *whole* snapshot, then pick the matching
        // nodes out of the result: run over the matches alone, it would drop
        // the children of a matching folder whose parent did not match.
        const tree = this.profilesService.buildGroupTree(
            structuredClone(this.rawGroupsSnapshot).map(g => intoCollapsable(g, false)),
        )
        const matchedIds = new Set(matches.map(g => g.id))
        const found: PartialProfileGroup<ProfileGroup>[] = []
        const walk = (groups: PartialProfileGroup<ProfileGroup>[]): void => {
            for (const group of groups) {
                if (matchedIds.has(group.id)) {
                    found.push(group)
                    // No recursion into a folder already returned: its subtree
                    // is rendered under it, and listing a matching child a
                    // second time at top level would show it twice.
                    continue
                }
                walk((group as PartialProfileGroup<CollapsableProfileGroup>).children ?? [])
            }
        }
        walk(tree)
        return found
    }

    ////// WORKSPACES //////
    get activeWorkspace (): SidebarWorkspace|null {
        return this.workspaceStore.activeWorkspace
    }

    /**
     * Keeps session group headers attached to their category even when the
     * `sessionGroups` array is rebuilt — see SidebarPlusActiveSessionsComponent.
     */
    selectWorkspace (id: string): void {
        this.workspaceStore.select(id)
        this.showHiddenPanel = false
        this.closeContextMenu()
        // Picking a workspace is the switcher's terminal action — unlike the
        // manage flows, which keep the list open underneath (see the field's
        // own comment). No-op when the pick came from a tab.
        this.workspaceSwitcherOpen = false
        this.refreshTree()
    }

    /** Single re-entry point after anything that changes what should be visible (workspace switch, config change) — re-derives rootGroups from scratch, honoring an in-progress text filter if there is one. */
    private async refreshTree (): Promise<void> {
        const applied = await this.loadTreeItems()
        if (applied && this.filter.trim()) {
            await this.onFilterChange()
        }
    }

    /**
     * Opens the Renommer/Icône/Couleur/Copier/Supprimer menu for one
     * workspace, anchored at `event.clientX/Y`. One call site in the .pug: a
     * tab's own `(contextmenu)` in tabs mode, where at-the-cursor is the OS
     * convention. List mode goes through openWorkspaceMenuFromSwitcher()
     * below instead — same menu, fixed anchor.
     *
     * List mode does *not* wire this to a row's `(contextmenu)` either —
     * tried and reported unreliable in testing (2026-08-07), reverted
     * without a live repro to confirm the exact mechanism. The prime
     * suspect: the row that received the `contextmenu` event sat inside the
     * switcher popup, which (as a contextMenuMode value at the time) was
     * torn down by the very mutation its own handler made; the incoming
     * workspaceMenu popup shares the plain `.group-context-menu` class that
     * `document.querySelector()` in clampContextMenuPosition() matches on.
     * Same *kind* of outgoing-vs-incoming ambiguity as piège #30. The
     * switcher no longer being a mode removes the teardown half of that
     * race, but the right-click stays unwired: the "⋯" button is the one
     * documented entry, and it is a plain click with nothing to race.
     */
    onWorkspaceTabContextMenu (event: MouseEvent, workspace: SidebarWorkspace): void {
        event.preventDefault()
        event.stopPropagation()
        this.contextMenuGroup = null
        this.contextMenuProfile = null
        this.contextMenuRoot = false
        this.contextMenuWorkspace = workspace
        this.contextMenuMode = 'workspaceMenu'
        this.contextMenuX = event.clientX
        this.contextMenuY = event.clientY
        this.menuPositionDirty = true
    }

    openCreateWorkspacePrompt (event: MouseEvent): void {
        event.preventDefault()
        event.stopPropagation()
        this.contextMenuWorkspace = null
        this.contextMenuMode = 'createWorkspace'
        this.newWorkspaceName = ''
        this.contextMenuX = event.clientX
        this.contextMenuY = event.clientY
        this.menuPositionDirty = true
    }

    /**
     * Toggles the workspace list popup that stands in for `.workspace-bar`
     * in 'dropdown' mode (see workspaceSelectorMode). Anchored to the compact
     * bar itself, never to the click position: the popup replaces the tab
     * strip, so it belongs under the control that opened it, and reopening it
     * must land in the same place every time (user request, 2026-08-07 —
     * fixed positions, not wherever the mouse happened to be).
     *
     * Left-click on an entry calls selectWorkspace(), which closes the popup
     * as its terminal action. Managing a workspace (Renommer/Icône/Couleur/
     * Copier/Supprimer) goes through each row's own "⋯" button, wired to
     * openWorkspaceMenuFromSwitcher() — which opens NEXT to this popup and
     * leaves it on screen underneath.
     */
    openWorkspaceSwitcher (event: MouseEvent): void {
        event.preventDefault()
        event.stopPropagation()
        if (this.workspaceSwitcherOpen) {
            this.workspaceSwitcherOpen = false
            return
        }
        const bar = (event.currentTarget as HTMLElement).getBoundingClientRect()
        this.workspaceSwitcherX = Math.round(bar.left)
        this.workspaceSwitcherY = Math.round(bar.bottom + 2)
        this.workspaceSwitcherOpen = true
    }

    /**
     * Where popups spawned FROM the switcher anchor: flush against its right
     * edge, level with its top. One fixed spot for every "⋯" row and for
     * "Nouveau workspace...", so a manage flow reads as a stable second
     * column next to the list instead of hopping to wherever each click
     * landed. The sub-popups a manage flow then opens (rename, colour,
     * delete…) never touch contextMenuX/Y, so they inherit the same spot.
     * Falls back to the switcher's own anchor if the popup is somehow not in
     * the DOM; ngAfterViewChecked's clamp pulls it back on-screen when the
     * right edge has no room.
     */
    private switcherPopupAnchor (): { x: number, y: number } {
        const popup = document.querySelector<HTMLElement>('.workspace-switcher-menu')
        const rect = popup?.getBoundingClientRect()
        return rect
            ? { x: Math.round(rect.right + 4), y: Math.round(rect.top) }
            : { x: this.workspaceSwitcherX, y: this.workspaceSwitcherY }
    }

    /** The switcher-side twin of onWorkspaceTabContextMenu(): same menu, fixed anchor beside the list, list kept open underneath. */
    openWorkspaceMenuFromSwitcher (event: MouseEvent, workspace: SidebarWorkspace): void {
        event.preventDefault()
        event.stopPropagation()
        this.contextMenuGroup = null
        this.contextMenuProfile = null
        this.contextMenuRoot = false
        this.contextMenuWorkspace = workspace
        this.contextMenuMode = 'workspaceMenu'
        const anchor = this.switcherPopupAnchor()
        this.contextMenuX = anchor.x
        this.contextMenuY = anchor.y
        this.menuPositionDirty = true
    }

    /** The switcher-side twin of openCreateWorkspacePrompt(), same fixed anchor as the manage menu. */
    openCreateWorkspaceFromSwitcher (event: MouseEvent): void {
        event.preventDefault()
        event.stopPropagation()
        this.contextMenuWorkspace = null
        this.contextMenuMode = 'createWorkspace'
        this.newWorkspaceName = ''
        const anchor = this.switcherPopupAnchor()
        this.contextMenuX = anchor.x
        this.contextMenuY = anchor.y
        this.menuPositionDirty = true
    }

    async createWorkspace (): Promise<void> {
        const name = this.newWorkspaceName.trim()
        if (!name) {
            return
        }
        const workspace = await this.workspaceStore.create(name)
        this.closeContextMenu()
        this.selectWorkspace(workspace.id)
    }

    /**
     * "Importer du presse-papiers", from the workspace creation popup.
     *
     * Nothing here trusts the payload — same discipline as `pasteGroup()`:
     * the JSON is clipboard text, hand-editable, and only checked on the way
     * in (`parseWorkspacePayload()`). The id is always minted fresh
     * (`generateWorkspaceId()`), never the one the payload carries, even when
     * it looks clean — reusing an id copied from another machine risks
     * colliding with one already in use locally.
     *
     * A name collision is silently suffixed rather than asked about, unlike a
     * folder paste: a workspace has no contents for "merge" to mean anything
     * against, it is a name plus a handful of exclusion/order lists, so there
     * is nothing to choose between beyond the name itself.
     *
     * Deliberately does not select the imported workspace — it lands in the
     * tab bar (via `refreshTree()`, which re-reads `this.workspaces` from
     * config without touching `activeWorkspaceId`) and waits to be clicked,
     * same as any workspace created by hand.
     */
    async importWorkspaceFromClipboard (): Promise<void> {
        const { payload, error } = parseWorkspacePayload(this.platform.readClipboard())
        if (!payload) {
            this.notices.error(error ? this.tMsg(error) : this.i18n.t('The clipboard does not hold an exported workspace.'))
            return
        }
        this.config.store.sidebarPlus ??= {}
        const workspaces: SidebarWorkspace[] = this.config.store.sidebarPlus.workspaces ?? []
        const name = uniqueWorkspaceName(payload.workspace.name?.trim() || this.i18n.t('Imported workspace'), workspaces.map(w => w.name))
        const created: SidebarWorkspace = {
            id: generateWorkspaceId(),
            name,
            hiddenProfileIds: payload.workspace.hiddenProfileIds,
            hiddenGroupIds: payload.workspace.hiddenGroupIds,
            favorites: payload.workspace.favorites,
            favoriteGroups: payload.workspace.favoriteGroups,
            groupOrder: payload.workspace.groupOrder,
            profileOrder: payload.workspace.profileOrder,
        }
        if (payload.workspace.icon !== undefined) {
            created.icon = payload.workspace.icon
        }
        if (payload.workspace.color !== undefined) {
            created.color = payload.workspace.color
        }
        await this.workspaceStore.add(created)
        this.closeContextMenu()
        await this.refreshTree()
        this.notices.notice(this.i18n.t('Workspace "{name}" imported.', { name }))
    }

    openRenameWorkspacePrompt (): void {
        this.renameWorkspaceValue = this.contextMenuWorkspace?.name ?? ''
        this.contextMenuMode = 'renameWorkspace'
        this.menuPositionDirty = true
    }

    async confirmRenameWorkspace (): Promise<void> {
        const name = this.renameWorkspaceValue.trim()
        if (!name || !this.contextMenuWorkspace) {
            return
        }
        await this.workspaceStore.rename(this.contextMenuWorkspace.id, name)
        this.closeContextMenu()
    }

    confirmDeleteWorkspacePrompt (): void {
        this.contextMenuMode = 'confirmDeleteWorkspace'
        this.menuPositionDirty = true
    }

    async deleteWorkspace (): Promise<void> {
        if (!this.contextMenuWorkspace) {
            return
        }
        const id = this.contextMenuWorkspace.id
        await this.workspaceStore.delete(id)
        this.closeContextMenu()
        if (this.activeWorkspaceId === id) {
            this.selectWorkspace('all')
        }
    }

    /**
     * "Copier (JSON)", from a workspace tab's context menu.
     *
     * Exports everything the workspace carries except its id — an id is
     * always minted fresh on import (`generateWorkspaceId()`), exactly like a
     * pasted folder's own id. No purge level to choose between, unlike
     * `copyGroupStructure()`: a workspace holds only ids (an exclusion list
     * and a couple of order maps), never a profile's `options`, so there is
     * nothing secret in it to begin with.
     */
    async copyWorkspace (): Promise<void> {
        const workspace = this.contextMenuWorkspace
        this.closeContextMenu()
        if (!workspace) {
            return
        }
        const payload = buildWorkspacePayload(workspace)
        this.platform.setClipboard({ text: JSON.stringify(payload, null, 2) })
        this.notices.notice(this.i18n.t('Workspace "{name}" copied.', { name: workspace.name }))
    }

    ////// WORKSPACE VISIBILITY (hide from the profile/group context menu, restore from the hidden-items panel) //////
    /** Single-click hide, no picker — always targets the active workspace. Meaningless (and hidden in the template) on "Tous", which never hides anything. */
    async hideInActiveWorkspace (): Promise<void> {
        const workspace = this.activeWorkspace
        if (!workspace) {
            return
        }
        if (this.contextMenuProfile?.id) {
            await this.workspaceStore.hideProfile(this.contextMenuProfile.id)
        } else if (this.contextMenuGroup) {
            await this.workspaceStore.hideGroup(this.contextMenuGroup.id)
        } else {
            return
        }
        this.closeContextMenu()
    }

    /**
     * Groups/profiles *directly* hidden in the active workspace (not
     * cascade-hidden descendants of a hidden parent) — backs the "show
     * hidden" panel next to the filter bar. Reads rawGroupsSnapshot (not
     * profileGroups) since these items are, by definition, excluded from
     * the normal filtered tree.
     */
    get hiddenGroupsInWorkspace (): PartialProfileGroup<ProfileGroup>[] {
        const workspace = this.activeWorkspace
        if (!workspace?.hiddenGroupIds.length) {
            return []
        }
        return this.rawGroupsSnapshot.filter(g => workspace.hiddenGroupIds.includes(g.id))
    }

    get hiddenProfilesInWorkspace (): PartialProfile<Profile>[] {
        const workspace = this.activeWorkspace
        if (!workspace?.hiddenProfileIds.length) {
            return []
        }
        const allProfiles = this.rawGroupsSnapshot.flatMap(g => g.profiles ?? [])
        return allProfiles.filter(p => p.id && workspace.hiddenProfileIds.includes(p.id))
    }

    async restoreGroupInWorkspace (group: PartialProfileGroup<ProfileGroup>): Promise<void> {
        await this.workspaceStore.restoreGroup(group.id)
    }

    async restoreProfileInWorkspace (profile: PartialProfile<Profile>): Promise<void> {
        if (!profile.id) {
            return
        }
        await this.workspaceStore.restoreProfile(profile.id)
    }

    ////// PER-BLOCK SWITCHES //////
    /**
     * Whether each block of the sidebar is on.
     *
     * Two independent reasons a block can be off, deliberately combined here
     * rather than at each call site: the user unticked it, or the host no
     * longer carries it (`hostSupports`, see hostCompat.ts). Callers only ever
     * want the conjunction, and splitting it would guarantee that one of the
     * twenty-odd usages eventually forgets the second half.
     *
     * These are getters, not fields: `config.store` is the single source of
     * truth and `config.changed$` already rebuilds the view, so caching them
     * would only add a way for the two to disagree. They are read from the
     * template on every change detection pass, which is fine — each is a
     * property lookup, not the method call of piège #54.
     */
    /**
     * No `hostSupports(...)` gate, unlike the blocks tied to the SSH tab: a
     * relaunch is a generic profile action (SSH, local, whatever a provider
     * offers).
     */
    get showRecentProfiles (): boolean {
        return this.config.store.sidebarPlus?.showRecentProfiles ?? true
    }

    get showSftp (): boolean {
        return (this.config.store.sidebarPlus?.showSftp ?? true) && hostSupports('sftp-panel')
    }

    /**
     * The transfers panel, which belongs to the SFTP view and is switched off
     * with it.
     *
     * Subordinate rather than independent because that is where transfers come
     * from in practice, and because the settings page groups an option with the
     * feature it belongs to. The nuance to keep in mind: the registry also
     * mirrors transfers *this plugin did not start* — the native SFTP panel's,
     * another plugin's — and those become invisible here when the SFTP view is
     * off. That is why switching it off also stops hiding Tabby's own transfers
     * menu (see SidebarPlusMountService): the plugin must not hide the host's
     * only remaining readout of something it no longer shows itself.
     */
    get showTransfers (): boolean {
        return this.showSftp && (this.config.store.sidebarPlus?.showTransfers ?? true)
    }

    get showWorkspaces (): boolean {
        return this.config.store.sidebarPlus?.showWorkspaces ?? true
    }

    get showFilter (): boolean {
        return this.config.store.sidebarPlus?.showFilter ?? true
    }

    get showSnippets (): boolean {
        return this.config.store.sidebarPlus?.showSnippets ?? true
    }

    get showNotes (): boolean {
        return this.config.store.sidebarPlus?.showNotes ?? true
    }

    /**
     * Puts the sidebar back into a coherent state after a block is switched
     * off, so that nothing keeps acting through a control that is gone.
     *
     * Called from the `config.changed$` path. Each case is a state that would
     * otherwise be unreachable *and* unexplainable: a workspace still filtering
     * the tree with no tab bar to switch away from it, a filter still hiding
     * rows with no field showing why, an SFTP view with no way back to the
     * profiles.
     */
    private reconcileHiddenBlocks (): void {
        if (!this.showSftp && this.sftpMode) {
            this.sftpMode = false
        }
        if (this.showWorkspaces) {
            // Coming back on: restore the selection the user last made, which
            // the branch below deliberately left in localStorage.
            const remembered = window.localStorage.sidebarPlusActiveWorkspace ?? 'all'
            if (this.activeWorkspaceId !== remembered) {
                this.activeWorkspaceId = remembered
            }
        } else {
            // Falling back to "Tous" — the zero-exclusion case, so this reveals
            // everything rather than hiding more.
            //
            // Assigned directly and *not* through selectWorkspace(), which
            // would write 'all' to localStorage: switching a block off must
            // never overwrite a choice the user made. The stored workspaces are
            // untouched either way, but their selection is a choice too, and
            // losing it on a round trip through the switch would be exactly the
            // silent overwrite this must not do.
            if (this.activeWorkspaceId !== 'all') {
                this.activeWorkspaceId = 'all'
            }
            if (this.showHiddenPanel) {
                this.showHiddenPanel = false
            }
        }
        if (!this.showFilter && this.filter) {
            this.filter = ''
            void this.onFilterChange()
        }
    }

    ////// SFTP VIEW //////
    setSftpMode (on: boolean): void {
        if (on && !this.showSftp) {
            return
        }
        this.sftpMode = on
        if (on) {
            // Leaving this on would put the sidebar back into the hidden-items
            // panel — not the tree — the next time SFTP is switched off.
            this.showHiddenPanel = false
        }
    }

    ////// RESIZING //////
    startResize (event: MouseEvent): void {
        this.resize.start(event.clientX)
        event.preventDefault()
    }

    /**
     * Single dispatcher for document mousemoves. Angular's JIT host-listener
     * metadata is keyed by event name (`bindings.listeners[eventName]` in the
     * compiler facade), so a second @HostListener('document:mousemove') on
     * another method would overwrite this one and silently drop the resize
     * preview. One listener, two handlers, no collision.
     */
    @HostListener('document:mousemove', ['$event'])
    onDocumentMouseMove (event: MouseEvent): void {
        this.onDragMouseMove(event)
        this.resize.move(event.clientX)
    }

    @HostListener('document:mouseup')
    stopResize (): void {
        this.resize.commit()
    }

    /**
     * Ends a resize that never got its `mouseup`: the pointer left the window
     * (mouseleave) or the window lost focus (blur) while the button was held.
     * Committing here rather than discarding matches what the user last saw —
     * the grabber's position — and is what keeps the handle from staying
     * offset and highlighted forever.
     */
    @HostListener('document:mouseleave')
    onResizeMouseLeave (): void {
        this.resize.commit()
    }

    @HostListener('window:blur')
    onResizeWindowBlur (): void {
        this.resize.commit()
    }

    get panelIsResizing (): boolean {
        return this.resize.isResizing
    }

    /** Translation applied to the grabber during a drag, or null at rest (see sidebarResize.ts). */
    get grabberTransform (): string|null {
        return this.resize.grabberTransform
    }

    /**
     * Mirrors the drag state onto the host element so the SCSS can disable the
     * width transition while dragging (and re-enable it for the single
     * animated commit on release). Separate from `.grabber`'s own
     * [class.resizing] binding, which styles the handle itself.
     */
    @HostBinding('class.resizing')
    get hostResizing (): boolean {
        return this.panelIsResizing
    }

    // Called from onDocumentMouseMove() — see the note there for why this is
    // not itself a @HostListener. The tracking state lives in the drag
    // controller.
    private onDragMouseMove (event: MouseEvent): void {
        this.drag.onDragMouseMove(event)
    }

    ////// GROUP COLLAPSING //////
    toggleGroupCollapse (group: PartialProfileGroup<CollapsableProfileGroup>): void {
        group.collapsed = !group.collapsed
        const profileGroupCollapsed = JSON.parse(window.localStorage.sidebarPlusGroupCollapsed ?? '{}')
        profileGroupCollapsed[group.id] = group.collapsed
        window.localStorage.sidebarPlusGroupCollapsed = JSON.stringify(profileGroupCollapsed)
    }

    ////// FAVORITES //////
    isFavorite (profile: PartialProfile<Profile>): boolean {
        return !!profile.id && this.favoriteIds.includes(profile.id)
    }

    toggleFavorite (profile: PartialProfile<Profile>, event: Event): void {
        event.preventDefault()
        event.stopPropagation()
        if (!profile.id) {
            return
        }
        this.config.store.sidebarPlus ??= {}
        // "Tous" reuses the pre-existing top-level favorites/favoriteGroups
        // keys (already live in every user's config.yaml, zero migration);
        // every other workspace gets its own list on the workspace object.
        const favorites: string[] = this.activeWorkspace
            ? (this.activeWorkspace.favorites ??= [])
            : (this.config.store.sidebarPlus.favorites ??= [])
        const index = favorites.indexOf(profile.id)
        if (index === -1) {
            favorites.push(profile.id)
        } else {
            favorites.splice(index, 1)
        }
        if (this.activeWorkspace) {
            this.config.store.sidebarPlus.workspaces = this.workspaces
        } else {
            this.config.store.sidebarPlus.favorites = favorites
        }
        this.config.save()
        this.rootGroups = this.applyFavorites(this.rootGroups.filter(g => g.id !== 'favorites'))
    }

    toggleFavoriteFromMenu (profile: PartialProfile<Profile>, event: Event): void {
        this.toggleFavorite(profile, event)
        this.closeContextMenu()
    }

    private get favoriteIds (): string[] {
        return this.activeWorkspace ? (this.activeWorkspace.favorites ?? []) : (this.config.store.sidebarPlus?.favorites ?? [])
    }

    ////// GROUP FAVORITES //////
    // Separate config key from profile favorites: profile IDs and group IDs
    // don't share a documented namespace guarantee, so a combined list would
    // risk a collision that's unlikely but avoidable at zero cost.
    isFavoriteGroup (group: PartialProfileGroup<ProfileGroup>): boolean {
        return this.favoriteGroupIds.includes(group.id)
    }

    toggleFavoriteGroupFromMenu (group: PartialProfileGroup<CollapsableProfileGroup>, event: Event): void {
        event.preventDefault()
        event.stopPropagation()
        this.config.store.sidebarPlus ??= {}
        const favoriteGroups: string[] = this.activeWorkspace
            ? (this.activeWorkspace.favoriteGroups ??= [])
            : (this.config.store.sidebarPlus.favoriteGroups ??= [])
        const index = favoriteGroups.indexOf(group.id)
        if (index === -1) {
            favoriteGroups.push(group.id)
        } else {
            favoriteGroups.splice(index, 1)
        }
        if (this.activeWorkspace) {
            this.config.store.sidebarPlus.workspaces = this.workspaces
        } else {
            this.config.store.sidebarPlus.favoriteGroups = favoriteGroups
        }
        this.config.save()
        this.closeContextMenu()
    }

    private get favoriteGroupIds (): string[] {
        return this.activeWorkspace ? (this.activeWorkspace.favoriteGroups ?? []) : (this.config.store.sidebarPlus?.favoriteGroups ?? [])
    }

    /**
     * `workspace`/`sourceProfileGroups` default to live instance state for
     * the synchronous, non-racy call sites (toggleFavorite*, onFilterChange).
     * loadTreeItems() passes them explicitly instead — it computes against a
     * local snapshot taken before its own await, per the requestId-guard
     * discipline described there, and must not fall back to `this.*` here.
     */
    private applyFavorites (
        groups: PartialProfileGroup<CollapsableProfileGroup>[],
        workspace: SidebarWorkspace|null = this.activeWorkspace,
        sourceProfileGroups: PartialProfileGroup<ProfileGroup>[] = this.profileGroups,
    ): PartialProfileGroup<CollapsableProfileGroup>[] {
        const favoriteIds = workspace ? (workspace.favorites ?? []) : (this.config.store.sidebarPlus?.favorites ?? [])
        if (!favoriteIds.length) {
            return groups
        }

        const allProfiles = sourceProfileGroups.flatMap(g => g.profiles ?? [])
        const favoriteProfiles = favoriteIds
            .map(id => allProfiles.find(p => p.id === id))
            .filter((p): p is PartialProfile<Profile> => !!p)

        if (!favoriteProfiles.length) {
            return groups
        }

        const favoritesGroup = intoCollapsable(
            {
                id: 'favorites',
                name: this.i18n.t('Pinned'),
                icon: 'fas fa-star',
                editable: false,
                profiles: favoriteProfiles,
            } as PartialProfileGroup<ProfileGroup>,
            false,
        )

        return [favoritesGroup, ...groups]
    }

    /**
     * Connection details of the focused SSH session, for the bottom panel:
     * profile name plus user@host:port and a live/disconnected state. Null when
     * the focused tab is not an SSH session.
     */
    get connectionInfo (): { name: string, host: string, user: string, port: string, protocol: string, connected: boolean }|null {
        const tab = this.live.focusedTab()
        if (!tab || !isSSHTab(tab)) {
            return null
        }
        const ssh = tab as unknown as SSHTabComponent
        const profile = (ssh as unknown as {
            profile?: { name?: string, type?: string, options?: { host?: string, user?: string, port?: number } }
        }).profile
        const options = profile?.options ?? {}
        return {
            name: profile?.name || ssh.title || '',
            host: options.host ?? '',
            user: options.user ?? '',
            port: options.port != null ? String(options.port) : '22',
            protocol: profile?.type ?? '',
            // Same signal Tabby's own sidebar uses: Tabby nulls `session` when
            // the session ends, so a non-null session is "connected" and null
            // is the dot going grey. No second state: a session either exists
            // on this tab or it does not.
            connected: !!(ssh as unknown as { session?: unknown }).session,
        }
    }

    /** Details of the profile clicked in the tree, for the bottom panel. */
    get previewInfo (): { name: string, host: string, user: string, port: string, protocol: string }|null {
        const profile = this.previewProfile
        if (!profile) {
            return null
        }
        const options = (profile as unknown as { options?: { host?: string, user?: string, port?: number } }).options ?? {}
        // Show the provider's translated name ("本地终端", "SSH"…) rather than
        // the raw type id.
        const provider = this.profileProviders.find(p => p.id === profile.type)
        return {
            name: profile.name ?? '',
            host: options.host ?? '',
            user: options.user ?? '',
            // No SSH-style default: a profile without a port has no port row.
            port: options.port != null ? String(options.port) : '',
            protocol: provider ? this.i18n.t(provider.name) : (profile.type ?? ''),
        }
    }

    ////// LIVE STATE DELEGATES //////
    /** Whether this configured tunnel is one Tabby currently has mounted — the only kind whose deletion is withheld. */
    isTunnelLive (forward: ForwardedPortConfig, profileId: string|undefined): boolean {
        return this.live.isTunnelLive(forward, profileId)
    }

    /** Backs the chain badge in the tree — number of live forwards across every open session of this profile. */
    tunnelCount (profile: PartialProfile<Profile>): number {
        return this.live.tunnelCount(profile)
    }

    /** Tunnels written on the profile, mounted or not. Drives a dimmed badge so a profile carrying forwards is recognisable before it is launched. */
    configuredTunnelCount (profile: PartialProfile<Profile>): number {
        return this.live.configuredTunnelCount(profile)
    }

    /** Backs the ↑/↓ badge in the tree — read from the precomputed map, never scanning the registry here. */
    transferActivity (profile: PartialProfile<Profile>): { up: boolean, down: boolean }|null {
        return this.live.transferActivity(profile)
    }

    /**
     * A session gaining focus takes the bottom panel back from a profile
     * preview: the two never show at the same time. The getters `previewInfo` /
     * `connectionInfo` are re-evaluated on the next CD pass; without an
     * explicit mark the panel swap can lag behind the focus event (observable
     * callbacks run outside Angular's zone in some Electron input paths).
     */
    private tabStateChanged (): void {
        this.previewProfile = null
        this.cdr.markForCheck()
    }

    /**
     * The live SSH tab of a profile, if one is connected — decides which of the
     * two tunnel entries the profile menu offers.
     */
    private connectedTabForProfile (profile: PartialProfile<Profile>): SSHTabComponent|null {
        if (!profile.id) {
            return null
        }
        for (const tab of getAllOpenTabs(this.app)) {
            if (!isSSHTab(tab)) {
                continue
            }
            const backing = tab as unknown as ProfileBackedTab
            if (backing.profile?.id === profile.id && tab.sshSession?.open && backing.session) {
                return tab
            }
        }
        return null
    }

    ////// PROFILE TUNNEL CONFIGURATION (modal) //////
    /**
     * The plugin's own tunnel editor, and — by the user's explicit choice —
     * the only one. An entry handing over to Tabby's native
     * `showPortForwarding()` modal was built and validated alongside it, then
     * dropped: "je veux uniquement ma solution maison".
     *
     * What that settles, so it is not rediscovered as a bug: nothing here can
     * touch a session that is already running. Everything written goes to the
     * profile's configuration, which Tabby reads only when a session starts.
     * Acting on a live session would mean calling
     * `SSHSession.addPortForward()`, which calls `fw.startLocalListener()` and
     * therefore needs a genuine `ForwardedPort` — a class tabby-ssh does not
     * export at runtime (checked against the installed bundle, piège #13).
     * Rebuilding one from an existing forward's prototype would only work once
     * the user already had a tunnel, which is circular.
     *
     * The form itself — draft, validation, add/edit/remove — lives in
     * `TunnelsModalComponent` (a centred modal, like the snippets and note
     * editors) rather than in the anchored popup it used to be. What stays
     * here is what the modal cannot know on its own: whether a given forward
     * is one Tabby currently has mounted (`isTunnelLive`, fed by the same
     * poll that drives the tree's own "Tunnels actifs" section) and whether
     * the profile has a live session at all — both handed to the modal as
     * callbacks bound to `profile` below, rather than as a one-time snapshot,
     * so they stay accurate even if a session opens or closes while the modal
     * is open.
     */
    /** Port forwarding is an SSH-profile notion — the menu entries stay hidden on local/serial/telnet profiles rather than offering a setting Tabby would ignore. */
    get isSshProfileMenu (): boolean {
        return this.contextMenuProfile?.type === 'ssh'
    }

    async openProfileTunnels (): Promise<void> {
        const profile = this.contextMenuProfile
        this.closeContextMenu()
        if (!profile) {
            return
        }
        const modal = this.ngbModal.open(TunnelsModalComponent, { size: 'lg' })
        modal.componentInstance.profile = profile
        modal.componentInstance.isLive = (forward: ForwardedPortConfig) => this.isTunnelLive(forward, profile.id)
        modal.componentInstance.hasLiveSession = () => !!this.connectedTabForProfile(profile)
        await modal.result.catch(() => null)
    }

    /**
     * Jumps to the session *and* swaps the sidebar to its SFTP view — the panel follows the focused tab, so the order matters.
     */
    openSessionSftp (session: ActiveSession, event: MouseEvent): void {
        event.preventDefault()
        event.stopPropagation()
        // A freeze left over from an earlier navigation must not swallow
        // this click: naming one particular session here is a more explicit
        // gesture than the pin it might be overriding, and letting the pin
        // win would make the shortcut silently do nothing. Unfreeze before
        // focusTab() — sync() runs off the resulting focus change, so the
        // panel is free to follow by the time it fires.
        this.sftpPanel?.unfreeze()
        focusTab(this.app, session.tab)
        this.setSftpMode(true)
    }

    ////// MULTI-SELECTION / DRAG & DROP //////
    // The selection, the live drag tracking and every order/reparent write
    // live in SidebarPlusTreeDragController; these are the template-facing
    // delegates only.
    get selectedProfileIds (): Set<string> {
        return this.drag.selectedProfileIds
    }

    get selectionActive (): boolean {
        return this.drag.selectionActive
    }

    get selectionNotice (): string|null {
        return this.drag.selectionNotice
    }

    get profileListIds (): string[] {
        return this.drag.profileListIds
    }

    get groupListIds (): string[] {
        return this.drag.groupListIds
    }

    isProfileSelected (profile: PartialProfile<Profile>): boolean {
        return this.drag.isProfileSelected(profile)
    }

    clearSelection (): void {
        this.drag.clearSelection()
    }

    onProfileClick (profile: PartialProfile<Profile>, group: PartialProfileGroup<ProfileGroup>, event: MouseEvent): void {
        this.drag.onProfileClick(profile, group, event)
    }

    canMoveSelectionTo (group: PartialProfileGroup<ProfileGroup>): boolean {
        return this.drag.canMoveSelectionTo(group)
    }

    moveSelectionToGroup (targetGroup: PartialProfileGroup<ProfileGroup>, insertAfterProfileId: string|null = null): Promise<void> {
        return this.drag.moveSelectionToGroup(targetGroup, insertAfterProfileId)
    }

    onProfileDragStarted (profile: PartialProfile<Profile>): void {
        this.drag.onProfileDragStarted(profile)
    }

    onProfileDragEnded (): void {
        this.drag.onProfileDragEnded()
    }

    onProfileListEntered (group: PartialProfileGroup<CollapsableProfileGroup>): void {
        this.drag.onProfileListEntered(group)
    }

    onProfileListExited (group: PartialProfileGroup<CollapsableProfileGroup>): void {
        this.drag.onProfileListExited(group)
    }

    isHiddenWhileDragging (profile: PartialProfile<Profile>): boolean {
        return this.drag.isHiddenWhileDragging(profile)
    }

    isNestTarget (group: PartialProfileGroup<CollapsableProfileGroup>): boolean {
        return this.drag.isNestTarget(group)
    }

    onGroupDragStarted (group: PartialProfileGroup<CollapsableProfileGroup>): void {
        this.drag.onGroupDragStarted(group)
    }

    onGroupDragEnded (): void {
        this.drag.onGroupDragEnded()
    }

    onProfileDrop (event: CdkDragDrop<PartialProfile<Profile>[]>, targetGroup: PartialProfileGroup<ProfileGroup>): Promise<void> {
        return this.drag.onProfileDrop(event, targetGroup)
    }

    onGroupDrop (event: CdkDragDrop<PartialProfileGroup<CollapsableProfileGroup>[]>, targetParentGroupId: string|null): Promise<void> {
        return this.drag.onGroupDrop(event, targetParentGroupId)
    }

    ////// GROUP DELETION (context menu) //////
    onGroupContextMenu (event: MouseEvent, group: PartialProfileGroup<CollapsableProfileGroup>): void {
        event.preventDefault()
        event.stopPropagation()
        // 'ungrouped' is not editable (it is Tabby's synthetic bucket, it has
        // no name/icon/children to act on) but it *is* a legal move target —
        // onProfileDrop() accepts it, so a drag can put profiles there while
        // the menu could not. Opened for that one purpose when a selection is
        // waiting, with a reduced menu offering only the move.
        if (!group.editable && !this.canMoveSelectionTo(group)) {
            return
        }
        this.resetSubmenu()
        this.contextMenuProfile = null
        this.contextMenuGroup = group
        this.contextMenuRoot = false
        this.contextMenuMode = 'menu'
        this.contextMenuX = event.clientX
        this.contextMenuY = event.clientY
        this.menuPositionDirty = true
    }

    /** Right-click on empty sidebar space (not on any group/profile row) — offers root-level creation. */
    onSidebarContextMenu (event: MouseEvent): void {
        event.preventDefault()
        event.stopPropagation()
        this.resetSubmenu()
        this.contextMenuGroup = null
        this.contextMenuProfile = null
        this.contextMenuRoot = true
        this.contextMenuMode = 'menu'
        this.contextMenuX = event.clientX
        this.contextMenuY = event.clientY
        this.menuPositionDirty = true
    }

    closeContextMenu (): void {
        this.contextMenuGroup = null
        this.contextMenuProfile = null
        this.contextMenuRoot = false
        this.contextMenuWorkspace = null
        this.contextMenuMode = 'menu'
        this.resetSubmenu()
    }

    /**
     * Opens the given lateral submenu beside the entry that carries it — both
     * hover and click call this. Anchored on the CARRYING ENTRY's own rect
     * (not a fixed point), so clampSubmenuPosition() can later flip the panel
     * to the entry's left once the panel's real width is known.
     */
    openSubmenuPanel (name: 'manage'|'more', event: MouseEvent): void {
        this.cancelSubmenuClose()
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
        this.submenuAnchorLeft = rect.left
        this.submenuAnchorRight = rect.right
        this.submenuAnchorTop = rect.top
        this.activeSubmenu = name
        this.submenuX = rect.right
        this.submenuY = rect.top
        this.submenuPositionDirty = true
    }

    /** Cancels a pending submenu close — the pointer made it from the carrying entry onto the panel (or onto another submenu-carrying entry) before scheduleSubmenuClose()'s delay ran out. */
    cancelSubmenuClose (): void {
        if (this.submenuCloseTimer) {
            clearTimeout(this.submenuCloseTimer)
            this.submenuCloseTimer = null
        }
    }

    /** Closes the open submenu after a short delay instead of immediately, so the pointer's path from the carrying entry to the panel beside it (which briefly leaves both) doesn't make it vanish underfoot. */
    scheduleSubmenuClose (): void {
        this.cancelSubmenuClose()
        this.submenuCloseTimer = setTimeout(() => {
            this.submenuCloseTimer = null
            this.activeSubmenu = null
        }, 180)
    }

    /** The submenu dies with whatever menu carries it — called from closeContextMenu() and from every place that opens a fresh menu directly (a right-click elsewhere never goes through closeContextMenu() first). */
    private resetSubmenu (): void {
        this.cancelSubmenuClose()
        this.activeSubmenu = null
    }

    // Checks the click's target rather than relying on descendant
    // (click)='$event.stopPropagation()' bindings to suppress this — those
    // bindings don't reliably stop this HostListener('document:click') from
    // firing regardless (observed via console.trace: it runs synchronously
    // right after a menu item's own click handler, even for items whose
    // ancestor .group-context-menu has a stopPropagation click binding).
    @HostListener('document:click', ['$event'])
    onDocumentClick (event: MouseEvent): void {
        const target = event.target as HTMLElement
        // The switcher survives clicks inside ANY popup — the "⋯" menu and
        // its sub-popups all render beside it and act on it, so a click in
        // them is part of the same interaction. It dies only on a truly
        // outside click, checked here BEFORE the popup guard below returns
        // early. The compact bar is excluded so its own toggle stays the one
        // in charge of open/close (piège #15: its stopPropagation() cannot be
        // trusted to keep this HostListener from firing).
        if (!target.closest('.workspace-switcher-menu, .workspace-bar-compact, .group-context-menu, .group-context-submenu, .create-popup')) {
            this.workspaceSwitcherOpen = false
        }
        // .group-context-submenu (the Manage/More lateral panels) is a
        // sibling of .group-context-menu in the DOM, never a descendant of it
        // (piège #38: its entries are <a>, so the panel can't nest inside the
        // carrying entry's own <a> without the parser silently un-nesting
        // it) — so it needs its own entry here, not just an implicit catch
        // via the menu's. Left out, opening a submenu closes the whole menu
        // from under it (piège #15: stopPropagation() on its own click
        // binding does not stop this HostListener).
        if (target.closest('.group-context-menu, .group-context-submenu, .create-popup')) {
            return
        }
        this.closeContextMenu()
        // Clicking anywhere that is not a profile row drops the selection
        // (empty space, a folder row, the workspace bar) — the OS-standard
        // "click away to deselect". Profile rows are excluded because
        // onProfileClick() owns that case and needs to read the modifier keys;
        // letting this run there would clear the selection on the very click
        // meant to extend it. Tested by attribute rather than by trusting a
        // descendant's stopPropagation(), which does not suppress this
        // HostListener at all (piège #15).
        // .selection-bar is excluded too: it is the readout of the selection,
        // so clicking it must not be what destroys it. Its own ✕ clears
        // explicitly.
        if (!target.closest('[data-profile-row], .selection-bar')) {
            this.clearSelection()
        }
    }

    ////// RENAME (context menu, inline — no modal) //////
    openRenamePrompt (): void {
        this.renameValue = this.contextMenuProfile?.name ?? this.contextMenuGroup?.name ?? ''
        this.contextMenuMode = 'rename'
        this.menuPositionDirty = true
    }

    async confirmRename (): Promise<void> {
        const name = this.renameValue.trim()
        if (!name) {
            return
        }
        if (this.contextMenuProfile) {
            this.contextMenuProfile.name = name
            await this.profilesService.writeProfile(this.contextMenuProfile)
        } else if (this.contextMenuGroup) {
            // Minimal {id, name} object only — see IconPickerModalComponent's
            // applyIcon() for why (never pass contextMenuGroup itself, it
            // carries plugin-computed fields that writeProfileGroup() would
            // Object.assign() straight into config.yaml, roadmap piège #12).
            await this.profilesService.writeProfileGroup({ id: this.contextMenuGroup.id, name } as PartialProfileGroup<ProfileGroup>)
        } else {
            return
        }
        await this.config.save()
        this.closeContextMenu()
    }

    ////// GROUP / PROFILE CREATION (context menu) //////
    openCreateGroupPrompt (): void {
        this.contextMenuMode = 'createGroup'
        this.newGroupName = ''
        this.menuPositionDirty = true
    }

    async createGroup (): Promise<void> {
        const name = this.newGroupName.trim()
        if (!name) {
            return
        }
        const parentGroupId = this.contextMenuGroup?.id
        await this.profilesService.newProfileGroup({ name, parentGroupId } as PartialProfileGroup<ProfileGroup>, { genId: true })
        await this.config.save()
        this.closeContextMenu()
    }

    async openCreateProfilePicker (): Promise<void> {
        this.contextMenuMode = 'createProfile'
        this.menuPositionDirty = true
        const perProvider = await Promise.all(this.profileProviders.map(async provider => ({
            provider,
            templates: (await provider.getBuiltinProfiles()).filter(p => p.isTemplate),
        })))
        this.profileTemplates = perProvider.flatMap(({ provider, templates }) => templates.map(template => ({ provider, template })))
        // The list grew after the await above — re-clamp now that the popup has its real, final size.
        this.menuPositionDirty = true
    }

    async pickProfileTemplate (entry: { provider: ProfileProvider<Profile>, template: PartialProfile<Profile> }): Promise<void> {
        const groupId = this.contextMenuGroup?.id
        const base = structuredClone(entry.template) as PartialProfile<Profile> & { isTemplate?: boolean, isBuiltin?: boolean, weight?: number }
        delete base.isTemplate
        delete base.isBuiltin
        delete base.weight
        base.group = groupId
        // A fresh id has to exist before the modal opens, not once its result
        // comes back: the SSH settings panel keys saved passwords off
        // profile.id, so a template id would make every new profile share one
        // key — and profilesService.newProfile() only generates an id when
        // there is none, otherwise it rejects the insert as a duplicate. The
        // template carries `ssh:template`, hence the overwrite. Same shape
        // Tabby uses in its own newProfileFromBlank()/newProfile().
        base.id = `${base.type}:custom::${crypto.randomUUID()}`
        // Left empty so getSuggestedName() below names the profile
        // user@host:port instead of inheriting the template's own label.
        base.name = ''
        this.closeContextMenu()

        const modal = openProfileModal(this.ngbModal, base, entry.provider)
        if (!modal) {
            this.notifications.error(this.i18n.t(PROFILE_MODAL_UNAVAILABLE))
            return
        }

        const result = await modal.result.catch(() => null) as PartialProfile<Profile>|null
        if (!result) {
            return
        }
        result.type = entry.provider.id
        if (!result.name) {
            const cfgProxy = this.profilesService.getConfigProxyForProfile(result)
            result.name = entry.provider.getSuggestedName(cfgProxy) ?? entry.provider.name
        }
        try {
            await this.profilesService.newProfile(result)
            await this.config.save()
        } catch (err) {
            // Deliberately not rethrown: this runs as an async Angular event
            // handler, so a rethrow becomes an unhandled promise rejection —
            // noise on top of the toast the user already gets, and the modal is
            // already closed by now, so silence would be the only other option.
            // console.error keeps it diagnosable.
            // eslint-disable-next-line no-console
            console.error('[sidebarPlus] creating the profile failed', err)
            this.notifications.error(this.i18n.t('Creating the profile failed'), String(err))
        }
    }

    ////// PROFILE EDITING (context menu) //////
    onProfileContextMenu (event: MouseEvent, profile: PartialProfile<Profile>): void {
        event.preventDefault()
        event.stopPropagation()
        // OS-standard, and spelled out in the roadmap: right-clicking *outside*
        // the current selection drops it and opens the plain single-profile
        // menu. Right-clicking inside it leaves the selection alone.
        if (!this.isProfileSelected(profile)) {
            this.clearSelection()
        }
        this.resetSubmenu()
        this.contextMenuGroup = null
        this.contextMenuProfile = profile
        this.contextMenuRoot = false
        this.contextMenuMode = 'menu'
        this.contextMenuX = event.clientX
        this.contextMenuY = event.clientY
        this.menuPositionDirty = true
    }

    ////// ICON PICKER (modal) //////
    /**
     * Opens the icon picker on whichever of the three targets the current
     * menu carries — a profile, a folder, or (from the workspace menu) a
     * workspace, always exactly one. Everything the picker shows and writes
     * — search, favorites, recents, the custom-SVG import, the per-tile
     * favorite toggle — now lives in `IconPickerModalComponent`, a centred
     * modal like the snippets and note editors, rather than in the anchored
     * popup it used to be.
     */
    async openIconPicker (): Promise<void> {
        const profile = this.contextMenuProfile
        const group = this.contextMenuGroup
        const workspace = this.contextMenuWorkspace
        this.closeContextMenu()
        if (!profile && !group && !workspace) {
            return
        }
        const modal = this.ngbModal.open(IconPickerModalComponent, { size: 'lg' })
        modal.componentInstance.profile = profile
        modal.componentInstance.group = group
        modal.componentInstance.workspace = workspace
        await modal.result.catch(() => null)
    }

    ////// WORKSPACE COLOR (context menu) //////
    /**
     * Standard Tabby palette (TAB_COLORS, tabby-core/utils.ts) minus its own
     * "No color" entry — that one is offered separately below, as the
     * "Retirer la couleur" link mirroring clearWorkspaceIcon(), not folded
     * into the swatch grid. Re-labelled in French: TAB_COLORS' own `name`
     * fields are wrapped in `_()` for Tabby's own translation extraction and
     * come through unresolved ("Blue", "Green"...) since this plugin never
     * calls into that pipeline.
     */
    private static readonly WORKSPACE_COLOR_NAMES: Record<string, string> = {
        '#0275d8': 'Bleu',
        '#5cb85c': 'Vert',
        '#f0ad4e': 'Orange',
        '#613d7c': 'Violet',
        '#d9534f': 'Rouge',
        '#ffd500': 'Jaune',
    }

    get workspaceColors (): { name: string, value: string }[] {
        return TAB_COLORS
            .filter(c => c.value !== null)
            .map(c => ({
                name: SidebarPlusTreeComponent.WORKSPACE_COLOR_NAMES[c.value as string] ?? c.name,
                value: c.value as string,
            }))
    }

    openWorkspaceColorPicker (): void {
        this.contextMenuMode = 'workspaceColor'
        this.menuPositionDirty = true
    }

    async applyWorkspaceColor (color: string): Promise<void> {
        if (!this.contextMenuWorkspace) {
            return
        }
        // Same shape as confirmRenameWorkspace()/applyIcon(): find the live
        // entry in the stored array, mutate in place, then reassign the array
        // itself (piège #23 — a nested in-place mutation alone never persists).
        this.config.store.sidebarPlus ??= {}
        const workspaces: SidebarWorkspace[] = this.config.store.sidebarPlus.workspaces ?? []
        const target = workspaces.find(w => w.id === this.contextMenuWorkspace!.id)
        if (target) {
            target.color = color
        }
        this.config.store.sidebarPlus.workspaces = workspaces
        await this.config.save()
        this.closeContextMenu()
    }

    /** Mirrors IconPickerModalComponent.clearWorkspaceIcon() — deletes the field rather than storing an empty string, so every truthiness check on it (withWorkspaceColor()'s injection guard, the tab's color dot) stays a single `if (workspace.color)`. */
    async clearWorkspaceColor (): Promise<void> {
        if (!this.contextMenuWorkspace) {
            return
        }
        this.config.store.sidebarPlus ??= {}
        const workspaces: SidebarWorkspace[] = this.config.store.sidebarPlus.workspaces ?? []
        const target = workspaces.find(w => w.id === this.contextMenuWorkspace!.id)
        if (target) {
            delete target.color
        }
        this.config.store.sidebarPlus.workspaces = workspaces
        await this.config.save()
        this.closeContextMenu()
    }

    /**
     * Opens Tabby's own profile edit modal, exactly the way `tabby-settings`
     * opens it for its own list and `tabby-core` for the native tree: hand it a
     * clone and the profile's provider, then `writeProfile()` the result.
     *
     * This used to drive tabby-settings' DOM instead — open Settings >
     * Profiles, click every collapsed group open, find the row whose `span`
     * carries the profile name, click it, then poll for `.modal-content` to
     * learn when to close the tab again. That was the single most fragile
     * point of the plugin, and it was never necessary: the comment justifying
     * it claimed no public API existed, while `pickProfileTemplate()` opened
     * the very same modal a few hundred lines above. `EditProfileModalComponent`
     * is `@hidden`, which proves nothing about what is exported at runtime
     * (piège #13), and `src/tabby-settings-augment.d.ts` already declared it.
     *
     * That left two callers naming the modal's inputs by hand, which is what
     * `openProfileModal()` (`src/profileModal.ts`) now holds — one place to
     * assign them, one place to check they still exist.
     *
     * Opening a Settings tab was the *vehicle*, never the intent. It survives
     * only as the fallback below, for a profile whose provider cannot be
     * resolved — where Tabby itself throws.
     */
    async editProfile (profile?: PartialProfile<Profile>): Promise<void> {
        this.closeContextMenu()
        if (!profile) {
            return
        }

        const provider = this.profilesService.providerForProfile(profile)
        if (!provider) {
            // tabby-settings throws here. Sending the user somewhere they can
            // finish the job by hand beats a stack trace they never see.
            this.notifications.error(this.i18n.t('No provider handles "{name}": opening the settings', { name: profile.name }))
            this.openProfilesSettingsTab()
            return
        }

        // Never the live object: the modal mutates what it is handed, so a
        // cancelled edit would otherwise keep its changes — in the displayed
        // tree, and in `config.store` for anything reachable from it (piège
        // #12). tabby-settings and tabby-core's own tree both clone here too,
        // for the same reason.
        const modal = openProfileModal(this.ngbModal, structuredClone(profile), provider)
        if (!modal) {
            this.notifications.error(this.i18n.t(PROFILE_MODAL_UNAVAILABLE))
            return
        }

        const result = await modal.result.catch(() => null) as PartialProfile<Profile>|null
        if (!result) {
            return
        }
        result.type = provider.id
        await this.profilesService.writeProfile(result)
        await this.config.save()
    }

    ////// PROFILE DUPLICATION (context menu) //////
    /**
     * "Dupliquer" — a copy of the profile, in the same folder, named
     * "<name> - Copie".
     *
     * `structuredClone()` first, always: `newProfile()` pushes the very object
     * it is handed into `config.store.profiles`, so a shallow copy would leave
     * both entries sharing one `options` object — editing either would silently
     * edit the other. `contextMenuProfile` happens to be detached already
     * (`readProfileGroups()` clones the whole tree), and relying on that is
     * exactly the kind of assumption piège #12 is made of.
     *
     * `isBuiltin`/`isTemplate` are dropped like `pickProfileTemplate()` does: a
     * copy of a provider-contributed profile belongs to the user, and keeping
     * the flag would file it back under the synthetic "built-in" group, which
     * is not editable. Their `group` is a provider-declared *name*, not a real
     * group id, so it goes too — the copy lands in "Ungrouped", where the user
     * can pick it up.
     *
     * `weight` is kept on purpose: same rank as the original, and `sort()`
     * being stable, the copy lands right underneath it rather than at the end
     * of the folder. `id` is deleted so `newProfile()` mints a fresh one — it
     * only generates an id when the incoming profile has none, and rejects a
     * collision otherwise.
     */
    async duplicateProfile (profile: PartialProfile<Profile>): Promise<void> {
        this.closeContextMenu()
        const copy = structuredClone(profile) as PartialProfile<Profile> & { isTemplate?: boolean, isBuiltin?: boolean }
        if (copy.isBuiltin) {
            delete copy.group
        }
        delete copy.isTemplate
        delete copy.isBuiltin
        // The clone must not keep the source id: `ProfilesService.newProfile()`
        // only mints a fresh one when the incoming profile has none, and
        // otherwise rejects the insert as a duplicate id.
        delete copy.id
        copy.name = this.copyNameFor(profile)
        await this.profilesService.newProfile(copy)
        // Provider-side state (the SSH password lives in the vault, keyed by
        // profile id) is not part of the profile object, so copying it alone
        // would leave the clone reading "password not set". Let the provider
        // carry that state onto the copy.
        const provider = this.profilesService.providerForProfile(copy) ?? this.profilesService.providerForProfile(profile)
        await provider?.duplicateProfile?.(profile as any, copy as any)
        // The memo travels with the copy. Nothing carries it on its own — a
        // note is keyed by profile id, and `newProfile()` has just minted a new
        // one — yet duplicating a server to make a variant of it and losing
        // what one had written about it is the wrong default.
        this.copyNote(profile.id, copy.id)
        await this.config.save()
    }

    /**
     * "X" → "X - Copie", then "X - Copie 2", "X - Copie 3"… against the names
     * already in the same folder.
     *
     * The bare suffix is what the roadmap asked for, and it is enough right up
     * until the gesture is repeated: duplicating the same profile twice would
     * otherwise put two identically named rows in the tree, with nothing on
     * screen telling them apart.
     *
     * Duplicating a *copy* is a different case and keeps stacking —
     * "X - Copie - Copie" — because that name is genuinely free. Worth knowing
     * before reading it as a bug: it looked like one during the test of
     * 2026-08-03, until the gesture was retraced.
     *
     * Read off `rawGroupsSnapshot` rather than `config.store.profiles`: the
     * latter does not hold provider-contributed profiles, and this only has to
     * be right about what the folder *displays* (piège #74).
     */
    private copyNameFor (profile: PartialProfile<Profile>): string {
        const siblings = new Set(
            (this.rawGroupsSnapshot.find(g => g.id === (profile.group ?? 'ungrouped'))?.profiles ?? [])
                .map(p => p.name),
        )
        const base = this.i18n.t('{name} - Copy', { name: profile.name ?? '' })
        if (!siblings.has(base)) {
            return base
        }
        let n = 2
        while (siblings.has(`${base} ${n}`)) {
            n++
        }
        return `${base} ${n}`
    }

    ////// NOTES //////
    /**
     * The memo of a profile or folder, empty when there is none.
     *
     * Not inherited, unlike the snippet maps that sit beside it in the config:
     * a folder's note repeated on each of its profiles would be noise, so a
     * folder's note belongs to the folder and shows on its own row.
     */
    noteFor (id: string|undefined): string {
        return id ? (this.config.store.sidebarPlus?.profileNotes?.[id] ?? '') : ''
    }

    /**
     * Whether a badge is due on this row.
     *
     * Gated on the block rather than on the text alone: switching notes off has
     * to take the badges with it, and the note itself survives untouched for
     * when it comes back on.
     */
    hasNote (id: string|undefined): boolean {
        return this.showNotes && !!this.noteFor(id)
    }

    async openNoteModal (): Promise<void> {
        const id = this.contextMenuProfile?.id ?? this.contextMenuGroup?.id
        const name = this.contextMenuProfile?.name ?? this.contextMenuGroup?.name ?? ''
        this.closeContextMenu()
        if (!id) {
            return
        }
        const modal = this.ngbModal.open(NoteModalComponent, { size: 'lg' })
        modal.componentInstance.targetName = name
        modal.componentInstance.text = this.noteFor(id)
        const text = await modal.result.catch(() => null) as string|null
        if (text === null) {
            return
        }
        this.config.store.sidebarPlus ??= {}
        // Rebuilt and reassigned rather than mutated in place (piège #23), and
        // an emptied note leaves no key behind rather than an empty string
        // nobody can tell from "never written".
        const all: Record<string, string> = { ...(this.config.store.sidebarPlus.profileNotes ?? {}) }
        if (text.trim()) {
            all[id] = text
        } else {
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete all[id]
        }
        this.config.store.sidebarPlus.profileNotes = all
        await this.config.save()
    }

    /** Puts the same note on a second id, leaving the first alone — used when a profile is duplicated. */
    private copyNote (fromId: string|undefined, toId: string|undefined): void {
        const text = this.noteFor(fromId)
        if (!text || !toId) {
            return
        }
        this.config.store.sidebarPlus ??= {}
        this.config.store.sidebarPlus.profileNotes = {
            ...(this.config.store.sidebarPlus.profileNotes ?? {}),
            [toId]: text,
        }
    }

    /** Carries a note over when a folder is given a new id, or drops it when an entry is deleted. */
    private moveNote (oldId: string, newId: string|null): void {
        this.config.store.sidebarPlus ??= {}
        const all: Record<string, string> = { ...(this.config.store.sidebarPlus.profileNotes ?? {}) }
        if (!(oldId in all)) {
            return
        }
        if (newId) {
            all[newId] = all[oldId]
        }
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete all[oldId]
        this.config.store.sidebarPlus.profileNotes = all
    }

    ////// GROUP SHARING (context menu) //////
    /**
     * "Copier la structure (JSON)" and "Copier sans les identifiants".
     *
     * Two entries rather than one setting: the level belongs to the gesture,
     * not to a preference — the same folder goes to one's other machine whole
     * and to a colleague stripped, and there is no reason to walk to the
     * settings between the two.
     *
     * Reads `rawGroupsSnapshot`, the workspace-*unfiltered* tree, for the same
     * reason `reparentGroup()` does: a folder half-hidden in the active
     * workspace would otherwise export as half a folder, silently.
     */
    async copyGroupStructure (level: PurgeLevel): Promise<void> {
        const group = this.contextMenuGroup
        this.closeContextMenu()
        if (!group) {
            return
        }
        const payload = buildPayload(group, this.rawGroupsSnapshot, level)
        this.platform.setClipboard({ text: JSON.stringify(payload, null, 2) })

        const { folders, profiles } = countPayload(payload.group)
        const purged = this.describePurgeText(payload.removed)
        this.notices.notice(
            this.i18n.t(
                'Folder "{name}" copied: {folders, plural, =1 {# folder} other {# folders}}, {profiles, plural, =1 {# profile} other {# profiles}}.',
                { name: group.name ?? '', folders, profiles },
            ),
            purged ? this.i18n.t('Removed: {purged}.', { purged }) : undefined,
        )
    }

    /**
     * "Coller le groupe", from the right-click on empty sidebar space.
     *
     * At the root only, which is where the roadmap put it. Pasting *into* a
     * folder is the same code with a different parent, but the folder menu
     * already carries eleven entries and nobody has asked.
     *
     * Nothing here trusts the payload: `parsePayload()` re-runs the purge on
     * the way in, because the JSON is text off the clipboard — hand-editable,
     * possibly written elsewhere — and its own account of what it had removed
     * is worth nothing.
     */
    async pasteGroup (): Promise<void> {
        this.closeContextMenu()
        const { payload, error } = parsePayload(this.platform.readClipboard())
        if (!payload) {
            this.notices.error(error ? this.tMsg(error) : this.i18n.t('The clipboard does not hold a shared folder.'))
            return
        }

        const name = payload.group.name?.trim() || this.i18n.t('Pasted folder')
        const { folders, profiles } = countPayload(payload.group)
        const purged = this.describePurgeText(payload.removed)

        // Against the root folders as *displayed*, from the unfiltered
        // snapshot: a folder hidden in the active workspace still occupies its
        // name, and colliding with something invisible is worse than colliding
        // with something one can see (piège #74).
        const collision = this.rawGroupsSnapshot.find(g => !g.parentGroupId && g.name === name)
        let target: string|null = null
        let finalName = name

        if (collision) {
            const modal = this.ngbModal.open(PasteGroupModalComponent)
            modal.componentInstance.groupName = name
            modal.componentInstance.folders = folders
            modal.componentInstance.profiles = profiles
            modal.componentInstance.suffixedName = this.rootGroupCopyName(name)
            modal.componentInstance.purged = purged
            const resolution = await modal.result.catch(() => null) as PasteResolution|null
            if (!resolution) {
                return
            }
            if (resolution === 'merge') {
                target = collision.id
            } else {
                finalName = this.rootGroupCopyName(name)
            }
        }

        const created = await this.applySharedGroup(payload.group, finalName, target, undefined)
        await this.config.save()

        // A profile whose provider is not installed is not an error — it is
        // stored fine and does nothing when launched. Said once, here, because
        // the row looks exactly like any other and the failure would only show
        // on a double-click much later.
        const unknown = created.types.filter(t => !this.profileProviders.some(p => p.id === t))
        this.notices.notice(
            this.i18n.t(
                'Folder "{name}" pasted: {folders, plural, =1 {# folder} other {# folders}}, {profiles, plural, =1 {# profile} other {# profiles}}.',
                { name: finalName, folders: created.folders, profiles: created.profiles },
            ),
            [
                purged ? this.i18n.t('Removed at export: {purged}. To be re-entered.', { purged }) : '',
                unknown.length ? this.i18n.t(
                    '{count, plural, =1 {Profile type not installed} other {Profile types not installed}}: {list}.',
                    { count: unknown.length, list: [...new Set(unknown)].join(', ') },
                ) : '',
            ].filter(Boolean).join(' ') || undefined,
        )

        // Said separately, and as an error: a payload that still carried what
        // its own header called removed was not written by this plugin, or was
        // edited afterwards. The paste itself is fine — the second purge caught
        // it — but the user is entitled to know the JSON they pasted was not
        // what it claimed.
        if (!isEmptyReport(payload.strippedOnImport)) {
            this.notices.error(
                this.i18n.t('This JSON still carried secrets its own header declared removed.'),
                this.i18n.t('Removed at paste: {purged}.', { purged: this.describePurgeText(payload.strippedOnImport!) }),
            )
        }
    }

    /**
     * Writes one shared folder and everything under it into the config.
     *
     * `target` is set only when merging: the folder already exists, so nothing
     * is created for this level and the contents land inside it. A sub-folder
     * colliding *inside* a merge is not asked about again — it is created
     * alongside, which the modal says out loud.
     *
     * `newProfileGroup({ genId: true })` mints the id and writes it back onto
     * the object handed over, exactly as `reparentGroup()` relies on.
     */
    private async applySharedGroup (
        shared: SharedGroup,
        name: string,
        target: string|null,
        parentGroupId: string|undefined,
    ): Promise<{ folders: number, profiles: number, types: string[] }> {
        let groupId = target
        let folders = 0
        if (!groupId) {
            const group = {
                id: '',
                name,
                icon: shared.icon,
                color: shared.color,
                defaults: shared.defaults,
                parentGroupId,
            } as PartialProfileGroup<ProfileGroup>
            await this.profilesService.newProfileGroup(group, { genId: true })
            groupId = group.id
            folders = 1
        }

        let profiles = 0
        const types: string[] = []
        for (const shape of shared.profiles) {
            // Rebuilt rather than spread from the payload: what goes into
            // `config.store.profiles` is the plugin's own object, never one
            // parsed off the clipboard. `newProfile()` mints the id.
            const profile = {
                name: shape.name || 'Profil',
                type: shape.type,
                icon: shape.icon,
                color: shape.color,
                weight: shape.weight,
                options: shape.options ?? {},
                group: groupId,
            } as PartialProfile<Profile>
            await this.profilesService.newProfile(profile)
            profiles++
            if (shape.type) {
                types.push(shape.type)
            }
        }

        for (const child of shared.children) {
            const sub = await this.applySharedGroup(child, child.name?.trim() || this.i18n.t('Folder'), null, groupId)
            folders += sub.folders
            profiles += sub.profiles
            types.push(...sub.types)
        }

        return { folders, profiles, types }
    }

    /**
     * "Prod" → "Prod - Copie", then "Prod - Copie 2", among the root folders.
     *
     * Same shape as `copyNameFor()` for profiles, deliberately: two gestures
     * that produce a near-duplicate should name it the same way, and the user
     * has already read that suffix once.
     */
    private rootGroupCopyName (name: string): string {
        const taken = new Set(this.rawGroupsSnapshot.filter(g => !g.parentGroupId).map(g => g.name))
        const base = this.i18n.t('{name} - Copy', { name })
        if (!taken.has(base)) {
            return base
        }
        let n = 2
        while (taken.has(`${base} ${n}`)) {
            n++
        }
        return `${base} ${n}`
    }

    ////// SNIPPETS //////
    /** How long a snippet waits for a session it asked to be launched, and how often it looks. */
    private static readonly SNIPPET_LAUNCH_POLL_MS = 250
    private static readonly SNIPPET_LAUNCH_ATTEMPTS = 80

    /**
     * Opens the snippets modal on the right-clicked profile or folder.
     *
     * Everything it shows and writes lives in `SidebarPlusSnippetsService`.
     * What stays here is what needs the sidebar's own reach: running a snippet
     * into a session, and opening the settings tab.
     */
    async openSnippetsModal (): Promise<void> {
        const profile = this.contextMenuProfile
        const group = this.contextMenuGroup
        this.closeContextMenu()
        const modal = this.ngbModal.open(SnippetsModalComponent, { size: 'lg' })
        modal.componentInstance.profile = profile
        modal.componentInstance.group = group
        const result = await modal.result.catch(() => null) as SnippetsModalResult|null
        if (!result) {
            return
        }
        if (result.action === 'library') {
            SidebarPlusSettingsTabComponent.requestedSection = 'snippets'
            this.openPluginSettings()
            return
        }
        await this.runSnippet(result.snippet, profile)
    }

    /**
     * Opens one of the footer's outbound links in the user's browser.
     *
     * `platform.openExternal()`, never a plain `href`: an anchor left to
     * navigate would replace the whole Electron window with the target page,
     * taking every open session down with it. Same call the tunnel rows make.
     */
    openExternalLink (url: string, event: MouseEvent): void {
        event.preventDefault()
        event.stopPropagation()
        this.platform.openExternal(url)
    }

    /**
     * Opens the plugin's settings tab, resolving whichever tab id currently
     * hosts it — 'better-tabby' when the "Better *" family is unified,
     * 'better-sidebar' when this plugin is alone. Never hardcode the id (see
     * `electBetterPanelHost()`); callers that want a specific section set
     * `SidebarPlusSettingsTabComponent.requestedSection` first.
     */
    openPluginSettings (): void {
        const election = electBetterPanelHost(this.injector)
        if (election.unified) {
            // Whichever plugin hosts the panel reads this at construction
            // and pre-selects our tab, so a section request above lands
            // even when the vault carries the settings.
            this.injector.get<BetterPanelContribution>(SIDEBAR_PANEL_TOKEN as any).openRequested = true
        }
        this.openSettingsTab(election.settingsTabId)
    }

    /**
     * Writes a snippet into the profile's session.
     *
     * Both behaviours are resolved from the chain, so the answer may come from
     * the profile, from its folder, or from one further up.
     */
    private async runSnippet (snippet: SidebarSnippet, profile: PartialProfile<Profile>|null): Promise<void> {
        if (!profile) {
            return
        }
        const chain = this.snippets.chainForProfile(profile)
        // The snippet is passed along: its own answer overrides the profile and
        // its folders, so a destructive command cannot be made self-running by
        // a permissive folder.
        const execute = this.snippets.resolveSetting('execute', chain, snippet.id)
        const autoLaunch = this.snippets.resolveSetting('autoLaunch', chain, snippet.id)
        const { text, missing } = this.snippets.expand(snippet, chain, profile)
        if (missing.length) {
            this.notices.error(
                this.i18n.t('"{name}" expects a value', { name: snippet.name }),
                this.i18n.t('{list}: to fill in under "Snippets".', { list: missing.map(name => `{{${name}}}`).join(', ') }),
            )
            return
        }

        let tab = this.terminalTabForProfile(profile)
        if (!tab) {
            if (!autoLaunch) {
                this.notices.notice(this.i18n.t('"{name}" has no open session', { name: profile.name }))
                return
            }
            await this.launchProfile(profile)
            tab = await this.waitForTerminalTab(profile)
            if (!tab) {
                this.notices.error(this.i18n.t('The session of "{name}" did not open', { name: profile.name }))
                return
            }
            // Only on a session this click just opened: an already-open one has
            // nothing left to settle. See `launchDelayMs` for why a plain wait
            // is the honest answer here rather than a cleverer one.
            const delay = this.snippets.resolveDelay(chain, snippet.id)
            if (delay) {
                await new Promise(resolve => setTimeout(resolve, delay))
            }
        }
        // Brought to the front before anything is written: in the default
        // "type it, don't run it" mode the command sits at the prompt waiting
        // for the user's Entrée, and a prompt they cannot see is worse than no
        // snippet at all.
        focusTab(this.app, tab)
        tab.sendInput(execute ? `${text}\n` : text)
    }

    /**
     * Any terminal tab currently backed by this profile — SSH or not.
     *
     * Deliberately wider than `connectedTabForProfile()`, which answers the
     * same question for tunnels and has to stay SSH-only. What a snippet needs
     * is something that can be typed into, i.e. a `BaseTerminalTabComponent`,
     * so a local profile gets snippets too.
     *
     * `instanceof` is safe on this class where it is not on `SSHTabComponent`:
     * Tabby's plugin loader caches `tabby-terminal`, so only one copy of it is
     * ever loaded (piège #34 is about `tabby-ssh`, which it does not cache).
     * `hotkeys.ts` already leans on the same test.
     */
    private terminalTabForProfile (profile: PartialProfile<Profile>): BaseTerminalTabComponent<any>|null {
        if (!profile.id) {
            return null
        }
        for (const tab of getAllOpenTabs(this.app)) {
            if (!(tab instanceof BaseTerminalTabComponent)) {
                continue
            }
            const backing = tab as unknown as ProfileBackedTab
            // A non-null `session` is the honest "still live" test — see
            // isLiveSSHTab() for why the transport's own flag is not.
            if (backing.profile?.id === profile.id && backing.session) {
                return tab
            }
        }
        return null
    }

    /**
     * Polls for the session a launch is bringing up.
     *
     * There is no "the remote shell is ready" signal to await: `launchProfile()`
     * resolves once the tab exists, and the transport comes up some time later.
     * So the tab is polled for, and what the snippet then hits is whatever the
     * prompt is at that moment — on a server with a long MOTD the text can land
     * mid-banner. Survivable because the default is to *type* the command
     * rather than run it. The optional wait is for the servers where it is not
     * enough.
     */
    private async waitForTerminalTab (profile: PartialProfile<Profile>): Promise<BaseTerminalTabComponent<any>|null> {
        for (let attempt = 0; attempt < SidebarPlusTreeComponent.SNIPPET_LAUNCH_ATTEMPTS; attempt++) {
            await new Promise(resolve => setTimeout(resolve, SidebarPlusTreeComponent.SNIPPET_LAUNCH_POLL_MS))
            const tab = this.terminalTabForProfile(profile)
            if (tab) {
                return tab
            }
        }
        return null
    }

    /** Settings > Profiles. Only reached when a profile has no resolvable provider. */
    private openProfilesSettingsTab (): void {
        this.openSettingsTab('profiles')
    }

    /** Reuses a Settings tab the user already had open rather than stacking a second one. */
    private openSettingsTab (activeTab: string): void {
        const existing = this.app.tabs.find(t => t instanceof SettingsTabComponent) as SettingsTabComponent|undefined
        if (existing) {
            existing.activeTab = activeTab
            this.app.selectTab(existing)
            return
        }
        this.app.openNewTabRaw({ type: SettingsTabComponent, inputs: { activeTab } })
    }

    /**
     * Refuses to delete a folder that still holds anything — counted on the
     * *unfiltered* snapshot, not on the node as displayed.
     *
     * The displayed node has already been through the active workspace's
     * hide lists, so a folder whose whole content is hidden there looked empty
     * and sailed past this guard. `deleteProfileGroup()` then removed the group
     * and cleared `group` on every profile that lived in it: the hidden
     * profiles resurfaced in "Ungrouped", visible everywhere, and hidden
     * subfolders were orphaned up to the root. `rawGroupsSnapshot` is the same
     * source `isSelfOrDescendant()` and `rescueTargetGroupId()` already consult
     * for exactly this kind of check.
     */
    async deleteGroup (group: PartialProfileGroup<CollapsableProfileGroup>): Promise<void> {
        const childCount = this.rawGroupsSnapshot.filter(g => g.parentGroupId === group.id).length
        const profileCount = this.rawGroupsSnapshot.find(g => g.id === group.id)?.profiles?.length ?? 0
        if (childCount || profileCount) {
            const reasons: string[] = []
            if (childCount) {
                reasons.push(this.i18n.t('{count, plural, =1 {# subfolder} other {# subfolders}}', { count: childCount }))
            }
            if (profileCount) {
                reasons.push(this.i18n.t('{count, plural, =1 {# profile} other {# profiles}}', { count: profileCount }))
            }
            // Said explicitly when the folder looks empty on screen: otherwise
            // the refusal reads as a bug rather than as a warning.
            const visible = (group.children?.length ?? 0) + (group.profiles?.length ?? 0)
            const hint = visible === 0
                ? ' ' + this.i18n.t('This content is hidden in the workspace "{name}".', { name: this.activeWorkspace?.name ?? this.i18n.t('current') })
                : ''
            this.notifications.error(
                this.i18n.t('Cannot delete "{name}"', { name: group.name }),
                this.i18n.t('This folder still contains {reasons}.{hint} Empty it first.', {
                    reasons: reasons.length === 2 ? this.i18n.t('{a} and {b}', { a: reasons[0], b: reasons[1] }) : reasons[0],
                    hint,
                }),
            )
            this.closeContextMenu()
            return
        }
        await this.profilesService.deleteProfileGroup(group)
        this.drag.forgetDeletedId('group', group.id)
        this.config.save()
        this.closeContextMenu()
    }

    ////// PROFILE DELETION (context menu) //////
    confirmDeleteProfile (): void {
        this.contextMenuMode = 'confirmDeleteProfile'
        this.menuPositionDirty = true
    }

    async deleteProfile (profile: PartialProfile<Profile>): Promise<void> {
        await this.profilesService.deleteProfile(profile)
        if (profile.id) {
            this.drag.forgetDeletedId('profile', profile.id)
        }
        await this.config.save()
        this.closeContextMenu()
    }
}
