import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Info } from '@/components/icons'
import { TOUCH_HIT_AREA_CLASS } from '@/components/phone-modal-classes'
import { openerApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'

export type AccountProviderId = 'claude' | 'codex' | 'antigravity'

interface ProviderTerms {
  name: string
  company: string
  autoSwitchRisk: string
  docsUrl: string
}

const docsUrl = (page: string): string =>
  `https://usetroupe.dev/docs/agent-setup/${page}#risks-of-switching-accounts`

export const PROVIDER_TERMS: Record<AccountProviderId, ProviderTerms> = {
  claude: {
    name: 'Claude',
    company: 'Anthropic',
    autoSwitchRisk:
      'Anthropic says Claude plan limits assume ordinary, individual use. Its terms do not allow access by automated means unless Anthropic permits it, and Anthropic can suspend an account without notice.',
    docsUrl: docsUrl('claude-accounts')
  },
  codex: {
    name: 'Codex',
    company: 'OpenAI',
    autoSwitchRisk:
      "OpenAI's terms do not allow getting around rate limits or restrictions. Moving a chat to another account at its Codex limit can count as that. OpenAI's own answer to a Codex limit is to buy credits or use an API key.",
    docsUrl: docsUrl('codex-accounts')
  },
  antigravity: {
    name: 'Antigravity',
    company: 'Google',
    autoSwitchRisk:
      "Google's Antigravity FAQ says automated account rotation is not supported on consumer plans. Google has suspended Antigravity access for breaking its terms.",
    docsUrl: docsUrl('antigravity-accounts')
  }
}

const SHARED_SWITCH_RISK =
  'A provider can suspend all the accounts of one person together. Safer options are to switch by hand when a chat reaches its limit, buy extra usage or credits, or use an API key.'

function openDocs(url: string): void {
  void openerApi.openUrlWithSystemBrowser(url).then((result) => {
    if (result.success) return
    void logFrontendError({
      level: 'warn',
      source: 'account-provider-terms',
      message: `[accounts] could not open ${url}: ${result.error}`
    })
  })
}

function DocsLink({ href, children }: { href: string; children: string }): React.JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn('text-foreground underline underline-offset-2', TOUCH_HIT_AREA_CLASS)}
      onClick={(event) => {
        event.preventDefault()
        openDocs(href)
      }}
    >
      {children}
    </a>
  )
}

export function AutoSwitchRiskDialog({
  provider,
  open,
  onConfirm,
  onCancel
}: {
  provider: AccountProviderId
  open: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  const terms = PROVIDER_TERMS[provider]
  return (
    <ConfirmDialog
      isOpen={open}
      title={`Switch ${terms.name} accounts automatically?`}
      message={terms.autoSwitchRisk}
      confirmLabel="Turn on anyway"
      variant="danger"
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <p className="text-sm text-muted-foreground">
        {SHARED_SWITCH_RISK} <DocsLink href={terms.docsUrl}>Read more</DocsLink>
      </p>
    </ConfirmDialog>
  )
}

export function SecondAccountNotice({
  provider
}: {
  provider: AccountProviderId
}): React.JSX.Element {
  const terms = PROVIDER_TERMS[provider]
  return (
    <div
      role="note"
      data-testid="second-account-notice"
      className="flex items-start gap-2.5 rounded-lg border border-border bg-background px-3 py-2.5 text-xs text-secondary-foreground"
    >
      <Info size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-muted-foreground" />
      <p>
        Karsa does not recommend using many {terms.name} accounts. A separate work account is fine.
        Using several accounts to get past usage limits can break {terms.company}'s terms and get
        your accounts suspended. <DocsLink href={terms.docsUrl}>More info</DocsLink>
      </p>
    </div>
  )
}
