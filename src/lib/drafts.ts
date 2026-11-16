// What was typed into a session's message box and not sent yet. The box goes away when the drawer
// closes or shows another session; the text waits here, per session, until it is sent.

const texts = new Map<string, string>()

export const drafts = {
  get: (session: string): string => texts.get(session) ?? "",
  /** An empty text forgets the draft. */
  set(session: string, text: string) {
    if (text) texts.set(session, text)
    else texts.delete(session)
  },
  clear(session: string) {
    texts.delete(session)
  },
}
