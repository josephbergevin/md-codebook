/* eslint-disable @typescript-eslint/naming-convention */
import { NotebookDocument, NotebookCell, NotebookController, NotebookCellOutput, NotebookCellOutputItem, NotebookRange, NotebookEdit, WorkspaceEdit, workspace } from 'vscode';
import { ChildProcessWithoutNullStreams, spawnSync } from 'child_process';
import * as md from "./md";
import * as go from "./languages/go";
import * as bash from "./languages/bash";
import * as vscode from 'vscode';
import * as util from "./exec";

// Kernel in this case matches Jupyter definition i.e. this is responsible for taking the frontend notebook
// and running it through different languages, then returning results in the same format.
export class Kernel {
    async executeCells(doc: NotebookDocument, cells: NotebookCell[], ctrl: NotebookController): Promise<void> {
        console.log(`kernel.executeCells called with ${cells.length} cells`);
        for (const cell of cells) {
            await this.executeCell(doc, [cell], ctrl);
        }
    }

    async executeCell(doc: NotebookDocument, cells: NotebookCell[], ctrl: NotebookController): Promise<void> {
        switch (cells.length) {
            case 0:
                return;

            case 1:
                // continue below
                break;

            default:
                console.error(`executeCell called with ${cells.length} cells - only 1 cell is supported at a time.`);
                return;
        }

        const notebookCell = cells[0];
        let decoder = new TextDecoder;
        let exec = ctrl.createNotebookCellExecution(notebookCell);

        // Allow for the ability to cancel execution
        let token = exec.token;
        token.onCancellationRequested(() => {
            exec.end(false, (new Date).getTime());
        });

        // start the cell timer counter
        exec.start((new Date).getTime());

        // clear the output of the cell
        exec.clearOutput(notebookCell);

        // convert the notebookCell to an md.Cell
        const cell = new md.Cell(notebookCell);

        // Run the code
        let output: ChildProcessWithoutNullStreams;

        // Now there's an output stream, kill that as well on cancel request
        token.onCancellationRequested(() => {
            output.kill();
            exec.end(false, (new Date).getTime());
        });

        // Get language that was used to run this cell
        const lang = notebookCell.document.languageId;
        const mimeType = `text/plain`;
        switch (lang) {
            case "go":
                if (util.commandNotOnPath("go", "https://go.dev/doc/install")) {
                    exec.end(false, (new Date).getTime());
                    return;
                }
                output = go.executeCell(cell);
                break;

            case "shell":
            case "zsh":
            case "sh":
            case "shellscript":
            case "shell-script":
            case "bash":
                if (util.commandNotOnPath("bash", "https://www.gnu.org/software/bash/")) {
                    exec.end(false, (new Date).getTime());
                    return;
                }
                output = bash.executeCell(cell);
                break;

            default:
                exec.end(true, (new Date).getTime());
                return;
        }

        let errorText = "";

        output.stderr.on("data", async (data: Uint8Array) => {
            errorText = data.toString();
            if (errorText === "") {
                errorText = "An error occurred - no error text was returned.";
                console.error("error text is empty");
            }
            exec.appendOutput([new NotebookCellOutput([NotebookCellOutputItem.text(errorText, mimeType)])]);
            exec.end(true, (new Date).getTime());
        });

        let buf = Buffer.from([]);

        output.stdout.on('data', (data: Uint8Array) => {
            console.log(`stdout: ${data}`);
            let arr = [buf, data];
            buf = Buffer.concat(arr);
            // get the entire output of the cell
            const fullOutput = decoder.decode(buf);
            // if the output contains the output start cell string /!!output-start-cell[\n,""," "]/g, only show the output after that
            const outputStartCell = "!!output-start-cell";
            const outputStartCellIndex = fullOutput.indexOf(outputStartCell);
            const displayOutput = fullOutput.substring(outputStartCellIndex + outputStartCell.length);

            // log out if the displayOutput is different from the fullOutput
            if (displayOutput !== fullOutput) {
                console.log(`displayOutput: ${displayOutput} | fullOutput: ${fullOutput}`);
            }

            exec.replaceOutput([new NotebookCellOutput([NotebookCellOutputItem.text(displayOutput)])]);
        });

        output.on('close', (_) => {
            // If stdout returned anything consider it a success
            if (buf.length === 0) {
                exec.end(false, (new Date).getTime());
            } else {
                exec.end(true, (new Date).getTime());
            }

            // Loop through all the cells and increment version of image if it exists

            if (doc.getCells().length >= (cells[0].index + 1)) {
                let cell = doc.getCells(new NotebookRange(cells[0].index + 1, cells[0].index + 2))[0];
                if (cell.kind === vscode.NotebookCellKind.Markup) {
                    let text = cell.document.getText();
                    text.replace(/(.*[^`]*<img\s*src\s*=\s*".*?)(\?version=(\d+))?"(.*)/g, (match, prefix, versionQuery, versionNum, suffix) => {
                        if (match) {
                            let replaceText = "";
                            if (versionQuery) {
                                //   If ?version= is present, increment the version number
                                let newVersionNum = parseInt(versionNum, 10) + 1;
                                replaceText = `${prefix}?version=${newVersionNum}"${suffix}`;
                            } else {
                                //   If ?version= is not present, add ?version=1
                                replaceText = `${prefix}?version=1"${suffix}`;
                            }
                            let workspaceEdit = new vscode.WorkspaceEdit();
                            let fullRange = new vscode.Range(
                                0,
                                0,
                                cell.document.lineCount - 1,
                                cell.document.lineAt(cell.document.lineCount - 1).text.length
                            );
                            workspaceEdit.replace(cell.document.uri, fullRange, replaceText);
                            vscode.workspace.applyEdit(workspaceEdit);
                            vscode.window.showNotebookDocument(vscode.window.activeNotebookEditor?.notebook as NotebookDocument, {
                                viewColumn: vscode.window.activeNotebookEditor?.viewColumn,
                                selections: [new NotebookRange(cell.index, cell.index + 1)],
                                preserveFocus: true,
                            }).then(() => {
                                // Execute commands to toggle cell edit mode and then toggle it back to preview.
                                vscode.commands.executeCommand('notebook.cell.edit').then(() => {
                                    vscode.commands.executeCommand('notebook.cell.quitEdit').then(() => {
                                        // Optionally, add any additional logic that needs to run after the refresh.
                                    });
                                });
                            });
                            vscode.window.showNotebookDocument(vscode.window.activeNotebookEditor?.notebook as NotebookDocument, {
                                viewColumn: vscode.window.activeNotebookEditor?.viewColumn,
                                selections: [new NotebookRange(cell.index - 1, cell.index)],
                                preserveFocus: false,
                            });
                        }

                        return "";
                    });
                }
            }
        });
    }
}
