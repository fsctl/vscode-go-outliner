import cp = require('child_process');
import * as vscode from 'vscode';
import { Symbol, ItemType } from './symbol';
import { dirname } from 'path';
import { Provider, ProviderType } from './provider';
import path = require('path');
import { fileExists } from './util';

enum TerminalName {
    Testing = "Go Outliner: Test",
    Benchmark = "Go Outliner: Benchmarks",
    Channel = "Go Outliner: Debug"
}

export class Terminal {
    private _terminalTesting: any;
    private _terminalBenchmarks: any;
    private _terminalChannel: any = undefined;
    private _disposable: vscode.Disposable;
    private _enableDebugChannel: boolean = false;

    constructor() {
        this._enableDebugChannel = vscode.workspace.getConfiguration('goOutliner').get('enableDebugChannel', false);
        //TODO: Add to disposable
        vscode.workspace.onDidChangeConfiguration(() => {
            this._enableDebugChannel = vscode.workspace.getConfiguration('goOutliner').get('excludeTestFiles', true);
            this.toggleChannel()
        });
        this.toggleChannel();

        this._disposable = vscode.window.onDidCloseTerminal(x => {
            switch (x.name) {
                case TerminalName.Testing:
                    this._terminalTesting = undefined;
                    break;
                case TerminalName.Benchmark:
                    this._terminalBenchmarks = undefined;
                    break;
            }
        });
    }

    private toggleChannel() {
        if(this._enableDebugChannel && !this._terminalChannel) {
            this._terminalChannel = vscode.window.createOutputChannel(TerminalName.Channel);
            return;
        }

        if(!this._enableDebugChannel && this._terminalChannel) {
            this.TerminalChannel.dispose();
        }
    }

    get TerminalChannel(): vscode.OutputChannel {
        return this._terminalChannel;
    }

    get TerminalTesting(): vscode.Terminal {
        if (!this._terminalTesting) {
            this._terminalTesting = vscode.window.createTerminal(TerminalName.Testing);
        }
        return this._terminalTesting;
    }

    get TerminalBenchmarks(): vscode.Terminal {
        if (!this._terminalBenchmarks) {
            this._terminalBenchmarks = vscode.window.createTerminal(TerminalName.Benchmark);
        }
        return this._terminalBenchmarks;
    }

    public TestFunc(name?: string) {
        let opt = (name) ? ` -run ^${name}$` : '';
        this.TerminalTesting.show();
        this.TerminalTesting.sendText(`go test${opt}`);
    }

    public BenchmarkFunc(name?: string) {
        let opt = (name) ? `^${name}$` : '.';
        this.TerminalBenchmarks.show();
        this.TerminalBenchmarks.sendText(`go test -bench ${opt}`);
    }

    public Channel(msg: string) {
        if (!this._enableDebugChannel) {
            return;
        }
        this.TerminalChannel.appendLine(msg);
    }

    public ChannelWithInformationMessage(msg: string) {
        vscode.window.showInformationMessage(msg);
        this.Channel(msg);
    }

    public dispose() {
        this._terminalTesting.dispose();
        this._terminalBenchmarks.dispose();
        if (this._terminalChannel) { this._terminalChannel.dispose(); }
        this._disposable.dispose();
    }
}

export class AppExec {
    private _onDidChangeSymbols: vscode.EventEmitter<Symbol | undefined> = new vscode.EventEmitter<Symbol | undefined>();
    readonly onDidChangeSymbols: vscode.Event<Symbol | undefined> = this._onDidChangeSymbols.event;

    public symbols: Symbol[] = Array<Symbol>();
    public binPathCache: Map<string, string> = new Map();

    private excludeTestFiles: boolean = true;

    constructor(private workspaceRoot: string, private terminal: Terminal) {
        this.excludeTestFiles = vscode.workspace.getConfiguration('goOutliner').get('excludeTestFiles', true);
        vscode.workspace.onDidChangeConfiguration(() => {
            this.excludeTestFiles = vscode.workspace.getConfiguration('goOutliner').get('excludeTestFiles', true);
            this._onDidChangeSymbols.fire();
        });
        this.checkMissingTools();
        this.getOutlineForWorkspace();
    }

    public Reload(filepath?: string) {
        if (filepath) {
            let path = dirname(filepath);
            if (this.workspaceRoot !== path) {
                this.workspaceRoot = path;
                this.symbols = Array<Symbol>();
                this.getOutlineForWorkspace();
            }
        } else {
            this.getOutlineForWorkspace();
        }
    }

    private getOutlineForWorkspace(): any {
        let bin = this.findToolFromPath("go-outliner");
        if (!bin) {
            return;
        }
        cp.execFile(bin, [`${this.workspaceRoot}`], {}, (err, stdout, stderr) => {
            this.symbols = JSON.parse(stdout).map(Symbol.fromObject);
            this.symbols.sort((a, b) => a.label.localeCompare(b.label));
            this.terminal.Channel(`Reading directory: ${this.workspaceRoot}; Results: ${this.symbols.length}`);
            this._onDidChangeSymbols.fire();
        });
    }

    public MainProvider(): Provider {
        return new Provider(this.symbols.filter(x => !x.isTestFile), ProviderType.Main);
    }

    public TestsProvider(): Provider {
        return new Provider(this.symbols.filter(x => x.isTestFile && x.type === ItemType.Func && x.label.startsWith("Test")), ProviderType.Tests);
    }

    public BenchmarksProvider(): Provider {
        return new Provider(this.symbols.filter(x => x.isTestFile && x.type === ItemType.Func && x.label.startsWith("Benchmark")), ProviderType.Benchmarks);
    }

    private checkMissingTools() {
        let tools: string[] = ["go-outliner"];
        tools.forEach(tool => {
            let toolPath: string = this.findToolFromPath(tool);
            if (toolPath === "") {
                this.terminal.Channel(`Missing: ${tool}`);
                vscode.window.showInformationMessage(`Go Outliner: Missing: ${tool}`, "Install").then(x => {
                    if (x === "Install") {
                        this.installTool(tool);
                    }
                });
            }
        });
    }

    private installTool(name: string) {
        let bin: string = this.findToolFromPath("go");
        if (bin === "") {
            this.terminal.Channel("Could not find Go binary");
            vscode.window.showErrorMessage("Go Outliner: Could not find Go binary");
            return;
        }
        let args: string[] = [];
        switch (name) {
            case "go-outliner":
                args = ["get", "-u", "github.com/766b/go-outliner"];
                break;
            default:
                this.terminal.Channel("Trying to install unknown tool: " + name);
                return;
        }

        cp.execFile(bin, args, {}, (err, stdout, stderr) => {
            this.terminal.Channel(`Executing ${bin} ${args.join(" ")}`);
            if (err || stderr) {
                this.terminal.Channel(`Error: ${stderr}\n${err}`);
                return;
            }
            this.terminal.Channel(`OK: ${stdout}`);
        });
    }

    private findToolFromPath(tool: string): string {
        let cachedPath: any = this.binPathCache.get(tool);
        if (cachedPath) {
            return cachedPath;
        }

        let toolFileName = (process.platform === 'win32') ? `${tool}.exe` : tool;
        let pathEnv = process.env['PATH'] || (process.platform === 'win32' ? process.env['Path'] : null);
        let goPathEnv = process.env['GOPATH'];
        let macHomeEnv = process.env['HOME'];

        let paths: string[] = [];
        if (pathEnv !== undefined) {
            paths.push(...pathEnv.split(path.delimiter));
        }
        if (goPathEnv !== undefined) {
            paths.push(...goPathEnv.split(path.delimiter));
        }
        if (macHomeEnv !== undefined) {
            paths.push(path.join(macHomeEnv, "go"));
        }

        for (let i = 0; i < paths.length; i++) {
            let dirs = paths[i].split(path.sep);
            let appendBin = dirs[dirs.length - 1].toLowerCase() !== "bin";
            let filePath = path.join(paths[i], appendBin ? 'bin' : '', toolFileName);
            if (fileExists(filePath)) {
                this.terminal.Channel(`Found "${tool}" at ${filePath}`);
                this.binPathCache.set(tool, filePath);
                return filePath;
            }
        }
        this.terminal.Channel(`Could not find "${tool}"`);
        return "";
    }

    public dispose() {
        this._onDidChangeSymbols.dispose();
    }
}