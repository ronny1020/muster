import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { parseTable } from '../model/table'
import { useTextFile } from '../model/useTextFile'
import { codeStyle } from '../model/codestyle'
import { useSettings } from '../../../entities/preferences/model/useSettings'
import { useFontMetrics } from '../../../shared/lib/fontmetrics'
import { currentLocale } from '../../../shared/i18n/i18n'
import { Notice } from './Notice'

/**
 * How much of a table is drawn. A table is real elements, and the backend's
 * two-megabyte read holds enough to lock the thread that draws the window —
 * as many cells, as one wide row, or as one cell's text.
 */
const LIMITS = { cells: 60_000, columns: 500, characters: 2_000 }

export interface TableViewProps {
  /** Absolute path of the delimited file. */
  path: string
  delimiter: string
  /** Changes when the tree may have moved, which re-reads the file. */
  revision: string
}

/**
 * A CSV or TSV file as a table, its first row as the header.
 *
 * Every cell is a text node, so nothing a file holds can reach the DOM as
 * markup.
 */
export function TableView({ path, delimiter, revision }: TableViewProps) {
  const { t } = useTranslation('review')
  const { settings } = useSettings()
  const metrics = useFontMetrics(settings.fontFamily, settings.fontSize)
  const { file, error } = useTextFile(path, revision)
  const table = useMemo(
    () => file && parseTable(file.text, { delimiter, ...LIMITS }),
    [file, delimiter],
  )

  if (error) return <Notice tone="text-danger">{error}</Notice>
  if (!file || !table) return <Notice>{t('table.reading')}</Notice>
  if (table.rows.length === 0) return <Notice>{t('table.empty')}</Notice>

  const [header = [], ...body] = table.rows
  return (
    <div
      style={codeStyle(settings, metrics)}
      className="min-h-0 flex-1 overflow-auto text-ink select-text"
    >
      <table className="border-separate border-spacing-0 whitespace-pre">
        <thead className="sticky top-0 z-10 bg-surface">
          <tr>
            <th className="sticky left-0 z-10 border-r border-b border-line bg-surface" />
            {header.map((cell, column) => (
              <th
                key={column}
                scope="col"
                className="border-r border-b border-line px-2 py-0.5 text-left font-semibold"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((cells, row) => (
            <tr key={row} className="hover:bg-surface-hover">
              <th
                scope="row"
                className="sticky left-0 border-r border-b border-line bg-chrome px-2 text-right font-normal text-faint"
              >
                {row + 1}
              </th>
              {cells.map((cell, column) => (
                <td
                  key={column}
                  className="border-r border-b border-line px-2 py-0.5 align-top"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.shortened && (
        <Notice>
          {t('table.cellsShortened', {
            characters: LIMITS.characters.toLocaleString(currentLocale()),
          })}
        </Notice>
      )}
      {table.clipped && (
        <Notice>
          {t('table.columnsCapped', {
            columns: LIMITS.columns.toLocaleString(currentLocale()),
          })}
        </Notice>
      )}
      {(table.more || file.truncated) && (
        <Notice>
          {table.more
            ? t('table.rowsCapped', {
                rows: body.length.toLocaleString(currentLocale()),
              })
            : t('code.truncated')}
        </Notice>
      )}
    </div>
  )
}
