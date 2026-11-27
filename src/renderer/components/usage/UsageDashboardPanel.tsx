import { useState } from 'react'
import { Maximize2 } from '@/components/icons'
import { SidePanelHeader } from '@/components/shell/SidePanelHeader'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { QUIET_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'
import { UsageDashboardContent, type UsageViewTab } from './UsageDashboardContent'

/**
 * Right-panel view for AI Usage & Quota (Limits / Tokens / Cost) with a 1-click
 * button to open the full-width Usage modal matching the 3-tab analytics layout.
 */
export function UsageDashboardPanel(): React.JSX.Element {
  const [expandedOpen, setExpandedOpen] = useState(false)
  const [currentTab, setCurrentTab] = useState<UsageViewTab>('limits')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SidePanelHeader title="Usage">
        <button
          type="button"
          aria-label="Expand usage dashboard"
          title="Open full usage dashboard"
          onClick={() => setExpandedOpen(true)}
          className={cn(QUIET_ICON_BUTTON_CLASS, 'size-7')}
        >
          <Maximize2 size={13} />
        </button>
      </SidePanelHeader>

      <div className="min-h-0 flex-1 overflow-hidden">
        <UsageDashboardContent initialTab={currentTab} onTabChange={setCurrentTab} />
      </div>

      <Dialog open={expandedOpen} onOpenChange={setExpandedOpen}>
        <DialogContent className="max-h-[88vh] max-w-5xl overflow-hidden rounded-xl border-border/80 bg-background p-0 [&>button:last-child]:hidden">
          <DialogTitle className="sr-only">AI Usage &amp; Quota Dashboard</DialogTitle>
          <div className="flex h-[80vh] min-h-0 flex-col">
            <UsageDashboardContent
              wide
              initialTab={currentTab}
              onTabChange={setCurrentTab}
              onClose={() => setExpandedOpen(false)}
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
