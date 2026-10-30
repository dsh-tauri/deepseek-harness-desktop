export function clickIfPresent(selector: string): boolean {
  if (typeof document === 'undefined')
    return false
  const element = document.querySelector<HTMLElement>(selector)
  if (element === null)
    return false
  element.click()
  return true
}
