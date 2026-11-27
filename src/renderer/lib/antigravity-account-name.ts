/**
 * The name given to an Antigravity account whose name was left empty. Once the
 * account is signed in, the host renames it to the Google email. Keep in sync
 * with `PLACEHOLDER_NAME` in `src-tauri/src/acp/antigravity_agent/accounts.rs`.
 */
export const ANTIGRAVITY_PLACEHOLDER_NAME = 'New account'

/** `New account`, or `New account N` when that name is already in use. */
export function placeholderAntigravityName(existingNames: readonly string[]): string {
  const used = new Set(existingNames.map((name) => name.toLowerCase()))
  if (!used.has(ANTIGRAVITY_PLACEHOLDER_NAME.toLowerCase())) return ANTIGRAVITY_PLACEHOLDER_NAME
  for (let n = 2; ; n += 1) {
    const candidate = `${ANTIGRAVITY_PLACEHOLDER_NAME} ${n}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
}
