import type { ComponentType, ReactElement, SVGProps } from 'react'

export type IconComponent = ComponentType<SVGProps<SVGSVGElement>>

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'as'> {
  as: IconComponent
  size?: number
}

export type SharedIconProps = Omit<SVGProps<SVGSVGElement>, 'as'> & { size?: number }

export function Icon({ as: Component, size = 16, ...props }: IconProps): ReactElement {
  return <Component {...props} width={size} height={size} />
}
