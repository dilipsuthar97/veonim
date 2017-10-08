import { onServerRequest, fullBufferUpdate, partialBufferUpdate, references, definition, rename, signatureHelp, hover, symbols, workspaceSymbols } from './langserv/adapter'
import { ex, action, autocmd, until, cwdir, call, expr, getCurrentLine, feedkeys, define } from './ui/neovim'
import { cc, debounce, uriToPath, merge, readFile, NewlineSplitter } from './utils'
import { TextDocumentItem, TextDocumentIdentifier } from 'vscode-languageserver-types'
import getLanguageIdFromPath from './language-ids'
import * as hoverUI from './ui/plugins/hover'
import * as symbolsUI from './ui/plugins/symbols'
import Ripgrep from '@veonim/ripgrep'
import vimUI from './ui/canvasgrid'
import { resolve } from 'path'

interface ContentParams {
  textDocument: TextDocumentIdentifier
}

interface FilesParam {
  base?: string
}

let pauseUpdate = false
const cache = { filetype: '', file: '', revision: -1, cwd: '' }

const getFiles = (path: string): Promise<string[]> => new Promise(done => {
  const results: string[] = []
  const rg = Ripgrep(['--files'], { cwd: path })
  rg.stdout.pipe(NewlineSplitter()).on('data', (path: string) => results.push(path))
  rg.on('exit', () => done(results))
})

define.ModifiedBuffers`
  let current = bufnr('%')
  let bufs = filter(range(0, bufnr('$')), 'buflisted(v:val)')
  return map(filter(map(bufs, {key, val -> { 'path': expand('#'.val.':p'), 'mod': getbufvar(val, '&mod') }}), {key, val -> val.mod == 1}), {key, val -> val.path})
`

define.PatchCurrentBuffer`
  let pos = getcurpos()
  let patch = a:1
  for chg in patch
    if chg.op == 'delete'
      exec chg.line . 'd'
    elseif chg.op == 'replace'
      call setline(chg.line, chg.val)
    elseif chg.op == 'append'
      call append(chg.line, chg.val)
    end
  endfor
  call cursor(pos[1:])
`

const updateServer = async (lineChange = false) => {
  // TODO: better, more async
  const [ , line, column ] = await call.getpos('.')

  if (lineChange) partialBufferUpdate({
    ...cache,
    line,
    column,
    buffer: [ await getCurrentLine() ]
  })

  else fullBufferUpdate({
    ...cache,
    line,
    column,
    // TODO: buffer.getLines api built-in
    buffer: await call.getline(1, '$') as string[]
  })
}

const attemptUpdate = async (lineChange = false) => {
  if (pauseUpdate) return
  // TODO: buffer.changedtick api built-in
  const chg = await expr('b:changedtick')
  if (chg > cache.revision) updateServer(lineChange)
  cache.revision = chg
}

autocmd.bufEnter(debounce(async () => {
  const [ cwd, file, filetype ] = await cc(cwdir(), call.expand(`%f`), expr(`&filetype`))
  // TODO: changedtick -> revision
  merge(cache, { cwd, file, filetype, revision: -1 })
  updateServer()
}, 100))

autocmd.textChanged(debounce(() => attemptUpdate(), 200))
autocmd.textChangedI(() => attemptUpdate(true))

action('references', async () => {
  const [ , line, column ] = await call.getpos('.')
  const refs = await references({ ...cache, line, column })

  await call.setloclist(0, refs.map(m => ({
    lnum: m.line,
    col: m.column,
    text: m.desc
  })))

  ex('lopen')
  ex('wincmd p')
})

action('definition', async () => {
  const [ , line, column ] = await call.getpos('.')
  const loc = await definition({ ...cache, line, column })
  if (!loc || !loc.line || !loc.column) return
  await call.cursor(loc.line, loc.column)
})

action('rename', async () => {
  const [ , line, column ] = await call.getpos('.')
  pauseUpdate = true
  await feedkeys('ciw')
  await until.insertLeave()
  const newName = await expr('@.')
  await feedkeys('u')
  pauseUpdate = false
  const patches = await rename({ ...cache, line, column, newName })
  // TODO: change other files besides current buffer. using fs operations if not modified?
  patches.forEach(({ operations }) => call.PatchCurrentBuffer(operations))
})

action('hover', async () => {
  const [ , line, column ] = await call.getpos('.')
  const html = await hover({ ...cache, line, column })
  // TODO: get start column of the object
  // TODO: if multi-line html, anchor from bottom
  const y = vimUI.rowToY(vimUI.cursor.row - 1)
  const x = vimUI.colToX(column)
  hoverUI.show({ html, x, y })
})

autocmd.cursorMoved(() => hoverUI.hide())
autocmd.cursorMovedI(() => hoverUI.hide())

// TODO: this will be auto-triggered. get triggerChars from server.canDo
// TODO: try to figure out if we are inside func call? too much work? (so this func is not called when outside func)
action('signature-help', async () => {
  const [ , line, column ] = await call.getpos('.')
  const hint = await signatureHelp({ ...cache, line, column })
  if (!hint.signatures.length) return
  // TODO: support list of signatures
  const { label } = hint.signatures[0]
  const y = vimUI.rowToY(vimUI.cursor.row - 1)
  const x = vimUI.colToX(column)
  hoverUI.show({ html: label, x, y })
  // TODO: highlight params
  //const help = {
  //signatures: [{
  //label: 'text to be shown in the ui',
  //documentation?: 'doc comment for the UI',
  //parameters?: [{
  //label: 'ui label',
  //documentation?: 'ui doc'
  //}]
  //}],
  //activeSignature?: 0,
  //activeParameter?: 0
  //}
})

action('symbols', async () => {
  const listOfSymbols = await symbols(cache)
  listOfSymbols && symbolsUI.show(listOfSymbols)
})

action('workspace-symbols', async () => {
  const listOfSymbols = await workspaceSymbols(cache)
  listOfSymbols && symbolsUI.show(listOfSymbols)
})

onServerRequest<ContentParams, TextDocumentItem>('textDocument/xcontent', async ({ textDocument }) => {
  const path = uriToPath(textDocument.uri)
  const [ cwd, modifiedBuffers ] = await Promise.all([cwdir(), call.ModifiedBuffers()])
  const filepath = resolve(cwd, path)

  if (modifiedBuffers.includes(filepath)) {
    // TODO: use built-in neovim api for this?
    // getbufvar(name, '') gets full dict. might be faster to get all to client then parse out
    const bufferName = await call.bufname(filepath)
    const [ lines, filetype, revision ] = await Promise.all([
      call.getbufline(bufferName, 1, '$'),
      call.getbufvar(bufferName, '&filetype'),
      call.getbufvar(bufferName, 'changedtick'),
    ])

    return {
      languageId: filetype,
      uri: textDocument.uri,
      version: revision,
      text: lines.join('\n'),
    }
  }

  const fileContents = await readFile(filepath, { encoding: 'utf8' })

  return {
    uri: textDocument.uri,
    languageId: getLanguageIdFromPath(filepath),
    version: 1,
    text: fileContents
  }
})

onServerRequest<FilesParam, TextDocumentIdentifier[]>('workspace/xfiles', async ({ base }: { base?: string }) => {
  const cwd = base ? uriToPath(base) : await cwdir()
  const files = await getFiles(cwd)
  return files.map(path => ({ uri: `file://${path}` }))
})