import {
  closeWindow,
  minimizeWindow,
  report,
  toggleMaximizeWindow,
} from '../ipc'
import { useMaximized } from '../lib/useMaximized'
import { Icon } from './Icon'
import type { IconName } from './icons'

/**
 * The caption buttons the window manager would have drawn itself. `TabStrip`
 * decides where that is; this draws them wherever it is asked to.
 *
 * The sizes and the close-hover red are Windows' own — `--color-danger` is this
 * app's red for text, not for a filled hit area. Close asks the window to close
 * rather than destroying it, so the running-sessions prompt still gets its say.
 */
export function WindowControls() {
  const maximized = useMaximized()

  return (
    <div className="flex h-full flex-none items-stretch">
      <CaptionButton
        label="Minimize"
        icon="window_minimize"
        onClick={() => void minimizeWindow().catch(report)}
      />
      <CaptionButton
        label={maximized ? 'Restore' : 'Maximize'}
        icon={maximized ? 'window_restore' : 'window_maximize'}
        onClick={() => void toggleMaximizeWindow().catch(report)}
      />
      <CaptionButton
        label="Close"
        icon="close"
        onClick={() => void closeWindow().catch(report)}
        className="hover:bg-[#c42b1c] hover:text-white"
      />
    </div>
  )
}

interface CaptionButtonProps {
  label: string
  icon: IconName
  onClick(): void
  className?: string
}

function CaptionButton({
  label,
  icon,
  onClick,
  className = 'hover:bg-surface-hover hover:text-ink',
}: CaptionButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={`flex w-[46px] flex-none items-center justify-center text-muted ${className}`}
    >
      <Icon name={icon} className="h-3 w-3" />
    </button>
  )
}
