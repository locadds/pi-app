import type { IDocumentData } from '@univerjs/core'

const DOCS_DRAWING_RESOURCE_NAME = 'DOC_DRAWING_PLUGIN'

/**
 * Repairs early Office Surface worktrees that already contain drawing data and
 * custom blocks but were persisted before DOC_DRAWING_PLUGIN resources were
 * added. Existing edits and unrelated plugin resources are preserved.
 */
export function ensureUniverDocDrawingResourcesV1<T extends Partial<IDocumentData>>(
  document: T,
): T {
  const drawings = document.drawings
  if (!drawings || Object.keys(drawings).length === 0) return document
  const knownIds = new Set(Object.keys(drawings))
  const drawingsOrder = [...new Set(document.drawingsOrder ?? [])].filter((id) => knownIds.has(id))
  for (const drawingId of knownIds) {
    if (!drawingsOrder.includes(drawingId)) drawingsOrder.push(drawingId)
  }
  const resources = [
    ...(document.resources ?? []).filter((resource) => resource.name !== DOCS_DRAWING_RESOURCE_NAME),
    {
      name: DOCS_DRAWING_RESOURCE_NAME,
      data: JSON.stringify({ data: drawings, order: drawingsOrder }),
    },
  ]
  return {
    ...document,
    drawingsOrder,
    resources,
  }
}
