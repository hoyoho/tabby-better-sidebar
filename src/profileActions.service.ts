import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import {
    AppService,
    ConfigService,
    NotificationsService,
    PartialProfile,
    PartialProfileGroup,
    PlatformService,
    Profile,
    ProfileGroup,
    ProfileProvider,
    ProfilesService,
} from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { SidebarPlusSettingsTabComponent } from './components/settingsTab.component'
import { SnippetsModalComponent, SnippetsModalResult } from './components/snippetsModal.component'
import { NoteModalComponent } from './components/noteModal.component'
import { PasteGroupModalComponent, PasteResolution } from './components/pasteGroupModal.component'
import { openProfileModal, PROFILE_MODAL_UNAVAILABLE } from './profileModal'
import { buildPayload, countPayload, describePurge, isEmptyReport, parsePayload, PurgeLevel, PurgeReport, SharedGroup } from './groupShare'
import { TranslatableMessage } from './i18nMessage'
import { SidebarSnippet, SidebarWorkspace } from './configProvider'
import { CollapsableProfileGroup } from './sidebarTreeModel'
import { SidebarPlusI18nService } from './i18n'
import { SidebarPlusSnippetsService } from './snippets.service'
import { SidebarPlusNoticesService } from './notices.service'
import { focusTab, getAllOpenTabs } from './tabs'
import { ProfileBackedTab } from './liveState.service'

/** The profile-picker entry built from a provider's templates. */
export interface ProfileTemplateEntry {
    provider: ProfileProvider<Profile>
    template: PartialProfile<Profile>
}

/**
 * What the actions service needs from the component.
 *
 * The context menu is component UI state, and launching a profile belongs to
 * the tree (it decorates the profile with the workspace colour first), so both
 * come in as callbacks rather than being reimplemented here.
 */
export interface ProfileActionsHost {
    getContextMenuProfile: () => PartialProfile<Profile>|null
    getContextMenuGroup: () => PartialProfileGroup<CollapsableProfileGroup>|null
    getRawGroupsSnapshot: () => PartialProfileGroup<ProfileGroup>[]
    getActiveWorkspace: () => SidebarWorkspace|null
    setProfileTemplates: (templates: ProfileTemplateEntry[]) => void
    markMenuPositionDirty: () => void
    closeContextMenu: () => void
    /** The "show notes" block switch — a note badge disappears with it. */
    notesEnabled: () => boolean
    launchProfile: (profile: PartialProfile<Profile>) => Promise<unknown>
    openPluginSettings: () => void
    openSettingsTab: (activeTab: string) => void
    forgetDeletedId: (kind: 'profile'|'group', id: string) => void
}

/**
 * Profile and folder actions behind the context menus: create/rename/delete,
 * duplicate, notes, snippet running and JSON sharing.
 *
 * Kept apart from `SidebarPlusTreeComponent` because each of these is a
 * multi-step write against `config.store` and the profiles service — the
 * component only opens menus and delegates the gesture.
 */
export class SidebarPlusProfileActionsService {
    /** How long a snippet waits for a session it asked to be launched, and how often it looks. */
    private static readonly SNIPPET_LAUNCH_POLL_MS = 250
    private static readonly SNIPPET_LAUNCH_ATTEMPTS = 80

    constructor (
        private config: ConfigService,
        private profilesService: ProfilesService,
        private app: AppService,
        private notifications: NotificationsService,
        private ngbModal: NgbModal,
        private platform: PlatformService,
        private snippets: SidebarPlusSnippetsService,
        private notices: SidebarPlusNoticesService,
        private i18n: SidebarPlusI18nService,
        private profileProviders: ProfileProvider<Profile>[],
        private host: ProfileActionsHost,
    ) { }

    ////// RENAME //////
    async confirmRename (value: string): Promise<void> {
        const name = value.trim()
        if (!name) {
            return
        }
        const profile = this.host.getContextMenuProfile()
        const group = this.host.getContextMenuGroup()
        if (profile) {
            profile.name = name
            await this.profilesService.writeProfile(profile)
        } else if (group) {
            // Minimal {id, name} object only — see IconPickerModalComponent's
            // applyIcon() for why (never pass the displayed group itself, it
            // carries plugin-computed fields that writeProfileGroup() would
            // Object.assign() straight into config.yaml, roadmap piège #12).
            await this.profilesService.writeProfileGroup({ id: group.id, name } as PartialProfileGroup<ProfileGroup>)
        } else {
            return
        }
        await this.config.save()
        this.host.closeContextMenu()
    }

    ////// GROUP / PROFILE CREATION //////
    async createGroup (value: string): Promise<void> {
        const name = value.trim()
        if (!name) {
            return
        }
        const parentGroupId = this.host.getContextMenuGroup()?.id
        await this.profilesService.newProfileGroup({ name, parentGroupId } as PartialProfileGroup<ProfileGroup>, { genId: true })
        await this.config.save()
        this.host.closeContextMenu()
    }

    /** Loads every provider's templates into the create-profile picker; the component owns the popup's mode. */
    async loadProfileTemplates (): Promise<void> {
        const perProvider = await Promise.all(this.profileProviders.map(async provider => ({
            provider,
            templates: (await provider.getBuiltinProfiles()).filter(p => p.isTemplate),
        })))
        this.host.setProfileTemplates(perProvider.flatMap(({ provider, templates }) => templates.map(template => ({ provider, template }))))
        // The list grew after the await above — re-clamp now that the popup has its real, final size.
        this.host.markMenuPositionDirty()
    }

    async pickProfileTemplate (entry: ProfileTemplateEntry): Promise<void> {
        const groupId = this.host.getContextMenuGroup()?.id
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
        this.host.closeContextMenu()

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

    ////// PROFILE EDITING //////
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
        this.host.closeContextMenu()
        if (!profile) {
            return
        }

        const provider = this.profilesService.providerForProfile(profile)
        if (!provider) {
            // tabby-settings throws here. Sending the user somewhere they can
            // finish the job by hand beats a stack trace they never see.
            this.notifications.error(this.i18n.t('No provider handles "{name}": opening the settings', { name: profile.name }))
            this.host.openSettingsTab('profiles')
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

    ////// PROFILE DUPLICATION //////
    /**
     * "Dupliquer" — a copy of the profile, in the same folder, named
     * "<name> - Copie".
     *
     * `structuredClone()` first, always: `newProfile()` pushes the very object
     * it is handed into `config.store.profiles`, so a shallow copy would leave
     * both entries sharing one `options` object — editing either would silently
     * edit the other. The displayed profile happens to be detached already
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
        this.host.closeContextMenu()
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
     * Read off the unfiltered snapshot rather than `config.store.profiles`:
     * the latter does not hold provider-contributed profiles, and this only
     * has to be right about what the folder *displays* (piège #74).
     */
    private copyNameFor (profile: PartialProfile<Profile>): string {
        const siblings = new Set(
            (this.host.getRawGroupsSnapshot().find(g => g.id === (profile.group ?? 'ungrouped'))?.profiles ?? [])
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
        return this.host.notesEnabled() && !!this.noteFor(id)
    }

    async openNoteModal (): Promise<void> {
        const profile = this.host.getContextMenuProfile()
        const group = this.host.getContextMenuGroup()
        const id = profile?.id ?? group?.id
        const name = profile?.name ?? group?.name ?? ''
        this.host.closeContextMenu()
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
    moveNote (oldId: string, newId: string|null): void {
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

    ////// GROUP SHARING //////
    /**
     * "Copier la structure (JSON)" and "Copier sans les identifiants".
     *
     * Two entries rather than one setting: the level belongs to the gesture,
     * not to a preference — the same folder goes to one's other machine whole
     * and to a colleague stripped, and there is no reason to walk to the
     * settings between the two.
     *
     * Reads the workspace-*unfiltered* tree, for the same reason
     * `reparentGroup()` does: a folder half-hidden in the active workspace
     * would otherwise export as half a folder, silently.
     */
    async copyGroupStructure (level: PurgeLevel): Promise<void> {
        const group = this.host.getContextMenuGroup()
        this.host.closeContextMenu()
        if (!group) {
            return
        }
        const payload = buildPayload(group, this.host.getRawGroupsSnapshot(), level)
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
        this.host.closeContextMenu()
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
        const rootGroups = this.host.getRawGroupsSnapshot().filter(g => !g.parentGroupId)
        const collision = rootGroups.find(g => g.name === name)
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
        const taken = new Set(this.host.getRawGroupsSnapshot().filter(g => !g.parentGroupId).map(g => g.name))
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

    /**
     * Translates a `{ message, params }` handed back by a module with no
     * injector access of its own — `groupShare.ts` and friends — at the one
     * place that holds the i18n service.
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

    ////// SNIPPETS //////
    /**
     * Opens the snippets modal on the right-clicked profile or folder.
     *
     * Everything it shows and writes lives in `SidebarPlusSnippetsService`.
     * What stays here is what needs the sidebar's own reach: running a snippet
     * into a session, and opening the settings tab.
     */
    async openSnippetsModal (): Promise<void> {
        const profile = this.host.getContextMenuProfile()
        const group = this.host.getContextMenuGroup()
        this.host.closeContextMenu()
        const modal = this.ngbModal.open(SnippetsModalComponent, { size: 'lg' })
        modal.componentInstance.profile = profile
        modal.componentInstance.group = group
        const result = await modal.result.catch(() => null) as SnippetsModalResult|null
        if (!result) {
            return
        }
        if (result.action === 'library') {
            SidebarPlusSettingsTabComponent.requestedSection = 'snippets'
            this.host.openPluginSettings()
            return
        }
        await this.runSnippet(result.snippet, profile)
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
            await this.host.launchProfile(profile)
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
        for (let attempt = 0; attempt < SidebarPlusProfileActionsService.SNIPPET_LAUNCH_ATTEMPTS; attempt++) {
            await new Promise(resolve => setTimeout(resolve, SidebarPlusProfileActionsService.SNIPPET_LAUNCH_POLL_MS))
            const tab = this.terminalTabForProfile(profile)
            if (tab) {
                return tab
            }
        }
        return null
    }

    ////// DELETION //////
    /**
     * Refuses to delete a folder that still holds anything — counted on the
     * *unfiltered* snapshot, not on the node as displayed.
     *
     * The displayed node has already been through the active workspace's
     * hide lists, so a folder whose whole content is hidden there looked empty
     * and sailed past this guard. `deleteProfileGroup()` then removed the group
     * and cleared `group` on every profile that lived in it: the hidden
     * profiles resurfaced in "Ungrouped", visible everywhere, and hidden
     * subfolders were orphaned up to the root.
     */
    async deleteGroup (group: PartialProfileGroup<CollapsableProfileGroup>): Promise<void> {
        const snapshot = this.host.getRawGroupsSnapshot()
        const childCount = snapshot.filter(g => g.parentGroupId === group.id).length
        const profileCount = snapshot.find(g => g.id === group.id)?.profiles?.length ?? 0
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
                ? ' ' + this.i18n.t('This content is hidden in the workspace "{name}".', { name: this.host.getActiveWorkspace()?.name ?? this.i18n.t('current') })
                : ''
            this.notifications.error(
                this.i18n.t('Cannot delete "{name}"', { name: group.name }),
                this.i18n.t('This folder still contains {reasons}.{hint} Empty it first.', {
                    reasons: reasons.length === 2 ? this.i18n.t('{a} and {b}', { a: reasons[0], b: reasons[1] }) : reasons[0],
                    hint,
                }),
            )
            this.host.closeContextMenu()
            return
        }
        await this.profilesService.deleteProfileGroup(group)
        this.host.forgetDeletedId('group', group.id)
        this.config.save()
        this.host.closeContextMenu()
    }

    async deleteProfile (profile: PartialProfile<Profile>): Promise<void> {
        await this.profilesService.deleteProfile(profile)
        if (profile.id) {
            this.host.forgetDeletedId('profile', profile.id)
        }
        await this.config.save()
        this.host.closeContextMenu()
    }
}
