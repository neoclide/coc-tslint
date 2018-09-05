import * as tslint from 'tslint';
import * as server from 'vscode-languageserver';
export interface TSLintAutofixEdit {
    range: [server.Position, server.Position];
    text: string;
}
export declare function createVscFixForRuleFailure(problem: tslint.RuleFailure, document: server.TextDocument): TSLintAutofixEdit | undefined;
