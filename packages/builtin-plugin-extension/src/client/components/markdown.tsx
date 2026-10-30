import type { ReactElement } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useMemo } from 'react'

const MD_BODY = [
  '[&_h1]:mt-[14px] [&_h1]:mb-[6px] [&_h1]:text-[18px] [&_h1]:text-primary [&_h1]:leading-[1.4]',
  '[&_h2]:mt-[14px] [&_h2]:mb-[6px] [&_h2]:text-[16px] [&_h2]:text-primary [&_h2]:leading-[1.4]',
  '[&_h3]:mt-[14px] [&_h3]:mb-[6px] [&_h3]:text-[14px] [&_h3]:text-primary [&_h3]:leading-[1.4]',
  '[&_h4]:mt-[14px] [&_h4]:mb-[6px] [&_h4]:text-[13px] [&_h4]:text-primary [&_h4]:leading-[1.4]',
  '[&_p]:my-[6px] [&_p]:leading-[20px]',
  '[&_ul]:my-[6px] [&_ul]:pl-[20px] [&_ol]:my-[6px] [&_ol]:pl-[20px]',
  '[&_code]:[font-family:var(--ds-font-family-code)] [&_code]:text-[12px] [&_code]:bg-layer-3 [&_code]:rounded-[4px] [&_code]:px-[5px] [&_code]:py-[1px]',
  '[&_pre]:my-[8px] [&_pre]:px-[12px] [&_pre]:py-[10px] [&_pre]:overflow-x-auto [&_pre]:border [&_pre]:border-border-l2 [&_pre]:rounded-[8px] [&_pre]:bg-layer-3',
  '[&_a]:text-business',
].join(' ')

export function MarkdownPreview(props: { text: string }): ReactElement {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(props.text, { async: false, gfm: true, breaks: false })), [props.text])
  // eslint-disable-next-line react/dom-no-dangerously-set-innerhtml -- DOMPurify 净化后保留原生 HTML 属性语义
  return <div className={MD_BODY} dangerouslySetInnerHTML={{ __html: html }} />
}
