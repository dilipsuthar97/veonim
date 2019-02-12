import { vscode } from '../core/extensions-api'
import { PromiseBoss } from '../support/utils'
import { Position } from '../vscode/types'
import nvim from '../neovim/api'

const boss = PromiseBoss()

// TODO: anyway to improve the glitchiness of undo/apply edit? any way to also pause render in undo
// or maybe figure out how to diff based on the partial modification
// call atomic? tricky with getting target lines for replacements
// even if done before atomic operations, line numbers could be off
const doRename = async () => {
  vscode.textSync.pause()
  const position = new Position(nvim.state.line, nvim.state.column)
  nvim.feedkeys('ciw')
  await nvim.untilEvent.insertLeave
  const newName = await nvim.expr('@.')
  nvim.feedkeys('u')
  vscode.textSync.resume()

  if (!newName) return
  const edits = await boss.schedule(vscode.language.provideRenameEdits(newName, position), { timeout: 10e3 })
  // TODO: why should we apply the patches here? why not have the providers.provideRenameEdits call
  // workspace.applyEdit directly and have that modify the documents?
  // make sure we support undos
  console.warn('NYI: rename edits:', edits)
  // nvim.applyPatches(await rename({ ...nvim.state, ...editPosition, newName }))
}

nvim.onAction('rename', doRename)
export default doRename
