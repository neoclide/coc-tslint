import tslint from 'tslint';
import { TSLintAutofixEdit } from './fixer';
export interface AutoFix {
    label: string;
    documentVersion: number;
    problem: tslint.RuleFailure;
    edits: TSLintAutofixEdit[];
}
export declare function overlaps(lastFix: AutoFix | undefined, nextFix: AutoFix): boolean;
export declare function getAllNonOverlappingFixes(fixes: AutoFix[]): [AutoFix[], boolean];
