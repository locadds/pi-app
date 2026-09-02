const QUICK_SUBMIT_EVENT = 'pi-desktop:composer-quick-submit'

type ComposerQuickSubmitDetail = {
  prompt: string
}

export function submitComposerPrompt(prompt: string): void {
  const normalized = prompt.trim()
  if (!normalized) return
  window.dispatchEvent(
    new CustomEvent<ComposerQuickSubmitDetail>(QUICK_SUBMIT_EVENT, {
      detail: { prompt: normalized },
    }),
  )
}

export function onComposerQuickSubmit(listener: (prompt: string) => void): () => void {
  const handle = (event: Event) => {
    const prompt = (event as CustomEvent<ComposerQuickSubmitDetail>).detail?.prompt?.trim()
    if (prompt) listener(prompt)
  }
  window.addEventListener(QUICK_SUBMIT_EVENT, handle)
  return () => window.removeEventListener(QUICK_SUBMIT_EVENT, handle)
}
