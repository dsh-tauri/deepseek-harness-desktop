import type { ReactElement } from 'react'
import type { Translate } from '../locales/index.types'
import type { SkillRowView } from '../types'
import { Action, ArrowRotateRight, Button, Card, Checkbox, Field, GraduationCap, Icon, Input, LogoGithub, Modal, Pill, SegmentedControl, Switch, Tag, Text, Textarea, Toast, TriangleExclamation as Warning } from 'dsh-tauri-ui/client'
import { orderBy, uniq } from 'dsh-tauri/client'
import { useEffect, useMemo, useState } from 'react'
import { deleteSkill, getSkill, getSkills, postOpenDir, postRoots, postSkill, postSkillPolicy, postSkillsRefresh } from '../apis'
import { MarkdownPreview } from '../components/markdown'
import { IMPORT_REFRESH_DELAYS_MS, SKILL_REFRESH_INTERVAL_MS, SKILL_REFRESH_TIMEOUT_MS, SOURCE_LOCALE_KEYS } from '../constants'
import { useTimers } from '../hooks/use-timers'
import { failText } from './outcome.utils'
import { normalizeRepository, policyTag } from './skills-tab.utils'

export interface SkillEditorState {
  mode: 'edit' | 'view'
  name: string
  description: string
  whenToUse: string
  modelInvocable: boolean
  userInvocable: boolean
  content: string
}

export type OpenTarget = { target: 'user-skills' } | { target: 'skill', name: string }

export interface SkillsTabProps {
  t: Translate
  createSkill: () => Promise<void>
}

export function SkillsTab({ t, createSkill }: SkillsTabProps): ReactElement {
  const [skills, setSkills] = useState<SkillRowView[] | null>(null)
  const [editor, setEditor] = useState<SkillEditorState | null>(null)
  const [preview, setPreview] = useState(false)
  const [confirmName, setConfirmName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ text: string, seq: number } | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [query, setQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [importOpen, setImportOpen] = useState(false)
  const [repositoryUrl, setRepositoryUrl] = useState('')
  const { mounted, later } = useTimers()

  useEffect(() => {
    let current = true
    void getSkills().then(
      (body) => {
        if (current) {
          if ('error' in body) {
            setSkills([])
            setToast({ text: failText(t, new Error(body.error)), seq: Date.now() })
            return
          }
          setSkills(body.skills)
        }
      },
      (error: unknown) => {
        if (current) {
          setSkills([])
          setToast({ text: failText(t, error), seq: Date.now() })
        }
      },
    )
    return () => {
      current = false
    }
  }, [reload, t])

  const doRefresh = async (): Promise<void> => {
    setBusy(true)
    try {
      const body = await postSkillsRefresh()
      if ('error' in body)
        throw new Error(body.error)
      setSkills(body.skills)
    }
    catch {
      setReload(value => value + 1)
    }
    finally { setBusy(false) }
  }

  const refreshUntil = (predicate: (rows: SkillRowView[]) => boolean): void => {
    const deadline = Date.now() + SKILL_REFRESH_TIMEOUT_MS
    const tick = (): void => {
      if (Date.now() > deadline)
        return
      later(() => void getSkills().then((body) => {
        if (!mounted.current)
          return
        if ('error' in body) {
          tick()
          return
        }
        setSkills(body.skills)
        if (!predicate(body.skills))
          tick()
      }, tick), SKILL_REFRESH_INTERVAL_MS)
    }
    tick()
  }

  const openExisting = async (skill: SkillRowView): Promise<void> => {
    setBusy(true)
    try {
      const body = await getSkill({ name: skill.name })
      if ('error' in body)
        throw new Error(body.error)
      setPreview(!skill.editable)
      setEditor({ mode: skill.editable ? 'edit' : 'view', name: skill.name, description: skill.description, whenToUse: skill.whenToUse ?? '', modelInvocable: skill.invocation.modelInvocable, userInvocable: skill.invocation.userInvocable, content: body.content })
    }
    catch (error) { setToast({ text: failText(t, error), seq: Date.now() }) }
    finally { setBusy(false) }
  }

  const doSave = async (): Promise<void> => {
    if (editor === null)
      return
    const name = editor.name.trim()
    setBusy(true)
    setFormError(null)
    try {
      await postSkill({ name: editor.name.trim(), description: editor.description, whenToUse: editor.whenToUse.trim() || undefined, modelInvocable: editor.modelInvocable, userInvocable: editor.userInvocable, content: editor.content })
      setEditor(null)
      refreshUntil(rows => rows.some(row => row.name === name))
    }
    catch (error) { setFormError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const doDelete = async (): Promise<void> => {
    if (confirmName === null)
      return
    const name = confirmName
    setBusy(true)
    try {
      await deleteSkill({ name })
      refreshUntil(rows => !rows.some(row => row.name === name))
    }
    catch (error) { setToast({ text: failText(t, error), seq: Date.now() }) }
    finally {
      setBusy(false)
      setConfirmName(null)
    }
  }

  const doToggle = async (skill: SkillRowView): Promise<void> => {
    const enabled = skill.invocation.modelInvocable || skill.invocation.userInvocable
    setBusy(true)
    try {
      await postSkillPolicy({ name: skill.name, enabled: !enabled })
      refreshUntil((rows) => {
        const row = rows.find(item => item.name === skill.name)
        return row !== undefined && row.invocation.modelInvocable === !enabled && row.invocation.userInvocable === !enabled
      })
    }
    catch (error) { setToast({ text: failText(t, error), seq: Date.now() }) }
    finally { setBusy(false) }
  }

  const doOpen = async (target: OpenTarget): Promise<void> => {
    try {
      await postOpenDir(target)
    }
    catch (error) { setToast({ text: failText(t, error), seq: Date.now() }) }
  }

  const doCreate = async (): Promise<void> => {
    setBusy(true)
    try {
      await createSkill()
    }
    catch (error) { setToast({ text: `${t('skillCreatorFailed')}: ${error instanceof Error ? error.message : String(error)}`, seq: Date.now() }) }
    finally {
      if (mounted.current)
        setBusy(false)
    }
  }

  const doImport = async (): Promise<void> => {
    const url = normalizeRepository(repositoryUrl)
    if (url === null) {
      setFormError(t('importRepositoryInvalid'))
      return
    }
    setBusy(true)
    setFormError(null)
    try {
      await postRoots({ kind: 'git', url })
      setImportOpen(false)
      setRepositoryUrl('')
      for (const delay of IMPORT_REFRESH_DELAYS_MS) {
        await new Promise<void>(resolve => later(resolve, delay))
        if (!mounted.current)
          return
        const body = await getSkills()
        if ('error' in body)
          throw new Error(body.error)
        setSkills(body.skills)
      }
    }
    catch (error) { setFormError(error instanceof Error ? error.message : String(error)) }
    finally {
      if (mounted.current)
        setBusy(false)
    }
  }

  const needle = query.trim().toLowerCase()
  const filtered = useMemo(() => orderBy((skills ?? []).filter(skill => (sourceFilter === 'all' || skill.source === sourceFilter) && (needle === '' || skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle))), [skill => skill.repository === undefined]), [needle, skills, sourceFilter])
  const sources = skills === null ? [] : uniq(skills.map(skill => skill.source))
  const readOnly = editor?.mode === 'view'

  return (
    <div className="flex flex-col gap-[14px] text-primary">
      <div className="flex items-center gap-[10px] flex-wrap [&_h3]:m-0 [&_h3]:text-[16px] [&_h3]:leading-[24px] [&_h3]:font-medium">
        <span className="inline-flex items-center justify-center flex-none w-[22px] h-[22px]"><Icon as={GraduationCap} size={16} /></span>
        <h3>{t('skillsTitle')}</h3>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => void doOpen({ target: 'user-skills' })}>{t('openUserSkills')}</Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            setFormError(null)
            setImportOpen(true)
          }}
        >
          {t('importRepository')}
        </Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void doCreate()}>{t('newSkill')}</Button>
      </div>
      <Text tone="tertiary">{t('skillsIntro')}</Text>
      <div className="flex items-center gap-[7px] px-[2px] mt-[2px] [&_h3]:m-0 [&_h3]:text-[13px] [&_h3]:leading-[20px] [&_h3]:font-semibold">
        <h3>{t('skillsTab')}</h3>
        {skills && (
          <span className="text-[12px] leading-[18px] text-tertiary tabular-nums">
            {filtered.length}
            /
            {skills.length}
          </span>
        )}
        <span className="flex-1" />
        <Input className="w-[200px] max-[680px]:w-[140px]" type="search" placeholder={t('searchSkills')} aria-label={t('searchSkills')} value={query} onChange={event => setQuery(event.target.value)} />
        <Action variant="toolbar" icon={<Icon as={ArrowRotateRight} />} aria-label={t('refresh')} title={t('refresh')} disabled={busy} onClick={() => void doRefresh()} />
      </div>
      {sources.length > 1 && <div className="flex items-center gap-[6px] flex-wrap" role="group" aria-label={t('source')}>{[{ id: 'all', label: t('filterAll') }, ...sources.map(source => ({ id: source, label: t(SOURCE_LOCALE_KEYS[source] ?? 'sourceCustom') }))].map(chip => <Pill key={chip.id} active={sourceFilter === chip.id} onClick={() => setSourceFilter(chip.id)}>{chip.label}</Pill>)}</div>}
      {skills === null && <Text size="sm" tone="tertiary">{t('loading')}</Text>}
      {skills !== null && filtered.length === 0 && <Text size="sm" tone="tertiary">{skills.length === 0 ? t('emptySkills') : t('noMatch')}</Text>}
      {filtered.length > 0 && (
        <Card.List className="grid grid-cols-[repeat(2,minmax(0,1fr))] items-stretch gap-[10px] max-[680px]:grid-cols-[minmax(0,1fr)]">
          {filtered.map((skill) => {
            const tag = policyTag(skill)
            const githubUrl = skill.repository?.githubUrl
            return (
              <Card key={`${skill.source}/${skill.name}`} className="mx-0 flex flex-col gap-[8px] px-[14px] py-[12px]">
                <div className="flex items-center gap-[6px] flex-wrap">
                  <Card.Title className="flex-1 min-w-0 font-semibold [font-family:var(--ds-font-family-code)]" title={skill.name}>{skill.name}</Card.Title>
                  <Tag tone="info">{t(SOURCE_LOCALE_KEYS[skill.source] ?? 'sourceCustom')}</Tag>
                  {tag.key && <Tag tone={tag.off ? 'warning' : 'neutral'}>{t(tag.key)}</Tag>}
                </div>
                <Card.Description className="text-secondary line-clamp-2" title={skill.description}>{skill.description}</Card.Description>
                <div className="flex items-center gap-[6px] flex-wrap">
                  {skill.policyEditable && <Switch checked={skill.invocation.modelInvocable || skill.invocation.userInvocable} onChange={() => void doToggle(skill)} label={t('toggleSkill')} title={t('toggleSkillHint')} disabled={busy} />}
                  {skill.dir && <Button variant="ghost" size="sm" onClick={() => void doOpen({ target: 'skill', name: skill.name })}>{t('openFolder')}</Button>}
                  <span className="flex-1" />
                  {githubUrl !== undefined && <Action variant="toolbar" icon={<Icon as={LogoGithub} />} aria-label={t('githubRepository')} title={t('githubRepository')} onClick={() => window.open(githubUrl, '_blank', 'noopener,noreferrer')} />}
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void openExisting(skill)}>{skill.editable ? t('edit') : t('view')}</Button>
                  {skill.removable && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmName(skill.name)}>{t('delete')}</Button>}
                </div>
              </Card>
            )
          })}
        </Card.List>
      )}

      <Modal open={editor !== null} onClose={() => setEditor(null)} closeLabel={t('close')} title={editor?.mode === 'edit' ? t('editSkill') : t('viewSkill')} className="w-[min(760px,100%)]!" contentClassName="max-h-[calc(100vh-160px)]! overflow-y-auto">
        {editor && (
          <div className="flex flex-col gap-[10px]">
            <Field label={t('skillName')}>
              <Input value={editor.name} disabled />
            </Field>
            <Field label={t('skillDescription')}>
              <Input value={editor.description} disabled={readOnly} onChange={event => setEditor({ ...editor, description: event.target.value })} />
            </Field>
            <Field label={t('skillWhenToUse')}>
              <Input value={editor.whenToUse} disabled={readOnly} onChange={event => setEditor({ ...editor, whenToUse: event.target.value })} />
            </Field>
            <div className="flex items-center gap-[16px] flex-wrap">
              <Checkbox checked={editor.modelInvocable} disabled={readOnly} onChange={next => setEditor({ ...editor, modelInvocable: next })}>
                {t('modelInvocable')}
              </Checkbox>
              <Checkbox checked={editor.userInvocable} disabled={readOnly} onChange={next => setEditor({ ...editor, userInvocable: next })}>
                {t('userInvocable')}
              </Checkbox>
            </div>
            <div className="flex flex-col gap-[4px] text-[12px] leading-[18px] text-secondary [&>span:first-child]:text-tertiary">
              <div className="flex items-center gap-[6px] flex-wrap">
                <span>{t('skillContent')}</span>
                <span className="flex-1" />
                <SegmentedControl
                  label={t('skillContent')}
                  value={preview ? 'preview' : 'text'}
                  options={[
                    { value: 'preview', label: t('skillPreview') },
                    { value: 'text', label: readOnly ? t('skillPlainText') : t('edit') },
                  ]}
                  onChange={next => setPreview(next === 'preview')}
                />
              </div>
              {preview ? <div className="min-h-[320px] max-h-[60vh] overflow-y-auto border border-border-l2 rounded-[8px] px-[12px] py-[8px] bg-layer-1 text-[13px]"><MarkdownPreview text={editor.content} /></div> : <Textarea value={editor.content} readOnly={readOnly} onChange={event => setEditor({ ...editor, content: event.target.value })} />}
            </div>
            {formError && <Text tone="error">{formError}</Text>}
            <div className="flex items-center gap-[6px] flex-wrap">
              <span className="flex-1" />
              <Button variant="ghost" onClick={() => setEditor(null)}>{readOnly ? t('close') : t('cancel')}</Button>
              {!readOnly && <Button variant="primary" disabled={busy} onClick={() => void doSave()}>{t('save')}</Button>}
            </div>
          </div>
        )}
      </Modal>
      <Modal
        open={confirmName !== null}
        onClose={() => setConfirmName(null)}
        closeLabel={t('close')}
        title={t('confirmDelete')}
        description={confirmName ?? undefined}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setConfirmName(null)}>{t('cancel')}</Button>
            <Button variant="primary" disabled={busy} onClick={() => void doDelete()}>{t('delete')}</Button>
          </>
        )}
      >
        <p>{t('deleteWarn')}</p>
      </Modal>
      <Modal open={importOpen} onClose={() => setImportOpen(false)} closeLabel={t('close')} title={t('importRepositoryTitle')} className="w-[min(680px,100%)]!">
        <div className="flex flex-col gap-[10px]">
          <Text tone="tertiary">{t('importRepositoryHint')}</Text>
          <Field label={t('repository')}>
            <Input
              autoFocus
              placeholder={t('importRepositoryPlaceholder')}
              value={repositoryUrl}
              onChange={event => setRepositoryUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter')
                  void doImport()
              }}
            />
          </Field>
          {formError && <Text tone="error">{formError}</Text>}
          <div className="flex items-center gap-[6px] flex-wrap">
            <span className="flex-1" />
            <Button variant="ghost" disabled={busy} onClick={() => setImportOpen(false)}>{t('cancel')}</Button>
            <Button variant="primary" disabled={busy || repositoryUrl.trim() === ''} onClick={() => void doImport()}>{t('importRepository')}</Button>
          </div>
        </div>
      </Modal>
      {toast !== null && <Toast key={toast.seq} text={toast.text} icon={<Icon as={Warning} />} onDone={() => setToast(null)} />}
    </div>
  )
}
