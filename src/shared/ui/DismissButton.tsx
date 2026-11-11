import { Icon } from './Icon'

/** A card's ✕, named by `label` for a screen reader and a tooltip. */
export function DismissButton({
  label,
  onClick,
}: {
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-4 flex-none items-center justify-center rounded-sm text-faint hover:bg-surface-hover hover:text-ink"
    >
      <Icon name="close" className="size-3" />
    </button>
  )
}
