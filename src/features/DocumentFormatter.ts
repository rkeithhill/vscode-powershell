import vscode = require('vscode');
import { languages, TextDocument, TextEdit, FormattingOptions, CancellationToken } from 'vscode'
import { LanguageClient, RequestType, NotificationType } from 'vscode-languageclient';
import Window = vscode.window;
import { IFeature } from '../feature';
import * as Settings from '../settings';
import * as Utils from '../utils';

export namespace ScriptFileMarkersRequest {
    export const type: RequestType<any, any, void> = { get method(): string { return "powerShell/getScriptFileMarkers"; } };
}

// TODO move some of the common interface to a separate file?
interface ScriptFileMarkersRequestParams {
    filePath: string;
    settings: string;
}

interface ScriptFileMarkersRequestResultParams {
    markers: ScriptFileMarker[];
}

interface ScriptFileMarker {
    message: string;
    level: ScriptFileMarkerLevel;
    scriptRegion: ScriptRegion;
    correction: MarkerCorrection;
}

enum ScriptFileMarkerLevel {
    Information = 0,
    Warning,
    Error
}

interface ScriptRegion {
    file: string;
    text: string;
    startLineNumber: number;
    startColumnNumber: number;
    startOffset: number;
    endLineNumber: number;
    endColumnNumber: number;
    endOffset: number;
}

interface MarkerCorrection {
    name: string;
    edits: ScriptRegion[]
}

class PSDocumentFormattingEditProvider implements vscode.DocumentFormattingEditProvider {
    private languageClient: LanguageClient;

    // The order in which the rules will be executed starting from the first element.
    private readonly ruleOrder: string[] = [
        "PSPlaceCloseBrace",
        "PSPlaceOpenBrace",
        "PSUseConsistentIndentation"];

    // Allows edits to be undone and redone is a single step.
    // Should we expose this through settings?
    private aggregateUndoStop: boolean;

    constructor(aggregateUndoStop: boolean)
    {
        this.aggregateUndoStop = aggregateUndoStop;
    }

    provideDocumentFormattingEdits(
        document: TextDocument,
        options: FormattingOptions,
        token: CancellationToken): TextEdit[] | Thenable<TextEdit[]> {

        // we need to order the edits such that edit i should not invalidate
        // the edits in edit j s.t i < j (seems like a hard problem)
        // or
        // peform edits ourself and return an empty textedit array
        return this.executeRulesInOrder(document, options, 0);
    }

    executeRulesInOrder(
        document: TextDocument,
        options: FormattingOptions,
        index: number): Thenable<TextEdit[]> | TextEdit[] {
        if (this.languageClient !== null && index < this.ruleOrder.length) {
            let rule = this.ruleOrder[index];
            let uniqueMarkers: ScriptFileMarker[] = [];
            let markers: ScriptFileMarker[];
            return this.languageClient.sendRequest(
                ScriptFileMarkersRequest.type,
                {
                    filePath: document.fileName,
                    settings: this.getSettings(rule)
                })
                .then((result: ScriptFileMarkersRequestResultParams) => {
                    markers = result.markers;

                    // sort in decending order of the edits
                    markers.sort(function (a: ScriptFileMarker, b: ScriptFileMarker): number {
                        let leftOperand: number = a.correction.edits[0].startLineNumber,
                            rightOperand: number = b.correction.edits[0].startLineNumber;
                        if (leftOperand < rightOperand) {
                            return 1;
                        } else if (leftOperand > rightOperand) {
                            return -1;
                        } else {
                            return 0;
                        }
                    });

                    // We cannot handle multiple edits on the same line hence we
                    // filter the markers so that there is only one edit per line
                    if (markers.length > 0) {
                        uniqueMarkers.push(markers[0]);
                        for (let marker of markers.slice(1)) {
                            if (marker.correction.edits[0].startLineNumber
                                !== uniqueMarkers[uniqueMarkers.length - 1].correction.edits[0].startLineNumber) {
                                uniqueMarkers.push(marker);
                            }
                        }
                    }

                    // we do not return a valid array because our text edits
                    // need to be executed in a particular order and it is
                    // easier if we perform the edits ourselves
                    return this.applyEdit(uniqueMarkers, 0, index);
                })
                .then(() => {

                    // execute the same rule again if we left out violations
                    // on the same line
                    if (uniqueMarkers.length !== markers.length) {
                        return this.executeRulesInOrder(document, options, index);
                    }
                    return this.executeRulesInOrder(document, options, index + 1);
                });
        } else {
            return TextEdit[0];
        }
    }

    applyEdit(markers: ScriptFileMarker[], markerIndex: number, ruleIndex: number): Thenable<void> {
        if (markerIndex >= markers.length) {
            return;
        }

        let undoStopAfter = !this.aggregateUndoStop || (ruleIndex === this.ruleOrder.length - 1 && markerIndex === markers.length - 1);
        let undoStopBefore = !this.aggregateUndoStop || (ruleIndex === 0 && markerIndex === 0);
        let edit: ScriptRegion = markers[markerIndex].correction.edits[0];
        return Window.activeTextEditor.edit((editBuilder) => {
            editBuilder.replace(
                new vscode.Range(
                    edit.startLineNumber - 1,
                    edit.startColumnNumber - 1,
                    edit.endLineNumber - 1,
                    edit.endColumnNumber - 1),
                edit.text);
        },
        {
            undoStopAfter: undoStopAfter,
            undoStopBefore: undoStopBefore
        }).then((isEditApplied) => {
            return this.applyEdit(markers, markerIndex + 1, ruleIndex);
        }); // TODO handle rejection
    }

    setLanguageClient(languageClient: LanguageClient): void {
        this.languageClient = languageClient;
    }

    getSettings(rule: string): string {
        let settings: Settings.ISettings = Settings.load(Utils.PowerShellLanguageId);
        let ruleProperty: string;
        switch (rule) {
            case "PSPlaceOpenBrace":
                ruleProperty = `${rule} = @{
                    Enable = \$true
                    OnSameLine = \$${settings.codeformatting.openBraceOnSameLine}
                    NewLineAfter = \$${settings.codeformatting.newLineAfterOpenBrace}
                }`;
                break;

            case "PSUseConsistentIndentation":
                ruleProperty = `${rule} = @{
                    Enable = \$true
                    IndentationSize = ${settings.codeformatting.indentationSize}
                }`;
                break;

            default:
                ruleProperty = `${rule} = @{
                    Enable = \$true
                }`;
                break;
        }

        return `@{
    IncludeRules = @('${rule}')
    Rules = @{
                ${ruleProperty}
    }
}`;
    }
}

export class DocumentFormatterFeature implements IFeature {
    private disposable: vscode.Disposable;
    private languageClient: LanguageClient;
    private documentFormattingEditProvider: PSDocumentFormattingEditProvider;

    constructor() {
        this.documentFormattingEditProvider = new PSDocumentFormattingEditProvider(true);
        this.disposable = vscode.languages.registerDocumentFormattingEditProvider(
            "powershell",
            this.documentFormattingEditProvider);
    }

    public setLanguageClient(languageclient: LanguageClient): void {
        this.languageClient = languageclient;
        this.documentFormattingEditProvider.setLanguageClient(languageclient);
    }

    public dispose(): any {
        this.disposable.dispose();
    }
}