// Undo toasts instead of "Are you sure?": the change happens at once, and a toast offers to undo it for a
// few seconds (Ctrl/Cmd+Z works too while it's showing). Undo reverses through the normal routes, so the
// audit trail still shows both the change and the undo.
const listeners = new Set();
let seq = 0;
export function toast(message, { undo = null, tone = 'ok', ms = undo ? 8000 : 4000 } = {}) {
  const t = { id: ++seq, message, undo, tone, ms };
  listeners.forEach((f) => f(t));
  return t.id;
}
export const onToast = (f) => { listeners.add(f); return () => listeners.delete(f); };

// Runs `doIt`, then shows `message` with Undo wired to `undoIt`. Errors from either show as a red toast.
export async function undoable(message, doIt, undoIt) {
  let result;
  try {
    result = await doIt();
  } catch (e) {
    toast(e.message || 'That didn’t work', { tone: 'error' });
    throw e;
  }
  toast(message, {
    undo: undoIt && (async () => {
      try { await undoIt(result); toast('Undone'); } catch (e) { toast(`Couldn’t undo: ${e.message}`, { tone: 'error' }); }
    }),
  });
  return result;
}
