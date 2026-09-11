import { ICONS, type IconName } from './icons'

export interface IconProps {
  name: IconName
  /** Sized by the caller, in the same Tailwind classes as any other element. */
  className?: string
  /** Only for an icon that is the whole of a control's label. */
  title?: string
}

/** One Material Symbol, drawn at whatever size the class says. */
export function Icon({ name, className = 'h-4 w-4', title }: IconProps) {
  return (
    <svg
      viewBox="0 -960 960 960"
      // Decorative by default: the icons sit beside their own text, and a
      // screen reader reading "folder folder" is worse than silence.
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      fill="currentColor"
      className={`flex-none ${className}`}
    >
      {title && <title>{title}</title>}
      <path d={ICONS[name]} />
    </svg>
  )
}
