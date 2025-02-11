import { ChildProcessWithoutNullStreams } from "child_process";
import { readFile, writeFileSync } from "fs";
import * as path from "path";
import { join } from "path";
import { workspace, window, WorkspaceConfiguration, NotebookCell } from "vscode";
import * as codebook from "../codebook";
import * as config from "../config";
import * as io from "../io";

// Cell is a class that contains the configuration settings for executing go code from Cells
export class Cell implements codebook.ExecutableCell {
    imports: string[];
    importNumber: number;
    outerScope: string;
    innerScope: string;
    containsMain: boolean;
    parsingImports: boolean;
    parsingFunc: boolean;
    funcRegex: RegExp;
    funcRecRegex: RegExp;
    executableCode: string;
    mainExecutable: codebook.Command;
    postExecutables: codebook.Executable[] = [];
    config: Config;

    constructor(notebookCell: NotebookCell) {
        this.imports = [];
        this.importNumber = 0;
        this.outerScope = "";
        this.innerScope = "";
        this.containsMain = false;
        this.parsingImports = false;
        this.parsingFunc = false;
        this.funcRegex = /func\s+(\w+)\s*\(/;
        this.funcRecRegex = /func\s+\((\w+)\)\s*\w/;
        this.executableCode = "";
        this.config = new Config(workspace.getConfiguration('codebook-md.go'), notebookCell);

        let parsingIter = 0;
        this.innerScope += `\nfmt.Println("${codebook.StartOutput}")\n`;
        const lines = notebookCell.document.getText().split("\n");
        for (let line of lines) {
            line = line.trim();
            const funcResult = line.match(this.funcRegex);
            const funcRecResult = line.match(this.funcRecRegex);
            if (funcResult) {
                if (funcResult[1] === "main") {
                    this.containsMain = true;
                    continue;
                } else {
                    this.parsingFunc = true;
                }
            }
            if (funcRecResult) {
                this.parsingFunc = true;
            }
            if (line.startsWith("type")) {
                this.parsingFunc = true;
            }

            if (line.startsWith("import (")) {
                this.parsingImports = true;
            } else if (this.parsingImports) {
                if (line === ")") {
                    this.parsingImports = false;
                } else if (line === "") {
                    continue;
                } else {
                    this.importNumber++;
                    // append line to the imports array
                    this.imports.push(line);
                }
            } else if (line.startsWith("import")) {
                this.importNumber++;
                this.imports.push(line);
            } else if (line.startsWith("// [>].exec_from:")) {
                // set the execFrom value to the line so we can use it later
                this.config.execFrom = line;
                continue;
            } else if (this.parsingFunc) {
                this.outerScope += line;
                this.outerScope += "\n";
            } else {
                this.innerScope += line;
                this.innerScope += "\n";
            }

            if (this.parsingFunc) {
                if (line[0] === "}") {
                    if (parsingIter === 1) {
                        parsingIter = 0;
                        this.parsingFunc = false;
                    } else {
                        parsingIter--;
                    }
                }
                if (line[line.length - 1] === "{") {
                    parsingIter++;
                }
            }
        }
        // Drop the closing curly brace if there was a main function
        if (this.containsMain) {
            this.innerScope = this.innerScope.trim().slice(0, -1);
            this.containsMain = false;
        }

        if (this.config.execTypeTest) {
            // if goConfig.execType is set and the value is 'test`, then create the file in the current package
            // create the execCode for the benchmark file
            let packageName = path.basename(this.config.execDir);
            if (packageName.includes("-")) {
                packageName = packageName.replace("-", "_");
            }
            this.executableCode = `package ${packageName}\n\n`;
            this.imports.push(`"testing"`);
            this.executableCode += `import (\n\t${this.imports.join("\n\t")}\n)\n\n`;
            this.innerScope += `\nfmt.Println("${codebook.EndOutput}")\n`;
            this.executableCode += `func TestExecNotebook(t *testing.T) {\nlog.SetOutput(os.Stdout)\n${this.innerScope}}\n`;
            this.executableCode += this.outerScope;
        } else {
            this.executableCode = `package main\n${this.imports}\n\nfunc main() {\nlog.SetOutput(os.Stdout)\n${this.innerScope} ${this.outerScope}\n}\n`;
        }

        // define dir and mainFile as empty strings
        if (this.config.execFrom !== "") {
            // notify in vscode with the execFrom val
            [this.config.execDir, this.config.execFile] = getDirAndExecFile(this.config.execFrom);
        }

        // set the mainExecutable to the bash script
        // this.mainExecutable = new codebook.Command('go', [this.config.execCmd, this.config.execFile], this.config.execDir);

        if (this.config.execTypeTest) {
            // if we're executing with a test, then we won't use the execFile in the command
            this.mainExecutable = new codebook.Command('go', [this.config.execCmd, ...this.config.execArgs], this.config.execDir);
        } else {
            this.mainExecutable = new codebook.Command('go', [this.config.execCmd, ...this.config.execArgs, this.config.execFile], this.config.execDir);
        }

        // add the beforeExecuteFunc to the mainExecutable
        this.mainExecutable.addBeforeExecuteFunc(() => {
            // define dir and mainFile as empty strings
            if (this.config.execFrom !== "") {
                // notify in vscode with the execFrom val
                [this.config.execDir, this.config.execFile] = getDirAndExecFile(this.config.execFrom);
                // log out a message in vscode to indicate we're using go setting
                window.showInformationMessage('found execFrom: ' + this.config.execFrom, 'executing from: ' + this.config.execFile);
            }

            console.log("execFile", this.config.execFile);
            console.log("cell contents", this.executableCode);

            // create the directory and main file
            io.writeDirAndFileSyncSafe(this.config.execDir, this.config.execFile, this.executableCode);

            // run goimports on the file
            if (this.config.useGoimports) {
                io.spawnSyncSafe('goimports', ['-w', this.config.execFile], { cwd: this.config.execDir });
            } else {
                io.spawnSyncSafe('gopls', ['imports', '-w', this.config.execFile], { cwd: this.config.execDir });
            }
        });

        // if we're executing with a test, then we'll need to prepend the generate message and the build tag to the file contents
        if (this.config.execTypeTest) {
            this.mainExecutable.addBeforeExecuteFunc(() => {
                // prepend the generate message and the build tag to the file contents
                // read the file contents from the this.config.execFile
                readFile(this.config.execFile, 'utf8', (err, data) => {
                    if (err) {
                        console.error(err);
                        return;
                    }
                    let fileContents = data;
                    fileContents = `// +build ${this.config.execTypeTestBuildTag}\n\n` + fileContents;
                    writeFileSync(this.config.execFile, fileContents);
                });
            });
        }
    }

    contentCellConfig(): codebook.CellContentConfig {
        return this.config.contentConfig;
    }

    toString(): string {
        return this.innerScope;
    }

    execute(): ChildProcessWithoutNullStreams {
        return this.mainExecutable.execute();
    }

    executables(): codebook.Executable[] {
        return [this.mainExecutable, ...this.postExecutables];
    }

    // parseImports parses the imports for the go code in the cell, returning the imports as a sclie of strings
    parseImports(): string[] {
        const imports: string[] = [];
        const lines = this.executableCode.split("\n");
        for (const line of lines) {
            if (line.startsWith("import (")) {
                this.parsingImports = true;
            } else if (this.parsingImports) {
                if (line === ")") {
                    this.parsingImports = false;
                } else if (line === "") {
                    continue;
                } else {
                    imports.push(line);
                }
            } else if (line.startsWith(`import "`)) {
                imports.push(line);
            }
        }
        return imports;
    }
}

// Config is a class that contains the configuration settings for executing go code from Cells
export class Config {
    contentConfig: codebook.CellContentConfig;
    execFrom: string;
    execTypeRun: boolean;
    execTypeRunFilename: string;
    execTypeTest: boolean;
    execTypeTestFilename: string;
    execTypeTestBuildTag: string;
    execDir: string;
    execFile: string;
    execFilename: string;
    execPkg: string;
    useGoimports: boolean;
    execCmd: string;
    execArgs: string[];

    constructor(goConfig: WorkspaceConfiguration | undefined, notebookCell: NotebookCell) {
        this.contentConfig = new codebook.CellContentConfig(notebookCell, workspace.getConfiguration('codebook-md.go.output'), "//");
        const execType = goConfig?.get<string>('execType') ?? 'run';
        this.execFrom = '';
        this.execTypeRun = execType === 'run';
        this.execTypeRunFilename = goConfig?.get<string>('execTypeRunFilename') ?? 'main.go'; // defalut value is in package.json
        this.execTypeTest = execType === 'test';
        this.execTypeTestFilename = goConfig?.get<string>('execTypeTestFilename') ?? 'codebook_md_exec_test.go'; // defalut value is in package.json
        this.execTypeTestBuildTag = goConfig?.get<string>('execTypeTestBuildTag') ?? 'playground'; // defalut value is in package.json
        this.execDir = "";
        this.execFile = "";
        this.execFilename = "";
        this.execPkg = "";
        const goimportsCmd = goConfig?.get<string>('goimportsCmd') ?? 'gopls imports';
        this.useGoimports = goimportsCmd === 'goimports';
        this.execCmd = "";
        this.execArgs = [];
        if (this.execTypeTest) {
            // if goConfig.execType is set and the value is 'test`, then create the file in the current package
            // set the execDir to the current directory
            const currentFile = window.activeTextEditor?.document.fileName;
            const currentPath = path.dirname(currentFile ?? '');
            this.execPkg = path.basename(currentPath);
            this.execDir = currentPath;
            this.execFilename = this.execTypeTestFilename;
            this.execFile = path.join(this.execDir, this.execFilename);
            this.execCmd = 'test';
            this.execArgs = ['-run=TestExecNotebook', '-tags=playground', '-v'];
        } else {
            this.execDir = config.getTempPath();
            this.execFilename = this.execTypeRunFilename;
            this.execFile = path.join(this.execDir, this.execFilename);
            this.execCmd = 'run';
        }
    }

}

// getDirAndMainFile takes the string to search (main string) and returns the directory and main file path for the go code using the 
// '// [>]exec_from:[/dir/to/main.go]' keyword in a comment in the given string using one of 2 formats:
// 1. absolute path to the directory and main.go file (/path/to/dir/main.go)
// 2. relative path to the directory and main.go file (./dir/main.go)
export const getDirAndExecFile = (execFrom: string): [string, string] => {
    // [>]exec_from:./apiplayground/main_temp.go
    // split on the colon
    const parts = execFrom.split(':');
    console.log(`getDirAndExecFile parts: ${parts} | execFrom: ${execFrom}`);
    let execFile = execFrom;
    if (parts.length > 1) {
        execFile = parts[1].trim();
    }

    // if the first part is a '.', then it is a relative path
    if (execFile.startsWith('.')) {
        const currentFile = window.activeTextEditor?.document.fileName;
        const currentPath = path.dirname(currentFile ?? '');
        execFile = join(currentPath, execFile.slice(2));
    }

    // get the directory path
    const dir = path.dirname(execFile);

    // get the main file path
    return [dir, execFile];
};

// hello is a function that runs the go code to print "Hello, Go!" and returns the output
