import { Label } from '@heroui/react'

export function ShortcutLabel({ label, hint }: { label: string, hint?: string }) {
  if (hint == null)
    return <Label>{label}</Label>
  return (
    <span className="flex w-full items-center justify-between gap-6">
      <Label>{label}</Label>
      <span className="shrink-0 font-mono text-xs text-muted" data-testid="dsh-navbar-shortcut-hint">{hint.replaceAll(' ', '')}</span>
    </span>
  )
}
