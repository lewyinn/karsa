import { useCallback, useId, useMemo, useState } from 'react'
import { ModeChip } from '@/components/chat/AgentHeader'
import { AgentModelSelector } from '@/components/chat/agent-model-selector/AgentModelSelector'
import { AlertTriangle, Copy, ShieldAlert, Trash2 } from '@/components/icons'
import { RowMenu } from '@/components/settings/RowMenu'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { SEGMENTED_TRACK_CLASS, segmentClass } from '@/components/ui/panel-styles'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { SubagentApprovals, SubagentProfile, SubagentProfileView } from '@/lib/acp-api'
import { cn } from '@/lib/utils'
import { AgentRowIcon } from './AgentRowIcon'
import {
  agentLockReason,
  canDeleteProfile,
  MAX_DESCRIPTION_CHARS,
  profileIdError,
  profileSkipsPrompts,
  storedProfile
} from './profile-model'
import { type EditProfile, useProfilePicker } from './use-profile-picker'

/**
 * Saves `edit` of the profile named `id`, applied when the change is sent, so
 * it lands on every earlier edit. A rename is an edit of the id.
 */
export type SaveProfile = (id: string, edit: EditProfile) => Promise<void>

const APPROVALS: ReadonlyArray<{ value: SubagentApprovals; label: string }> = [
  { value: 'ask', label: 'Ask in chat' },
  { value: 'allowAll', label: 'Allow everything' }
]

function FieldRow({
  label,
  htmlFor,
  children
}: {
  label: string
  htmlFor?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 @[35rem]:grid @[35rem]:grid-cols-[7rem_minmax(0,1fr)] @[35rem]:gap-x-4">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="pt-2 text-sm text-foreground">
          {label}
        </label>
      ) : (
        <span className="pt-1.5 text-sm text-foreground">{label}</span>
      )}
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** The profile id: what the calling agent passes to start it. Saved on blur or Enter. */
function NameField({
  profile,
  others,
  onRename
}: {
  profile: SubagentProfileView
  others: readonly SubagentProfileView[]
  onRename: (id: string) => void
}): React.JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState(profile.id)
  const [syncedTo, setSyncedTo] = useState(profile.id)
  if (syncedTo !== profile.id) {
    setSyncedTo(profile.id)
    setDraft(profile.id)
  }
  const next = draft.trim()
  const error = next === profile.id ? null : profileIdError(next, others)
  const commit = (): void => {
    if (next !== profile.id && !error) onRename(next)
  }
  return (
    <FieldRow label="Name" htmlFor={id}>
      <Input
        id={id}
        value={draft}
        maxLength={64}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint`}
        className="h-8 max-w-xs font-mono text-xs md:text-xs"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
          if (event.key === 'Escape') setDraft(profile.id)
        }}
      />
      <p
        id={`${id}-hint`}
        className={cn('mt-1 text-xs', error ? 'text-destructive' : 'text-muted-foreground')}
      >
        {error ?? 'The calling agent passes this name to start the profile.'}
      </p>
    </FieldRow>
  )
}

function ApprovalsField({
  value,
  onChange
}: {
  value: SubagentApprovals
  onChange: (value: SubagentApprovals) => void
}): React.JSX.Element {
  const labelId = useId()
  return (
    <FieldRow label="Approvals">
      <span id={labelId} className="sr-only">
        Approvals
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className={cn(SEGMENTED_TRACK_CLASS, 'w-fit')}
      >
        {APPROVALS.map((option) => (
          // biome-ignore lint/a11y/useSemanticElements: segment of a track, not a native radio input
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            className={cn(segmentClass(option.value === value), 'h-7 pointer-coarse:h-11')}
            onClick={() => {
              if (option.value !== value) onChange(option.value)
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
      {value === 'allowAll' ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-warning">
          <AlertTriangle size={14} aria-hidden="true" className="mt-px shrink-0" />
          Karsa answers every permission prompt with Allow, except mode switches. Runs stay in
          their own worktree.
        </p>
      ) : null}
    </FieldRow>
  )
}

/** The note `subagent_list_agents` hands to the calling agent. Saved on blur; blank clears it. */
function NoteField({
  saved,
  onSave
}: {
  saved: string
  onSave: (description: string | null) => void
}): React.JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState(saved)
  const [syncedTo, setSyncedTo] = useState(saved)
  if (syncedTo !== saved) {
    setSyncedTo(saved)
    // Text typed after the save went out is newer than the reply.
    if (draft === syncedTo || draft.trim() === saved) setDraft(saved)
  }
  return (
    <FieldRow label="When to use" htmlFor={id}>
      <Textarea
        id={id}
        rows={3}
        maxLength={MAX_DESCRIPTION_CHARS}
        placeholder="e.g. Fast at UI tweaks and CSS; weak at Rust."
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          const trimmed = draft.trim()
          if (trimmed !== saved) onSave(trimmed || null)
        }}
      />
      <p className="mt-1 text-xs text-muted-foreground">
        Tells the calling agent what this profile is good at.
      </p>
    </FieldRow>
  )
}

/** An agent's only profile says why it stays, in the menu itself: a phone has no hover. */
function DeleteItem({
  deletable,
  onDelete
}: {
  deletable: boolean
  onDelete: () => void
}): React.JSX.Element {
  const reasonId = useId()
  return (
    <>
      <DropdownMenuItem
        disabled={!deletable}
        aria-describedby={deletable ? undefined : reasonId}
        onSelect={onDelete}
        className="gap-2 text-destructive focus:bg-destructive/10 focus:text-destructive"
      >
        <Trash2 size={14} />
        Delete
      </DropdownMenuItem>
      {deletable ? null : (
        <p id={reasonId} className="max-w-52 px-2 pb-1.5 text-xs text-muted-foreground">
          This agent's only profile. Switch it off instead.
        </p>
      )}
    </>
  )
}

/**
 * One sub-agent profile: its agent, name and note, the composer's model
 * picker as its model chip, its switch and a menu. Expanded, it edits the
 * name, the agent's mode, approvals and the note.
 */
export function ProfileRow({
  profile,
  profiles,
  launchableAgentIds,
  expanded,
  onToggle,
  save,
  rename,
  onDuplicate,
  onDelete
}: {
  profile: SubagentProfileView
  profiles: readonly SubagentProfileView[]
  launchableAgentIds: ReadonlySet<string>
  expanded: boolean
  onToggle: () => void
  save: SaveProfile
  rename: (from: string, to: string) => void
  onDuplicate: () => void
  onDelete: () => void
}): React.JSX.Element {
  const stored = useMemo(() => storedProfile(profile), [profile])
  const edit = useCallback((change: EditProfile) => save(profile.id, change), [save, profile.id])
  const lockReason = agentLockReason(profile, profiles)
  const picker = useProfilePicker({
    profile: stored,
    launchableAgentIds,
    pinned: lockReason !== null,
    edit
  })
  const others = useMemo(() => profiles.filter((other) => other !== profile), [profiles, profile])
  const installed = profile.agentName !== null
  const agentName = profile.agentName ?? picker.agentName ?? profile.agentId
  const skips = profileSkipsPrompts(stored)
  const panelId = useId()
  const update = (patch: Partial<SubagentProfile>): void => {
    void edit((current) => ({ ...current, ...patch })).catch(() => {})
  }
  const subtitle = installed
    ? (profile.description ?? `${agentName}. No note yet.`)
    : `${profile.agentId} is not installed. Its profile cannot start.`

  return (
    <div data-testid={`subagent-profile-${profile.id}`} data-settings-row="">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={onToggle}
          className="-m-1 flex min-w-[12rem] flex-1 items-center gap-3 rounded-md p-1 text-left transition-colors duration-150 ease-out hover:bg-foreground/[0.03] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
            <AgentRowIcon agentId={profile.agentId} name={agentName} />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-mono text-sm text-foreground">{profile.id}</span>
            <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
            {skips ? <span className="sr-only">Runs without asking for approval.</span> : null}
          </span>
        </button>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {installed ? (
            <AgentModelSelector
              draft={{ source: picker.source, agentName }}
              disabled={false}
              busy={false}
              modelOption={picker.modelOption}
              modelSource={picker.modelSource}
              thoughtLevel={picker.thoughtLevel}
              fastMode={picker.fastMode}
              agentTemplateId={picker.agentTemplateId}
              agentIcon={picker.agentIcon}
              genericOptions={[...picker.modelConfig, ...picker.genericOptions]}
              onSetConfig={picker.onSetConfig}
              onSetModel={picker.onSetModel}
              onOpenChange={picker.onOpenChange}
              marker={
                skips ? (
                  <ShieldAlert
                    size={13}
                    aria-hidden="true"
                    className="shrink-0 text-warning"
                    data-testid="subagent-profile-shield"
                  />
                ) : null
              }
            />
          ) : null}
          <Switch
            aria-label={`Let agents start ${profile.id}`}
            checked={profile.enabled}
            onCheckedChange={(enabled) => update({ enabled })}
          />
          <RowMenu label={`Actions for ${profile.id}`}>
            <DropdownMenuItem className="gap-2" onSelect={onDuplicate}>
              <Copy size={14} />
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DeleteItem deletable={canDeleteProfile(profile, profiles)} onDelete={onDelete} />
          </RowMenu>
        </div>
      </div>
      {expanded ? (
        <section
          id={panelId}
          aria-label={`${profile.id} settings`}
          className="flex flex-col gap-4 px-4 pb-4 pt-1 @[35rem]:pl-14"
        >
          <NameField profile={profile} others={others} onRename={(id) => rename(profile.id, id)} />
          {installed ? (
            <FieldRow label="Agent">
              <p className="pt-1.5 text-sm text-foreground">{agentName}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {lockReason ?? 'Pick another agent from the tabs of the model picker.'}
              </p>
            </FieldRow>
          ) : null}
          {picker.modeSession ? (
            <FieldRow label="Mode">
              <ModeChip
                session={picker.modeSession}
                disabled={false}
                onSelect={picker.onSetMode}
                label="Mode"
                agentName={agentName}
              />
            </FieldRow>
          ) : null}
          <ApprovalsField
            value={profile.approvals}
            onChange={(approvals) => update({ approvals })}
          />
          <NoteField
            saved={profile.description ?? ''}
            onSave={(description) => update({ description })}
          />
        </section>
      ) : null}
    </div>
  )
}
