export default function (pi) {
  pi.on('session_start', async (event, ctx) => {
    if (!process.env.ORCA_PANE_KEY) return
    const prefill = process.env.ORCA_OMP_PREFILL
    if (!prefill) return
    try {
      ctx.ui.setEditorText(prefill)
      delete process.env.ORCA_OMP_PREFILL
    } catch {
      // leave ORCA_OMP_PREFILL in place so a later session_start can still apply it
    }
  })
}
