import { useState } from 'react'
import { Maximize2 } from '@/components/icons'
import { SidePanelHeader } from '@/components/shell/SidePanelHeader'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { QUIET_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'
import { UsageDashboardContent } from './UsageDashboardContent'

/**
 * Right-panel view for AI Usage & Quota (live Claude/Antigravity limits, daily
 * token & estimated USD cost chart, and per-session / per-project breakdowns),
 * with a 1-click button to expand into a wide modal dashboard.
 */
export function UsageDashboardPanel(): React.JSX.Element {
  const [expandedOpen, setExpandedOpen] = useState(false)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SidePanelHeader title="AI Usage">
        <button
          type="button"
          aria-label="Expand usage dashboard"
          title="Open wide usage dashboard"
          onClick={() => setExpandedOpen(true)}
          className={cn(QUIET_ICON_BUTTON_CLASS, 'size-7')}
        >
          <Maximize2 size={13} />
        </button>
      </SidePanelHeader>

      <div className="scroller-thin min-h-0 flex-1 overflow-y-auto">
        <UsageDashboardContent />
      </div>

      <Dialog open={expandedOpen} onOpenChange={setExpandedOpen}>
        <DialogContent className="max-h-[88vh] max-w-3xl overflow-hidden p-0">
          <DialogHeader className="border-b border-border px-5 py-3.5">
            <DialogTitle className="text-sm">AI Usage &amp; Quota Dashboard</DialogTitle>
            <DialogDescription className="text-xs">
              Live Claude &amp; Antigravity plan limits alongside token &amp; estimated USD cost
              analytics.
            </DialogDescription>
          </DialogHeader>
          <div className="scroller-thin max-h-[75vh] overflow-y-auto">
            <UsageDashboardContent wide />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
