// Web realizations of the share/clipboard capabilities the InvitePanel needs.
// Lives under src/platform/web/** (the sanctioned web-globals carve-out); the
// campaign page consumes these so the DOM-free layers (R1) never touch navigator.
export function canWebShare(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function'
}

export async function webShare(input: { title?: string; url: string }): Promise<void> {
  await navigator.share(input)
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}

/** Resolve an app-relative path against the page's origin — the absolute URL a
 *  share/copy action hands out (e.g. the recap page's copy-link exit). Lives
 *  here so DOM-free route code never reaches `window` itself. */
export function absoluteUrl(path: string): string {
  return new URL(path, window.location.origin).toString()
}
