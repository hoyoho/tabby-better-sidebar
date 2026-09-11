import './hostChrome.scss'
import { Injectable } from '@angular/core'
import { AppService, ConfigService, NotificationsService } from 'tabby-core'
import { checkHost } from './hostCompat'

/** Set on `body` while Tabby's own transfers menu is to stay out of the way. */
const HIDE_NATIVE_TRANSFERS_CLASS = 'sidebar-plus-hide-native-transfers'

/**
 * Host chrome the plugin still has to touch by hand.
 *
 * The sidebar itself is contributed through Tabby's `SidebarContribution`
 * (`kind: 'owner'`, see sidebarContribution.ts), so there is no DOM mounting
 * left. This service keeps the compatibility report and hides Tabby's own
 * transfers menu while the plugin shows those transfers itself.
 */
@Injectable({ providedIn: 'root' })
export class SidebarPlusMountService {
    /**
     * Whether the host failed a precondition that leaves nothing worth running.
     *
     * Only the fatal verdict is kept. The per-feature detail is reported to the
     * user and to the console, but nothing consumes it programmatically yet:
     * retiring a single block (hiding the SFTP toggle when `SFTPPanelComponent`
     * is gone) needs a way to switch a block off, which is what the
     * "Interrupteurs par bloc" chantier builds.
     */
    private hostFatal = false

    constructor (
        private app: AppService,
        private config: ConfigService,
        private notifications: NotificationsService,
    ) {
        this.app.ready$.subscribe(() => {
            this.verifyHost()
            this.sync()
            this.config.changed$.subscribe(() => this.sync())
        })
    }

    /**
     * Checks what this plugin needs from Tabby, and says so **once**.
     *
     * Run from `ready$` rather than the constructor, and once only — `sync()`
     * re-runs on every `config.changed$`, so reporting from there would turn a
     * broken host into a stream of toasts.
     */
    private verifyHost (): void {
        const report = checkHost()
        this.hostFatal = report.fatal
        if (!report.failed.length) {
            return
        }

        const lost = report.failed.map(p => p.feature).join(', ')
        // console.error as well as the toast: a notification is gone in
        // seconds, and this is exactly the kind of failure someone comes back
        // to diagnose later.
        console.error(
            '[tabby-better-sidebar] Contrôle de compatibilité échoué :',
            report.failed.map(p => p.id).join(', '),
            '— cette version de Tabby ne fournit plus ce que le plugin attend.',
        )
        this.notifications.error(
            report.fatal
                ? 'tabby-better-sidebar ne peut pas démarrer sur cette version de Tabby — voir la console pour le détail'
                : `tabby-better-sidebar : ${lost} — indisponible sur cette version de Tabby`,
        )
    }

    private sync (): void {
        // Hiding Tabby's own transfers menu is only defensible while we show
        // those transfers ourselves. Three ways that stops being true — the
        // plugin switched off, the SFTP view switched off, the panel switched
        // off — and in each of them hiding it would leave the user with *no*
        // readout of a transfer at all, including transfers started by the
        // native panel or another plugin, which our registry only ever
        // mirrored. The setting keeps its value; only its effect is suspended.
        const enabled = !this.hostFatal && (this.config.store.sidebarPlus?.enabled ?? true)
        const sp = this.config.store.sidebarPlus
        const panelShown = (sp?.showSftp ?? true) && (sp?.showTransfers ?? true)
        const hide = enabled && panelShown && (sp?.hideNativeTransfersMenu ?? true)
        document.body.classList.toggle(HIDE_NATIVE_TRANSFERS_CLASS, hide)
    }
}
