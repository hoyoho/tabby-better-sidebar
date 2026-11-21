/**
 * Wording shared by both upload paths.
 *
 * The drop controller and the local-pane upload each raise the same overwrite
 * question; keeping the sentence here means the two can never drift, and it is
 * testable with a stub translator — no Angular, no i18n service.
 */

/** The i18n service's `t()`, narrowed to what these builders need. */
export type Translate = (key: string, params?: Record<string, any>) => string

/**
 * The overwrite confirmation for a set of colliding file names.
 *
 * At most `namedLimit` names are spelled out: past that a modal listing every
 * file says nothing, so the remainder is reported as a count.
 */
export function overwritePrompt (
    collisions: string[],
    destination: string,
    t: Translate,
    namedLimit = 5,
): string {
    const named = collisions.slice(0, namedLimit)
    const rest = collisions.length - named.length
    const list = rest > 0
        ? t('{names}, and {rest, plural, =1 {# more} other {# more}}', { names: named.join(', '), rest })
        : named.join(', ')
    return collisions.length > 1
        ? t(
            '{count} files already exist under {destination} and will be overwritten: {list}. Continue?',
            { count: collisions.length, destination, list },
        )
        : t(
            'A file already exists under {destination} and will be overwritten: {list}. Continue?',
            { destination, list },
        )
}
