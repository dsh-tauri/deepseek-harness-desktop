import type { ReactElement } from 'react'
import { Action, Button, Icon, TrashBin } from 'dsh-tauri-ui/client'
import { cn } from 'dsh-tauri/client'

const THUMB = 'flex-none w-[56px] h-[56px] flex items-center justify-center text-[28px] rounded-[10px] bg-layer-1 overflow-hidden object-cover [&>img]:block [&>img]:w-full [&>img]:h-full'
// 精灵图缩略图：8 列 × 11 行的雪碧图只露出左上角一帧。
const THUMB_SPRITE = 'relative [&>img]:absolute [&>img]:w-[800%] [&>img]:h-[1100%] [&>img]:max-w-none [&>img]:object-fill [&>img]:left-0 [&>img]:top-0'

/** 桌宠卡片（预设 / Chat / Codex 三类共用的展示单元）属性。 */
export interface PetCardProps {
  actionLabel: string
  active: boolean
  deleteLabel?: string
  desc: string
  disabled: boolean
  name: string
  onAction: () => void
  onDelete?: () => void
  onUpdate?: () => void
  updateLabel?: string
  thumbnail?: string
  thumbnailType?: 'gif' | 'spritesheet'
}

/** 桌宠卡片：缩略图 + 名称/描述 + 动作按钮（启用 / 选择 / 取消选择）与可选删除按钮。 */
export function PetCard(props: PetCardProps): ReactElement {
  const thumbnailClassName = cn(THUMB, props.thumbnailType === 'spritesheet' && THUMB_SPRITE)

  return (
    <div className={cn('flex items-center gap-[12px] px-[14px] py-[12px] rounded-[12px]', props.active && 'bg-hover')}>
      {props.thumbnail
        ? props.thumbnailType === 'spritesheet'
          ? (
              <span className={thumbnailClassName} aria-hidden="true">
                <img src={props.thumbnail} alt="" aria-hidden="true" />
              </span>
            )
          : <img className={thumbnailClassName} src={props.thumbnail} alt="" aria-hidden="true" />
        : <div className={THUMB} aria-hidden="true">PET</div>}
      <span className="flex-1 min-w-0 flex flex-col gap-[2px]">
        <span className="flex items-center gap-[6px] min-w-0">
          <span className="font-semibold text-[14px] leading-[20px] min-w-0 truncate">{props.name}</span>
        </span>
        {props.desc ? <span className="text-[12px] leading-[18px] text-secondary">{props.desc}</span> : null}
      </span>
      <span className="flex-none flex items-center gap-[6px]">
        {props.onDelete
          ? (
              <Action
                variant="action"
                className="text-tertiary hover:not-disabled:bg-hover hover:not-disabled:text-error"
                aria-label={props.deleteLabel}
                title={props.deleteLabel}
                disabled={props.disabled}
                onClick={props.onDelete}
              >
                <Icon as={TrashBin} size={14} />
              </Action>
            )
          : null}
        <Button
          type="button"
          variant={props.active ? 'primary' : 'outline'}
          size="sm"
          disabled={props.disabled}
          onClick={props.onAction}
        >
          {props.actionLabel}
        </Button>
        {props.onUpdate
          ? (
              <Button type="button" variant="outline" size="sm" disabled={props.disabled} onClick={props.onUpdate}>
                {props.updateLabel}
              </Button>
            )
          : null}
      </span>
    </div>
  )
}
