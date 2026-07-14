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
