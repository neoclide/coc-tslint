"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const child_process_1 = require("child_process");
const coc_nvim_1 = require("coc.nvim");
const fs_1 = tslib_1.__importDefault(require("fs"));
const path_1 = tslib_1.__importDefault(require("path"));
const vscode_languageserver_protocol_1 = require("vscode-languageserver-protocol");
const vscode_uri_1 = tslib_1.__importDefault(require("vscode-uri"));
const which_1 = tslib_1.__importDefault(require("which"));
const errorRegex = /^(\w+):\s+([^\[]+)\[(\d+),\s*(\d+)\]:\s+(.*)$/;
var AllFixesRequest;
(function (AllFixesRequest) {
    AllFixesRequest.type = new vscode_languageserver_protocol_1.RequestType('textDocument/tslint/allFixes');
})(AllFixesRequest || (AllFixesRequest = {}));
var NoTSLintLibraryRequest;
(function (NoTSLintLibraryRequest) {
    NoTSLintLibraryRequest.type = new vscode_languageserver_protocol_1.RequestType('tslint/noLibrary');
})(NoTSLintLibraryRequest || (NoTSLintLibraryRequest = {}));
function activate(context) {
    return tslib_1.__awaiter(this, void 0, void 0, function* () {
        let { subscriptions, logger } = context;
        const config = coc_nvim_1.workspace.getConfiguration().get('tslint');
        const enable = config.enable;
        if (enable === false)
            return;
        const file = context.asAbsolutePath('./lib/server/index.js');
        const selector = [
            { language: 'typescript', scheme: 'file' },
            { language: 'typescript.jsx', scheme: 'file' },
            { language: 'typescript.tsx', scheme: 'file' },
            { language: 'javascript', scheme: 'file' },
            { language: 'javascript.jsx', scheme: 'file' }
        ];
        let serverOptions = {
            module: file,
            args: ['--node-ipc'],
            transport: coc_nvim_1.TransportKind.ipc,
            options: {
                cwd: coc_nvim_1.workspace.root,
                execArgv: config.execArgv
            }
        };
        let clientOptions = {
            documentSelector: selector,
            synchronize: {
                configurationSection: 'tslint',
                fileEvents: coc_nvim_1.workspace.createFileSystemWatcher('**/tslint.{json,yml,yaml}')
            },
            diagnosticCollectionName: 'tslint',
            outputChannelName: 'tslint',
            initializationOptions: config.initializationOptions,
            middleware: {
                provideCodeActions: (document, range, context, token, next) => {
                    // do not ask server for code action when the diagnostic isn't from tslint
                    if (!context.diagnostics || context.diagnostics.length === 0) {
                        return [];
                    }
                    let tslintDiagnostics = [];
                    for (let diagnostic of context.diagnostics) {
                        if (diagnostic.source === 'tslint') {
                            tslintDiagnostics.push(diagnostic);
                        }
                    }
                    if (tslintDiagnostics.length === 0)
                        return [];
                    let newContext = Object.assign({}, context, {
                        diagnostics: tslintDiagnostics
                    });
                    return next(document, range, newContext, token);
                },
                workspace: {
                    configuration: (params, token, next) => {
                        if (!params.items)
                            return [];
                        let result = next(params, token, next);
                        if (!result || !result.length)
                            return [];
                        let config = Object.assign({}, result[0]);
                        let configFile = result[0].configFile || 'tslint.json';
                        config.configFile = convertAbsolute(configFile);
                        config.workspaceFolderPath = coc_nvim_1.workspace.root;
                        return [config];
                    }
                }
            }
        };
        let client = new coc_nvim_1.LanguageClient('tslint', 'tslint server', serverOptions, clientOptions);
        subscriptions.push(coc_nvim_1.services.registLanguageClient(client));
        let isReady = false;
        client.onReady().then(() => {
            if (isReady)
                return;
            isReady = true;
            client.onRequest(NoTSLintLibraryRequest.type, () => {
                return {};
            });
            subscriptions.push(coc_nvim_1.workspace.onWillSaveUntil(willSaveTextDocument, null, 'tslint'));
            subscriptions.push(coc_nvim_1.commands.registerCommand('_tslint.applySingleFix', applyTextEdits));
            subscriptions.push(coc_nvim_1.commands.registerCommand('_tslint.applySameFixes', applyTextEdits));
            subscriptions.push(coc_nvim_1.commands.registerCommand('_tslint.applyAllFixes', applyTextEdits));
            subscriptions.push(coc_nvim_1.commands.registerCommand('_tslint.applyDisableRule', applyDisableRuleEdit));
            subscriptions.push(coc_nvim_1.commands.registerCommand('_tslint.showRuleDocumentation', showRuleDocumentation));
            subscriptions.push(coc_nvim_1.commands.registerCommand('tslint.fixAllProblems', fixAllProblems));
            subscriptions.push(coc_nvim_1.commands.registerCommand('tslint.createConfig', createDefaultConfiguration));
            subscriptions.push(coc_nvim_1.commands.registerCommand('tslint.lintProject', lintProject));
        });
        function willSaveTextDocument(e) {
            if (client.serviceState != coc_nvim_1.ServiceStat.Running)
                return;
            let config = coc_nvim_1.workspace.getConfiguration('tslint');
            let autoFix = config.get('autoFixOnSave', false);
            if (autoFix) {
                let document = e.document;
                // only auto fix when the document was manually saved by the user
                if (e.reason != vscode_languageserver_protocol_1.TextDocumentSaveReason.Manual) {
                    return;
                }
                if (!(isTypeScriptDocument(document) || isEnabledForJavaScriptDocument(document))) {
                    return;
                }
                if (e.waitUntil) {
                    e.waitUntil(autoFixOnSave(document));
                }
            }
        }
        function autoFixOnSave(document) {
            return tslib_1.__awaiter(this, void 0, void 0, function* () {
                let start = Date.now();
                const timeBudget = 500; // total willSave time budget is 1500
                let retryCount = 0;
                let retry = false;
                let lastVersion = document.version;
                let promise = client.sendRequest(AllFixesRequest.type, {
                    textDocument: { uri: document.uri.toString() },
                    isOnSave: true
                }).then((result) => tslib_1.__awaiter(this, void 0, void 0, function* () {
                    while (true) {
                        if (Date.now() - start > timeBudget) {
                            logger.info(`TSLint auto fix on save maximum time budget (${timeBudget}ms) exceeded.`);
                            break;
                        }
                        if (retryCount > 10) {
                            logger.info(`TSLint auto fix on save maximum retries exceeded.`);
                        }
                        if (result) {
                            retry = false;
                            if (lastVersion !== result.documentVersion) {
                                logger.info('TSLint auto fix on save, server document version different than client version');
                                retry = true; // retry to get the fixes matching the document
                            }
                            else {
                                // disable version check by passing -1 as the version, the event loop is blocked during `willSave`
                                let success = yield applyTextEdits(document.uri.toString(), -1, result.edits);
                                if (!success) {
                                    coc_nvim_1.workspace.showMessage('TSLint: Auto fix on save, edits could not be applied', 'error');
                                    break;
                                }
                            }
                            lastVersion = document.version;
                            if (result.overlappingFixes || retry) {
                                // ask for more non overlapping fixes
                                if (retry) {
                                    retryCount++;
                                }
                                result = yield client.sendRequest(AllFixesRequest.type, {
                                    textDocument: { uri: document.uri.toString() },
                                    isOnSave: true
                                });
                            }
                            else {
                                break;
                            }
                        }
                        else {
                            break;
                        }
                    }
                    return null;
                }));
                return promise;
            });
        }
        function fixAllProblems() {
            return tslib_1.__awaiter(this, void 0, void 0, function* () {
                // server is not running so there can be no problems to fix
                if (client.serviceState != coc_nvim_1.ServiceStat.Running)
                    return;
                let document = yield coc_nvim_1.workspace.document;
                let uri = document.uri;
                try {
                    let result = yield client.sendRequest(AllFixesRequest.type, { textDocument: { uri } }); // tslint:disable-line
                    if (result) {
                        let success = yield applyTextEdits(uri, result.documentVersion, result.edits);
                        if (!success) {
                            coc_nvim_1.workspace.showMessage('TSLint could not apply the fixes', 'error');
                        }
                    }
                }
                catch (e) {
                    coc_nvim_1.workspace.showMessage('Failed to apply TSLint fixes to the document. Please consider opening an issue with steps to reproduce.', 'error');
                }
            });
        }
    });
}
exports.activate = activate;
function isTypeScriptDocument(document) {
    let { languageId } = document;
    return ['typescript', 'typescript.jsx', 'typescript.tsx'].indexOf(languageId) !== -1;
}
function isJavaScriptDocument(languageId) {
    return languageId === 'javascript' || languageId === 'javascript.jsx';
}
function isEnabledForJavaScriptDocument(document) {
    let isJsEnable = coc_nvim_1.workspace.getConfiguration('tslint').get('jsEnable', false);
    if (isJsEnable && isJavaScriptDocument(document.languageId)) {
        return true;
    }
    return false;
}
function exists(file) {
    return new Promise((resolve, _reject) => {
        fs_1.default.exists(file, value => {
            resolve(value);
        });
    });
}
function findTslint(rootPath) {
    return tslib_1.__awaiter(this, void 0, void 0, function* () {
        const platform = process.platform;
        if (platform === 'win32' &&
            (yield exists(path_1.default.join(rootPath, 'node_modules', '.bin', 'tslint.cmd')))) {
            return path_1.default.join('.', 'node_modules', '.bin', 'tslint.cmd');
        }
        else if ((platform === 'linux' || platform === 'darwin') &&
            (yield exists(path_1.default.join(rootPath, 'node_modules', '.bin', 'tslint')))) {
            return path_1.default.join('.', 'node_modules', '.bin', 'tslint');
        }
        else {
            try {
                return which_1.default.sync('tslint');
            }
            catch (e) {
                return null;
            }
        }
    });
}
function createDefaultConfiguration() {
    return tslib_1.__awaiter(this, void 0, void 0, function* () {
        const folderPath = coc_nvim_1.workspace.root;
        const tslintConfigFile = path_1.default.join(folderPath, 'tslint.json');
        if (fs_1.default.existsSync(tslintConfigFile)) {
            yield coc_nvim_1.workspace.openResource(vscode_uri_1.default.file(tslintConfigFile).toString());
        }
        else {
            const tslintCmd = yield findTslint(folderPath);
            if (!tslintCmd)
                return;
            const cmd = `${tslintCmd} --init`;
            const p = child_process_1.exec(cmd, { cwd: folderPath, env: process.env });
            p.on('exit', (code, _signal) => tslib_1.__awaiter(this, void 0, void 0, function* () {
                if (code === 0) {
                    yield coc_nvim_1.workspace.openResource(vscode_uri_1.default.file(tslintConfigFile).toString());
                }
                else {
                    coc_nvim_1.workspace.showMessage('Could not run `tslint` to generate a configuration file. Please verify that you have `tslint` and `typescript` installed.', 'error');
                }
            }));
        }
    });
}
function lintProject() {
    return tslib_1.__awaiter(this, void 0, void 0, function* () {
        const folderPath = coc_nvim_1.workspace.root;
        const tslintCmd = yield findTslint(folderPath);
        const tslintConfigFile = path_1.default.join(folderPath, 'tslint.json');
        if (!tslintCmd)
            return;
        let cmd = `${tslintCmd} -c ${tslintConfigFile} -p .`;
        let res = yield coc_nvim_1.workspace.runTerminalCommand(cmd);
        if (res.success)
            return;
        let { bufnr } = res;
        yield coc_nvim_1.workspace.nvim.command(`silent! bd! ${bufnr}`);
        let lines = res.content.split('\n');
        let items = [];
        for (let line of lines) {
            let ms = line.match(errorRegex);
            if (!ms)
                continue;
            let [, type, file, lnum, col, message] = ms;
            let uri = vscode_uri_1.default.file(file).toString();
            let doc = coc_nvim_1.workspace.getDocument(uri);
            let bufnr = doc ? doc.bufnr : 0;
            let item = {
                filename: path_1.default.relative(coc_nvim_1.workspace.cwd, file),
                lnum: Number(lnum),
                col: Number(col),
                type: type.slice(0, 1).toUpperCase(),
                text: message
            };
            if (bufnr)
                item.bufnr = bufnr;
            items.push(item);
        }
        let { nvim } = coc_nvim_1.workspace;
        yield nvim.call('setqflist', [items, ' ', 'Results of tslint']);
        yield nvim.command('doautocmd User CocQuickfixChange');
    });
}
function applyTextEdits(uri, _documentVersion, edits) {
    return tslib_1.__awaiter(this, void 0, void 0, function* () {
        let document = coc_nvim_1.workspace.getDocument(uri);
        if (!document)
            return false;
        yield document.applyEdits(coc_nvim_1.workspace.nvim, edits);
        return true;
    });
}
function applyDisableRuleEdit(uri, documentVersion, edits) {
    return tslib_1.__awaiter(this, void 0, void 0, function* () {
        let document = coc_nvim_1.workspace.getDocument(uri);
        if (!document)
            return;
        if (document.version != documentVersion) {
            coc_nvim_1.workspace.showMessage(`TSLint fixes are outdated and can't be applied to the document.`, 'warning');
            return;
        }
        // prefix disable comment with same indent as line with the diagnostic
        let edit = edits[0];
        let line = document.getline(edit.range.start.line);
        let indent = yield coc_nvim_1.workspace.nvim.call('indent', [edit.range.start.line + 1]);
        let prefix = line.substr(0, indent);
        edit.newText = prefix + edit.newText;
        yield applyTextEdits(uri, documentVersion, edits);
    });
}
function showRuleDocumentation(_uri, _documentVersion, _edits, ruleId) {
    const tslintDocBaseURL = 'https://palantir.github.io/tslint/rules';
    if (!ruleId)
        return;
    coc_nvim_1.workspace.nvim.call('coc#util#open_url', tslintDocBaseURL + '/' + ruleId, true);
}
function convertAbsolute(file) {
    if (path_1.default.isAbsolute(file))
        return file;
    return path_1.default.join(coc_nvim_1.workspace.root, file);
}
//# sourceMappingURL=index.js.map