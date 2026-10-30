export function resolveActiveTab(rows: readonly { id: string }[], requested: string): string {
  return rows.some(row => row.id === requested) ? requested : rows[0]?.id ?? requested
}
