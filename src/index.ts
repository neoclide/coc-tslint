import { exec } from 'child_process'
import { commands, ExtensionContext, LanguageClient, LanguageClientOptions, QuickfixItem, ServerOptions, services, ServiceStat, TextDocumentWillSaveEvent, TransportKind, workspace, WorkspaceMiddleware } from 'coc.nvim'
import { ProviderResult } from 'coc.nvim/lib/provider'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { CancellationToken, CodeAction, CodeActionContext, Command, ConfigurationParams, Diagnostic, RequestType, TextDocument, TextDocumentIdentifier, TextDocumentSaveReason, TextEdit } from 'vscode-languageserver-protocol'
import Uri from 'vscode-uri'
import which from 'which'
const errorRegex = /^(\w+):\s+([^\[]+)\[(\d+),\s*(\d+)\]:\s+(.*)$/

interface AllFixesParams {
  readonly textDocument: TextDocumentIdentifier
  readonly isOnSave: boolean
}

interface AllFixesResult {
  readonly documentVersion: number
  readonly edits: TextEdit[]
  readonly ruleId?: string
  readonly overlappingFixes: boolean
}

namespace AllFixesRequest {
  export const type = new RequestType<
    AllFixesParams,
    AllFixesResult,
    void,
    void
    >('textDocument/tslint/allFixes')
}

interface NoTSLintLibraryParams {
  readonly source: TextDocumentIdentifier
}

interface NoTSLintLibraryResult {
}

namespace NoTSLintLibraryRequest {
  export const type = new RequestType<NoTSLintLibraryParams, NoTSLintLibraryResult, void, void>('tslint/noLibrary')
}

interface Settings {
  enable: boolean
  jsEnable: boolean
  rulesDirectory: string | string[]
  configFile: string
  ignoreDefinitionFiles: boolean
  exclude: string | string[]
  validateWithDefaultConfig: boolean
  nodePath: string | undefined
  run: 'onSave' | 'onType'
  alwaysShowRuleFailuresAsWarnings: boolean
  autoFixOnSave: boolean | string[]
  trace: any
  workspaceFolderPath: string // 'virtual' setting sent to the server
}

export async function activate(context: ExtensionContext): Promise<void> {
  let { subscriptions, logger } = context
  const config = workspace.getConfiguration().get('tslint', {}) as any
  const enable = config.enable
  if (enable === false) return
  const file = context.asAbsolutePath('./lib/server/index.js')
  const filetypes = config.filetypes || ['typescript', 'typescript.jsx', 'typescript.tsx']
  const selector = filetypes.map(filetype => {
    return { language: filetype, scheme: 'file' }
  })

  let serverOptions: ServerOptions = {
    module: file,
    args: ['--node-ipc'],
    transport: TransportKind.ipc,
    options: {
      cwd: workspace.root,
      execArgv: config.execArgv || []
    }
  }

  let clientOptions: LanguageClientOptions = {
    documentSelector: selector,
    synchronize: {
      configurationSection: 'tslint',
      fileEvents: workspace.createFileSystemWatcher('**/tslint.{json,yml,yaml}')
    },
    diagnosticCollectionName: 'tslint',
    outputChannelName: 'tslint',
    initializationOptions: config.initializationOptions,
    middleware: {
      provideCodeActions: (document, range, context, token, next): ProviderResult<(Command | CodeAction)[]> => {
        // do not ask server for code action when the diagnostic isn't from tslint
        if (!context.diagnostics || context.diagnostics.length === 0) {
          return []
        }
        let tslintDiagnostics: Diagnostic[] = []
        for (let diagnostic of context.diagnostics) {
          if (diagnostic.source === 'tslint') {
            tslintDiagnostics.push(diagnostic)
          }
        }
        if (tslintDiagnostics.length === 0) return []
        let newContext: CodeActionContext = Object.assign({}, context, {
          diagnostics: tslintDiagnostics
        } as CodeActionContext)
        return next(document, range, newContext, token)
      },
      workspace: {
        configuration: (params: ConfigurationParams, token: CancellationToken, next: Function): any => {
          if (!params.items) return []
          let result: Settings[] = next(params, token, next)
          if (!result || !result.length) return []
          let config: Settings = Object.assign({}, result[0])
          let configFile = result[0].configFile || 'tslint.json'
          config.configFile = convertAbsolute(configFile)
          return getConfigFile().then(file => {
            config.configFile = file
            config.workspaceFolderPath = workspace.root
            return [config]
          })
        }
      } as WorkspaceMiddleware
    }
  }
  let client = new LanguageClient('tslint', 'tslint server', serverOptions, clientOptions)
  subscriptions.push(
    services.registLanguageClient(client)
  )
  let isReady = false

  subscriptions.push(commands.registerCommand('tslint.fixAllProblems', fixAllProblems))
  subscriptions.push(commands.registerCommand('tslint.createConfig', createDefaultConfiguration))
  subscriptions.push(commands.registerCommand('tslint.lintProject', lintProject))
  subscriptions.push(workspace.onWillSaveUntil(willSaveTextDocument, null, 'tslint'))
  subscriptions.push(commands.registerCommand('_tslint.applySingleFix', applyTextEdits))
  subscriptions.push(commands.registerCommand('_tslint.applySameFixes', applyTextEdits))
  subscriptions.push(commands.registerCommand('_tslint.applyAllFixes', applyTextEdits))
  subscriptions.push(commands.registerCommand('_tslint.applyDisableRule', applyDisableRuleEdit))
  subscriptions.push(commands.registerCommand('_tslint.showRuleDocumentation', showRuleDocumentation))

  client.onReady().then(() => {
    if (isReady) return
    isReady = true
    client.onRequest(NoTSLintLibraryRequest.type, () => {
      return {}
    })
  })

  function willSaveTextDocument(e: TextDocumentWillSaveEvent): void {
    if (client.serviceState != ServiceStat.Running) return
    let config = workspace.getConfiguration('tslint')
    let autoFix = config.get('autoFixOnSave', false)
    if (autoFix) {
      let document = e.document
      // only auto fix when the document was manually saved by the user
      if (e.reason != TextDocumentSaveReason.Manual) {
        return
      }
      if (!(isTypeScriptDocument(document) || isEnabledForJavaScriptDocument(document))) {
        return
      }
      if (e.waitUntil) {
        e.waitUntil(autoFixOnSave(document))
      }
    }
  }

  async function autoFixOnSave(document: TextDocument): Promise<any> {
    let start = Date.now()
    const timeBudget = 500 // total willSave time budget is 1500
    let retryCount = 0
    let retry = false
    let lastVersion = document.version
    let promise = client.sendRequest(AllFixesRequest.type, {
      textDocument: { uri: document.uri.toString() },
      isOnSave: true
    }).then(async result => {
      while (true) {
        if (Date.now() - start > timeBudget) {
          logger.info(`TSLint auto fix on save maximum time budget (${timeBudget}ms) exceeded.`)
          break
        }
        if (retryCount > 10) {
          logger.info(`TSLint auto fix on save maximum retries exceeded.`)
        }
        if (result) {
          retry = false
          if (lastVersion !== result.documentVersion) {
            logger.info('TSLint auto fix on save, server document version different than client version')
            retry = true // retry to get the fixes matching the document
          } else {
            // disable version check by passing -1 as the version, the event loop is blocked during `willSave`
            let success = await applyTextEdits(
              document.uri.toString(),
              -1,
              result.edits
            )
            if (!success) {
              workspace.showMessage('TSLint: Auto fix on save, edits could not be applied', 'error')
              break
            }
          }

          lastVersion = document.version

          if (result.overlappingFixes || retry) {
            // ask for more non overlapping fixes
            if (retry) {
              retryCount++
            }
            result = await client.sendRequest(AllFixesRequest.type, { // tslint:disable-line
              textDocument: { uri: document.uri.toString() },
              isOnSave: true
            })
          } else {
            break
          }
        } else {
          break
        }
      }
      return null
    })
    return promise
  }

  async function fixAllProblems(): Promise<void> {
    // server is not running so there can be no problems to fix
    if (client.serviceState != ServiceStat.Running) return
    let document = await workspace.document
    let uri: string = document.uri
    try {
      let result = await client.sendRequest(AllFixesRequest.type, { textDocument: { uri } }) // tslint:disable-line
      if (result) {
        let success = await applyTextEdits(
          uri,
          result.documentVersion,
          result.edits
        )
        if (!success) {
          workspace.showMessage('TSLint could not apply the fixes', 'error')
        }
      }
    } catch (e) {
      workspace.showMessage('Failed to apply TSLint fixes to the document. Please consider opening an issue with steps to reproduce.', 'error')
    }
  }
}

function isTypeScriptDocument(document: TextDocument): boolean {
  let { languageId } = document
  return ['typescript', 'typescript.jsx', 'typescript.tsx'].indexOf(languageId) !== -1
}

function isJavaScriptDocument(languageId): boolean {
  return languageId === 'javascript' || languageId === 'javascript.jsx'
}

function isEnabledForJavaScriptDocument(document: TextDocument): boolean {
  let isJsEnable = workspace.getConfiguration('tslint').get('jsEnable', false)
  if (isJsEnable && isJavaScriptDocument(document.languageId)) {
    return true
  }
  return false
}

function exists(file: string): Promise<boolean> {
  return new Promise<boolean>((resolve, _reject) => {
    fs.exists(file, value => { // tslint:disable-line
      resolve(value)
    })
  })
}

async function findTslint(rootPath: string): Promise<string> {
  const platform = process.platform
  if (platform === 'win32' &&
    (await exists(path.join(rootPath, 'node_modules', '.bin', 'tslint.cmd')))
  ) {
    return path.join('.', 'node_modules', '.bin', 'tslint.cmd')
  } else if (
    (platform === 'linux' || platform === 'darwin') &&
    (await exists(path.join(rootPath, 'node_modules', '.bin', 'tslint')))
  ) {
    return path.join('.', 'node_modules', '.bin', 'tslint')
  } else {
    try {
      return which.sync('tslint')
    } catch (e) {
      return null
    }
  }
}

async function createDefaultConfiguration(): Promise<void> {
  const folderPath = workspace.root
  const tslintConfigFile = path.join(folderPath, 'tslint.json')
  if (fs.existsSync(tslintConfigFile)) {
    await workspace.openResource(Uri.file(tslintConfigFile).toString())
  } else {
    const tslintCmd = await findTslint(folderPath)
    if (!tslintCmd) return
    const cmd = `${tslintCmd} --init`
    const p = exec(cmd, { cwd: folderPath, env: process.env })
    p.on('exit', async (code: number, _signal: string) => {
      if (code === 0) {
        await workspace.openResource(Uri.file(tslintConfigFile).toString())
      } else {
        workspace.showMessage('Could not run `tslint` to generate a configuration file. Please verify that you have `tslint` and `typescript` installed.', 'error')
      }
    })
  }
}

async function getConfigFile(): Promise<string> {
  let doc = await workspace.document
  let u = Uri.parse(doc.uri)
  let dir: string
  if (u.scheme !== 'file') {
    dir = workspace.cwd
  } else {
    dir = path.dirname(u.fsPath)
  }
  return resolveFile(dir, 'tslint.json')
}

function resolveFile(dir: string, file: string): string {
  let { root } = path.parse(dir)
  let home = os.homedir()
  while (dir != root && dir != home) {
    let p = path.join(dir, file)
    if (fs.existsSync(p)) {
      return p
    }
    dir = path.dirname(dir)
  }
  return null
}

async function lintProject(): Promise<void> {
  const folderPath = workspace.root
  const tslintCmd = await findTslint(folderPath)
  const tslintConfigFile = await getConfigFile()
  if (!tslintCmd) return
  let cmd = `${tslintCmd} -c ${tslintConfigFile} -p .`
  let res = await workspace.runTerminalCommand(cmd)
  if (res.success) return
  let { bufnr } = res
  await workspace.nvim.command(`silent! bd! ${bufnr}`)
  let lines = res.content.split('\n')
  let items: QuickfixItem[] = []
  for (let line of lines) {
    let ms = line.match(errorRegex)
    if (!ms) continue
    let [, type, file, lnum, col, message] = ms
    let uri = Uri.file(file).toString()
    let doc = workspace.getDocument(uri)
    let bufnr = doc ? doc.bufnr : 0
    let item: QuickfixItem = {
      filename: path.relative(workspace.cwd, file),
      lnum: Number(lnum),
      col: Number(col),
      type: type.slice(0, 1).toUpperCase(),
      text: message
    }
    if (bufnr) item.bufnr = bufnr
    items.push(item)
  }
  let { nvim } = workspace
  await nvim.call('setqflist', [items, ' ', 'Results of tslint'])
  await nvim.command('doautocmd User CocQuickfixChange')
}

async function applyTextEdits(uri: string, _documentVersion: number, edits: TextEdit[]): Promise<boolean> {
  let document = workspace.getDocument(uri)
  if (!document) return false
  await document.applyEdits(workspace.nvim, edits)
  return true
}

async function applyDisableRuleEdit(uri: string, documentVersion: number, edits: TextEdit[]): Promise<void> {
  let document = workspace.getDocument(uri)
  if (!document) return
  if (document.version != documentVersion) {
    workspace.showMessage(`TSLint fixes are outdated and can't be applied to the document.`, 'warning')
    return
  }
  // prefix disable comment with same indent as line with the diagnostic
  let edit = edits[0]
  let line = document.getline(edit.range.start.line)
  let indent = await workspace.nvim.call('indent', [edit.range.start.line + 1])
  let prefix = line.substr(0, indent)
  edit.newText = prefix + edit.newText
  await applyTextEdits(uri, documentVersion, edits)
}

function showRuleDocumentation(_uri: string, _documentVersion: number, _edits: TextEdit[], ruleId: string): void {
  const tslintDocBaseURL = 'https://palantir.github.io/tslint/rules'
  if (!ruleId) return
  workspace.nvim.call('coc#util#open_url', tslintDocBaseURL + '/' + ruleId, true)
}

function convertAbsolute(file: string): string {
  if (path.isAbsolute(file)) return file
  return path.join(workspace.root, file)
}
