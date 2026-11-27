import { describe, expect, it } from 'vitest'

import { placeholderAntigravityName } from './antigravity-account-name'

describe('placeholderAntigravityName', () => {
  it('uses the plain placeholder first', () => {
    expect(placeholderAntigravityName(['Work'])).toBe('New account')
  })

  it('numbers the next one, ignoring case', () => {
    expect(placeholderAntigravityName(['new account'])).toBe('New account 2')
    expect(placeholderAntigravityName(['New account', 'New account 2'])).toBe('New account 3')
  })
})
