import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { parse as tomlParse } from '@ltd/j-toml';
import { tomlKeyOf } from './tomlkeys';

/** Strip ANSI SGR escape sequences (colors, bold) from celer output. */
const ANSI_SGR_PATTERN = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
    return text.replace(ANSI_SGR_PATTERN, '');
}

/**
 * celer's own error block, without the extension's transport prefix, ready for the
 * Output panel. Line breaks and the `[✘]` / `[☛]` / `└─` layout are preserved.
 */
function formatCelerError(error: unknown): string {
    const text = stripAnsi(error instanceof Error ? error.message : String(error));
    const lines = text.split(/\r?\n/)
        .filter(line => !line.trimStart().startsWith('Celer command failed'))
        .map(line => line.trimEnd());
    while (lines.length > 0 && !lines[0]) { lines.shift(); }
    while (lines.length > 0 && !lines[lines.length - 1]) { lines.pop(); }
    return lines.join('\n') || 'unknown error';
}

export interface CelerConfig {
    platforms?: string[];
    projects?: string[];
    currentPlatform?: string;
    currentProject?: string;
    currentBuildType?: string;
    jobs?: number;
}

/** Outcome of {@link Celer.selectProject}. */
export interface SelectProjectResult {
    /** The project's target_platform, when it defines one (applied or already current). */
    platform?: string;
    /** A step after the project was applied failed; details are in the Celer output. */
    warning?: boolean;
}

export class Celer {
    /** Command output and failures (the "Celer" output panel). */
    private outputChannel: vscode.OutputChannel;
    /** Extension diagnostics (the "Celer Logs" output panel). */
    private logChannel: vscode.OutputChannel;
    private celerPath: string;
    /** Cached short version string, e.g. "v0.0.9". */
    private celerVersion?: string;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Celer');
        this.logChannel = vscode.window.createOutputChannel('Celer Logs');
        this.celerPath = this.getCelerExecutable();
    }

    private getCelerExecutable(): string {
        const config = vscode.workspace.getConfiguration('celer');
        let executable = config.get<string>('executable', 'celer');
        
        // On Windows, check if celer.exe exists in workspace root
        if (process.platform === 'win32' && executable === 'celer') {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (workspaceFolder) {
                const localCeler = path.join(workspaceFolder, 'celer.exe');
                if (fs.existsSync(localCeler)) {
                    this.logChannel.appendLine(`[INFO] Using local celer.exe: ${localCeler}`);
                    return localCeler;
                }
            }
            
            // Add .exe extension if not present
            executable = 'celer.exe';
        }
        
        return executable;
    }

    public showOutput() {
        this.outputChannel.show();
    }

    public getLogChannel(): vscode.OutputChannel {
        return this.logChannel;
    }

    /**
     * Report a failed command in the Output panel, keeping celer's own multi-line
     * layout ([✘] / [☛] / └─), and reveal the panel. Failures are not shown as
     * dialog boxes; successful operations are reported on the status bar instead.
     */
    public reportFailure(context: string, error: unknown): void {
        // Each failure should be readable on its own; don't stack old output.
        this.outputChannel.clear();
        this.outputChannel.appendLine(context);
        this.outputChannel.appendLine(formatCelerError(error));
        this.outputChannel.show(true);
    }

    /** Check if celer executable can be found */
    public isAvailable(): boolean {
        // Local file in workspace
        if (path.isAbsolute(this.celerPath) && fs.existsSync(this.celerPath)) {
            return true;
        }
        // In PATH
        try {
            const checkCmd = process.platform === 'win32' ? `where ${this.celerPath}` : `which ${this.celerPath}`;
            cp.execSync(checkCmd, { stdio: 'ignore' });
            return true;
        } catch {
            return false;
        }
    }

    /** Show error and offer to install if celer is not available. Returns true if available. */
    public async ensureAvailable(): Promise<boolean> {
        if (this.isAvailable()) { return true; }
        const action = await vscode.window.showErrorMessage(
            'Celer executable not found. Please install celer first, or download it from GitHub.',
            'Download', 'Cancel'
        );
        if (action === 'Download') {
            vscode.commands.executeCommand('celer.installCelerExecutable');
        }
        return false;
    }

    /**
     * Version of the installed celer CLI (e.g. "v0.0.9"), or undefined when celer is
     * unavailable. Uses `celer version -s`; older builds without that flag fall back to
     * parsing the version out of the full banner. A successful result is cached.
     */
    public async getCelerVersion(): Promise<string | undefined> {
        if (this.celerVersion) { return this.celerVersion; }
        // Check availability first: runCommand() would pop an install dialog otherwise.
        if (!this.isAvailable()) {
            this.logChannel.appendLine('[WARN] getCelerVersion: celer executable not found, version will not be shown');
            return undefined;
        }

        let raw: string | undefined;
        try {
            raw = await this.runCommand(['version', '-s']);
        } catch {
            try {
                const banner = await this.runCommand(['version']);
                const match = banner.match(/\bv(\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)/i);
                raw = match ? `v${match[1]}` : banner.split(/\r?\n/).map(line => line.trim()).find(Boolean);
            } catch (error) {
                this.logChannel.appendLine(`[WARN] getCelerVersion failed: ${error instanceof Error ? error.message : error}`);
                return undefined;
            }
        }

        const version = (raw || '').split(/\r?\n/).map(line => line.trim()).find(Boolean);
        if (!version) {
            this.logChannel.appendLine('[WARN] getCelerVersion: could not parse the version output');
            return undefined;
        }
        this.celerVersion = /^\d/.test(version) ? `v${version}` : version;
        return this.celerVersion;
    }

    public async runCommandInTerminal(args: string[]): Promise<void> {
        if (!await this.ensureAvailable()) { return; }
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!cwd) {
            throw new Error('No workspace folder found');
        }

        // Create or reuse terminal
        const terminalName = 'Celer';
        let terminal = vscode.window.terminals.find(t => t.name === terminalName);
        
        if (!terminal) {
            terminal = vscode.window.createTerminal({
                name: terminalName,
                cwd: cwd
            });
        }

        // Show the terminal
        terminal.show(true);

        // Ensure the terminal is in the workspace root — celer resolves the
        // workspace directory from the current working directory, so a stale
        // cwd in a reused terminal could create files in the wrong place.
        terminal.sendText(`cd "${cwd}"`);

        // Build the command - use relative path if it's a local executable
        let cmdExecutable = this.celerPath;
        if (path.isAbsolute(cmdExecutable)) {
            // If it's an absolute path in the workspace, use relative path
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (workspaceFolder && cmdExecutable.startsWith(workspaceFolder)) {
                cmdExecutable = './' + path.relative(workspaceFolder, cmdExecutable);
            }
        }
        
        const command = `${cmdExecutable} ${args.join(' ')}`;
        
        // Log to output channel as well
        this.logChannel.appendLine(`Running in terminal: ${command}`);
        
        // Send command to terminal
        terminal.sendText(command);

        // Wait for command to execute
        // Configure commands need time to write the file
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    public async runCommand(args: string[], workspaceFolder?: string): Promise<string> {
        if (!await this.ensureAvailable()) { throw new Error('Celer executable not found'); }

        return new Promise((resolve, reject) => {
            const cwd = workspaceFolder || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            
            if (!cwd) {
                reject(new Error('No workspace folder found'));
                return;
            }

            const command = `"${this.celerPath}" ${args.join(' ')}`;
            this.logChannel.appendLine(`Running: ${command}`);

            // Pass arguments as an array (no shell): workspace-derived values must
            // never be interpreted as shell syntax or split on spaces.
            const process = cp.spawn(this.celerPath, args, { cwd });

            let stdout = '';
            let stderr = '';

            process.stdout?.on('data', (data) => {
                const output = data.toString();
                stdout += output;
                this.outputChannel.append(output);
            });

            process.stderr?.on('data', (data) => {
                // stderr is celer's error channel. Keep it for the rejection message and
                // log it for diagnostics; reportFailure() prints the clean block once.
                const output = data.toString();
                stderr += output;
                this.logChannel.append(stripAnsi(output));
            });

            process.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout);
                } else {
                    // Some failures print their diagnostics to stdout and leave stderr
                    // empty; fall back so the error is not reduced to "unknown error".
                    const details = stripAnsi(stderr.trim() ? stderr : stdout);
                    reject(new Error(`Celer command failed with code ${code}:\n${details}`));
                }
            });

            process.on('error', (err) => {
                reject(err);
            });
        });
    }

    async hasCelerProject(): Promise<boolean> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return false;
        }

        try {
            const celerToml = await vscode.workspace.findFiles('**/celer.toml', null, 1);
            return celerToml.length > 0;
        } catch {
            return false;
        }
    }

    async getCelerTomlPath(): Promise<string | undefined> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            this.logChannel.appendLine('[DEBUG] getCelerTomlPath: no workspace folder');
            return undefined;
        }

        const rootPath = workspaceFolder.uri.fsPath;
        this.logChannel.appendLine(`[DEBUG] getCelerTomlPath: workspace root = ${rootPath}`);

        // Check for celer.toml in workspace root only
        const celerTomlPath = path.join(rootPath, 'celer.toml');
        this.logChannel.appendLine(`[DEBUG] getCelerTomlPath: checking ${celerTomlPath}, exists=${fs.existsSync(celerTomlPath)}`);
        if (fs.existsSync(celerTomlPath)) {
            return celerTomlPath;
        }

        // Check for Celer.toml (capitalized) in workspace root only
        const celerTomlUpperPath = path.join(rootPath, 'Celer.toml');
        this.logChannel.appendLine(`[DEBUG] getCelerTomlPath: checking ${celerTomlUpperPath}, exists=${fs.existsSync(celerTomlUpperPath)}`);
        if (fs.existsSync(celerTomlUpperPath)) {
            return celerTomlUpperPath;
        }

        // Fallback: use findFiles (same as hasCelerProject)
        this.logChannel.appendLine('[DEBUG] getCelerTomlPath: root check failed, trying findFiles');
        const files = await vscode.workspace.findFiles('**/{celer,Celer}.toml', null, 1);
        if (files.length > 0) {
            this.logChannel.appendLine(`[DEBUG] getCelerTomlPath: found via findFiles = ${files[0].fsPath}`);
            return files[0].fsPath;
        }

        this.logChannel.appendLine('[DEBUG] getCelerTomlPath: celer.toml not found');
        return undefined;
    }

    /** Read the raw parsed celer.toml (for configure command to read current values) */
    async readFullToml(): Promise<any> {
        const tomlPath = await this.getCelerTomlPath();
        if (!tomlPath) { return {}; }
        try {
            const content = fs.readFileSync(tomlPath, 'utf-8');
            return tomlParse(content) as any;
        } catch {
            return {};
        }
    }

    async readCelerConfig(): Promise<CelerConfig> {
        const tomlPath = await this.getCelerTomlPath();
        if (!tomlPath) {
            return {};
        }

        try {
            const content = fs.readFileSync(tomlPath, 'utf-8');
            const parsed = tomlParse(content) as any;

            // Log parsed keys for debugging (avoid serializing BigInt values)
            this.logChannel.appendLine(`[DEBUG] Parsed celer.toml keys: ${JSON.stringify(Object.keys(parsed))}`);

            // Try multiple possible section names (celer may have changed the TOML structure)
            const section = parsed.main || parsed.global || parsed.workspace || parsed.build || parsed.settings || parsed;

            const config: CelerConfig = {
                platforms: Array.isArray(section.platforms) ? section.platforms : [],
                projects: Array.isArray(section.projects) ? section.projects : [],
                currentPlatform: section.platform,
                currentProject: section.project,
                currentBuildType: section.build_type,
                jobs: section.jobs ? parseInt(section.jobs) : undefined
            };

            this.logChannel.appendLine(`[DEBUG] Read config: platform=${config.currentPlatform}, project=${config.currentProject}, buildType=${config.currentBuildType}, jobs=${config.jobs}`);

            return config;
        } catch (error) {
            this.logChannel.appendLine(`[ERROR] Failed to parse celer.toml: ${error}`);
            return {};
        }
    }

    async writeCelerConfig(config: Partial<CelerConfig>): Promise<void> {
        try {
            // Use celer configure command and wait for completion
            if (config.currentPlatform !== undefined) {
                this.logChannel.appendLine(`[INFO] Setting platform to: ${config.currentPlatform}`);
                await this.runCommand(['configure', `--platform=${config.currentPlatform}`]);
                vscode.window.setStatusBarMessage(`${tomlKeyOf('platform')} -> ${config.currentPlatform}`, 4000);
            }

            if (config.currentProject !== undefined) {
                this.logChannel.appendLine(`[INFO] Setting project to: ${config.currentProject}`);
                await this.runCommand(['configure', `--project=${config.currentProject}`]);
                vscode.window.setStatusBarMessage(`${tomlKeyOf('project')} -> ${config.currentProject}`, 4000);
            }

            if (config.currentBuildType !== undefined) {
                this.logChannel.appendLine(`[INFO] Setting build type to: ${config.currentBuildType}`);
                await this.runCommand(['configure', `--build-type=${config.currentBuildType}`]);
                vscode.window.setStatusBarMessage(`${tomlKeyOf('build-type')} -> ${config.currentBuildType}`, 4000);
            }

            // Wait a bit for file system to sync
            await new Promise(resolve => setTimeout(resolve, 300));
        } catch (error) {
            this.reportFailure('Failed to configure Celer', error);
            throw error;
        }
    }

    async getAvailablePlatforms(): Promise<string[]> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return [];
        }

        const confPlatformsPath = path.join(workspaceFolder.uri.fsPath, 'conf', 'platforms');
        if (!fs.existsSync(confPlatformsPath)) {
            this.logChannel.appendLine(`[INFO] conf/platforms directory not found: ${confPlatformsPath}`);
            return [];
        }

        try {
            const files = fs.readdirSync(confPlatformsPath);
            const tomlFiles = files
                .filter(file => file.endsWith('.toml'))
                .map(file => file.replace('.toml', ''));
            
            this.logChannel.appendLine(`[INFO] Found ${tomlFiles.length} platforms: ${tomlFiles.join(', ')}`);
            return tomlFiles;
        } catch (error) {
            this.logChannel.appendLine(`[ERROR] Failed to read platforms: ${error}`);
            return [];
        }
    }

    /** Read a project's `target_platform` from conf/projects/<name>.toml */
    private async getProjectTargetPlatform(projectName: string): Promise<string | undefined> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return undefined; }
        // Project names come from a directory listing; refuse anything that could
        // escape conf/projects when this method is called with external arguments.
        if (!projectName || path.basename(projectName) !== projectName) { return undefined; }

        const projectPath = path.join(workspaceFolder.uri.fsPath, 'conf', 'projects', `${projectName}.toml`);
        try {
            const parsed = tomlParse(await fs.promises.readFile(projectPath, 'utf-8')) as any;
            const target = parsed?.target_platform;
            return typeof target === 'string' && target.trim() ? target.trim() : undefined;
        } catch (error) {
            this.logChannel.appendLine(
                `[WARN] Failed to read target_platform of project '${projectName}': ${error}`
            );
            return undefined;
        }
    }

    /**
     * Select a project. Recent celer builds apply the project's `target_platform`
     * as the current platform while running `configure --project`; older builds
     * ignore it, so apply the platform explicitly when it did not take effect.
     *
     * celer saves `main.project` (and the target platform) before later steps such
     * as pinning the ports repo, so a non-zero exit does not always mean the project
     * was not applied. A failure after that point is reported as a warning instead
     * of an error; only a selection that did not land in celer.toml throws.
     */
    async selectProject(projectName: string): Promise<SelectProjectResult> {
        let projectError: unknown;
        let warning = false;

        try {
            await this.runCommand(['configure', `--project=${projectName}`]);
        } catch (error) {
            projectError = error;
        }

        const [targetPlatform, config] = await Promise.all([
            this.getProjectTargetPlatform(projectName),
            this.readCelerConfig(),
        ]);

        if (projectError !== undefined) {
            // celer may have saved main.project before failing on a later step (e.g.
            // pinning the ports repo), so a non-zero exit alone is not conclusive.
            // Pre-spawn errors (no executable/workspace) still mean nothing ran.
            const celerRan = projectError instanceof Error
                && projectError.message.startsWith('Celer command failed');
            if (!celerRan || config.currentProject !== projectName) { throw projectError; }
            warning = true;
            this.reportFailure(`Project '${projectName}' was selected, but a later step failed`, projectError);
        }

        if (!targetPlatform) { return { warning }; }
        if (config.currentPlatform === targetPlatform) { return { platform: targetPlatform, warning }; }

        this.logChannel.appendLine(
            `[INFO] Project '${projectName}' did not apply its target_platform, configuring it explicitly: ${targetPlatform}`
        );
        try {
            await this.runCommand(['configure', `--platform=${targetPlatform}`]);
        } catch (error) {
            // The platform may have been saved even though the command exited
            // non-zero; only report it when celer.toml really did not take it.
            const after = await this.readCelerConfig();
            if (after.currentPlatform === targetPlatform) { return { platform: targetPlatform, warning }; }
            warning = true;
            this.reportFailure(
                `Project '${projectName}' was selected, but target_platform '${targetPlatform}' could not be applied`,
                error
            );
            return { warning };
        }
        return { platform: targetPlatform, warning };
    }

    async getAvailableProjects(): Promise<string[]> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return [];
        }

        const confProjectsPath = path.join(workspaceFolder.uri.fsPath, 'conf', 'projects');
        if (!fs.existsSync(confProjectsPath)) {
            this.logChannel.appendLine(`[INFO] conf/projects directory not found: ${confProjectsPath}`);
            return [];
        }

        try {
            const files = fs.readdirSync(confProjectsPath);
            const tomlFiles = files
                .filter(file => file.endsWith('.toml'))
                .map(file => file.replace('.toml', ''));
            
            this.logChannel.appendLine(`[INFO] Found ${tomlFiles.length} projects: ${tomlFiles.join(', ')}`);
            return tomlFiles;
        } catch (error) {
            this.logChannel.appendLine(`[ERROR] Failed to read projects: ${error}`);
            return [];
        }
    }

    async getAvailableBuildTypes(): Promise<string[]> {
        return ['Debug', 'Release', 'RelWithDebInfo', 'MinSizeRel'];
    }

    async getConfRepositoryUrl(): Promise<string | undefined> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return undefined;
        }

        const confPath = path.join(workspaceFolder.uri.fsPath, 'conf');
        if (!fs.existsSync(confPath)) {
            return undefined;
        }

        const gitConfigPath = path.join(confPath, '.git', 'config');
        if (!fs.existsSync(gitConfigPath)) {
            return undefined;
        }

        try {
            const gitConfig = fs.readFileSync(gitConfigPath, 'utf-8');
            // Parse git config to find remote origin url
            const urlMatch = gitConfig.match(/\[remote "origin"\][^\[]*url\s*=\s*(.+)/);
            if (urlMatch && urlMatch[1]) {
                return urlMatch[1].trim();
            }
        } catch (error) {
            this.logChannel.appendLine(`[ERROR] Failed to read git config: ${error}`);
        }

        return undefined;
    }

    async getConfRepositoryBranch(): Promise<string | undefined> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return undefined;
        }

        const confPath = path.join(workspaceFolder.uri.fsPath, 'conf');
        if (!fs.existsSync(confPath)) {
            return undefined;
        }

        const gitHeadPath = path.join(confPath, '.git', 'HEAD');
        if (!fs.existsSync(gitHeadPath)) {
            return undefined;
        }

        try {
            const headContent = fs.readFileSync(gitHeadPath, 'utf-8').trim();
            // HEAD content format: "ref: refs/heads/branch-name" or direct commit hash
            const branchMatch = headContent.match(/ref:\s*refs\/heads\/(.+)/);
            if (branchMatch && branchMatch[1]) {
                return branchMatch[1].trim();
            }
        } catch (error) {
            this.logChannel.appendLine(`[ERROR] Failed to read git HEAD: ${error}`);
        }

        return undefined;
    }

    async hasConfRepositoryChanges(): Promise<boolean> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return false;
        }

        const confPath = path.join(workspaceFolder.uri.fsPath, 'conf');
        if (!fs.existsSync(confPath)) {
            return false;
        }

        const gitPath = path.join(confPath, '.git');
        if (!fs.existsSync(gitPath)) {
            return false;
        }

        return new Promise((resolve) => {
            try {
                const process = cp.spawn('git', ['status', '--porcelain'], {
                    cwd: confPath,
                    shell: true
                });

                let output = '';
                process.stdout?.on('data', (data) => {
                    output += data.toString();
                });

                process.on('close', (code) => {
                    if (code === 0) {
                        // If output is not empty, there are changes
                        resolve(output.trim().length > 0);
                    } else {
                        resolve(false);
                    }
                });

                process.on('error', () => {
                    resolve(false);
                });
            } catch (error) {
                this.logChannel.appendLine(`[ERROR] Failed to check git status: ${error}`);
                resolve(false);
            }
        });
    }

    async getInstalledPackages(): Promise<string[]> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) { return []; }

        // Read current config for filtering
        const config = await this.readCelerConfig().catch(() => ({} as CelerConfig));
        const platform = config.currentPlatform;
        const buildType = config.currentBuildType;
        const project = config.currentProject;

        // ── Try packages/ directory (structured by platform/build_type/project) ──
        const packagesPath = path.join(workspaceFolder.uri.fsPath, 'packages');
        if (fs.existsSync(packagesPath)) {
            try {
                const packages = this.scanPackagesDir(packagesPath, platform, buildType, project);
                if (packages.length > 0) {
                    this.logChannel.appendLine(`[INFO] Found ${packages.length} installed packages in packages/ (filtered by platform/build_type/project)`);
                    return packages;
                }
            } catch (error) {
                this.logChannel.appendLine(`[ERROR] Failed to read packages/: ${error}`);
            }
        }

        // ── Fallback: buildtrees/ directory ──
        const buildtreesPath = path.join(workspaceFolder.uri.fsPath, 'buildtrees');
        if (!fs.existsSync(buildtreesPath)) {
            this.logChannel.appendLine(`[INFO] Neither packages/ nor buildtrees/ directory found`);
            return [];
        }

        try {
            const dirs = fs.readdirSync(buildtreesPath, { withFileTypes: true });
            const packages = dirs
                .filter(dirent => dirent.isDirectory())
                .map(dirent => dirent.name)
                .sort();

            this.logChannel.appendLine(`[INFO] Found ${packages.length} installed packages in buildtrees`);
            return packages;
        } catch (error) {
            this.logChannel.appendLine(`[ERROR] Failed to read buildtrees: ${error}`);
            return [];
        }
    }

    /**
     * Scan packages/ directory for installed packages, filtered by platform/buildType/project.
     * Recursively walks the tree; only returns leaf directories whose names look like
     * packages (contain '@'), and whose ancestor path matches the filter criteria.
     */
    private scanPackagesDir(basePath: string, platform?: string, buildType?: string, project?: string): string[] {
        const result: string[] = [];
        const filterParts = [platform, buildType, project].filter(Boolean) as string[];

        this.walkPackages(basePath, [], filterParts, result);
        return [...new Set(result)].sort();
    }

    /**
     * Recursively walk packages/ directory. Only collect dirs that look like packages
     * (name contains '@'), and whose full relative path contains all filter parts.
     */
    private walkPackages(
        currentPath: string,
        pathSegments: string[],
        filterParts: string[],
        result: string[],
        depth: number = 0
    ): void {
        if (depth > 5) { return; } // safety limit
        try {
            const entries = fs.readdirSync(currentPath, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) { continue; }

                const isPkg = entry.name.includes('@');

                if (isPkg) {
                    // Check if this package's ancestor path matches all filter parts
                    const fullRelativePath = [...pathSegments, entry.name].join('/');
                    const matches = filterParts.length === 0 ||
                        filterParts.every(part => fullRelativePath.includes(part));
                    if (matches) {
                        result.push(entry.name);
                    }
                } else {
                    // Recurse deeper
                    this.walkPackages(
                        path.join(currentPath, entry.name),
                        [...pathSegments, entry.name],
                        filterParts,
                        result,
                        depth + 1
                    );
                }
            }
        } catch { /* ignore permission errors */ }
    }

    private collectDirs(dirPath: string, result: string[]): void {
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) { result.push(entry.name); }
            }
        } catch { /* ignore */ }
    }

    async getAvailablePorts(): Promise<string[]> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            this.logChannel.appendLine(`[ERROR] No workspace folder found`);
            return [];
        }

        const portsPath = path.join(workspaceFolder.uri.fsPath, 'ports');
        this.logChannel.appendLine(`[INFO] Looking for ports in: ${portsPath}`);

        if (!fs.existsSync(portsPath)) {
            this.logChannel.appendLine(`[WARN] ports directory not found: ${portsPath}`);
            return [];
        }

        try {
            const ports: string[] = [];
            const topLevelDirs = fs.readdirSync(portsPath, { withFileTypes: true });
            this.logChannel.appendLine(`[INFO] Found ${topLevelDirs.length} items in ports directory`);

            for (const topDir of topLevelDirs) {
                if (!topDir.isDirectory() || topDir.name.startsWith('.')) { continue; }

                const topDirPath = path.join(portsPath, topDir.name);
                const subItems = fs.readdirSync(topDirPath, { withFileTypes: true });

                // Detect structure: single-letter dirs (a-z) = category; otherwise = flat port
                const isCategoryDir = topDir.name.length === 1 && /^[a-z]$/.test(topDir.name);

                if (isCategoryDir) {
                    // Category structure: ports/<letter>/<port-name>/<version>/
                    for (const item of subItems) {
                        if (!item.isDirectory()) { continue; }
                        const portPath = path.join(topDirPath, item.name);
                        const versionDirs = fs.readdirSync(portPath, { withFileTypes: true });
                        for (const vd of versionDirs) {
                            if (vd.isDirectory()) {
                                ports.push(`${item.name}@${vd.name}`);
                            }
                        }
                    }
                } else {
                    // Flat structure: ports/<port-name>/<version>/
                    for (const item of subItems) {
                        if (item.isDirectory()) {
                            ports.push(`${topDir.name}@${item.name}`);
                        }
                    }
                }
            }

            ports.sort();
            this.logChannel.appendLine(`[INFO] Total available ports: ${ports.length}`);
            return ports;
        } catch (error) {
            this.logChannel.appendLine(`[ERROR] Failed to read ports directory: ${error}`);
            return [];
        }
    }

    async getPortVersion(portName: string): Promise<string | undefined> {
        // This method is no longer needed since versions are in directory names
        // Kept for compatibility, returns undefined
        return undefined;
    }
}
