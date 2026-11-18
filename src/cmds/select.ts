import * as vscode from 'vscode';
import * as os from 'os';
import { Celer } from '../celer';

/** Apply a configure selection and report failures in the Celer output. */
async function applySelection(
    celer: Celer, label: string, value: string, args: string[], successMessage: string
): Promise<void> {
    try {
        await celer.runCommand(args);
        vscode.commands.executeCommand('celer.sidebarRefresh');
        vscode.window.setStatusBarMessage(successMessage, 4000);
    } catch (error) {
        celer.reportFailure(`Failed to set ${label} to ${value}`, error);
    }
}

/**
 * Selection commands for platform, project, build type, and jobs
 */
export function registerSelectCommands(context: vscode.ExtensionContext, celer: Celer): void {
    // Select a project and report its target_platform (if the project defines one).
    async function applyProject(project: string): Promise<void> {
        try {
            const result = await celer.selectProject(project);
            vscode.commands.executeCommand('celer.sidebarRefresh');
            const platform = result.platform ? ` (platform: ${result.platform})` : '';
            const message = `Project set to ${project}${platform}`;
            vscode.window.setStatusBarMessage(
                result.warning ? `${message} — see Output for errors` : message,
                result.warning ? 6000 : 4000
            );
        } catch (error) {
            celer.reportFailure(`Failed to set Project to ${project}`, error);
        }
    }
    // Helper: show a QuickPick that auto-focuses on the current item
    async function pickCurrent<T extends vscode.QuickPickItem>(
        placeHolder: string,
        items: T[], currentIndex: number,
        onSelect: (item: T) => Promise<void>
    ): Promise<void> {
        const qp = vscode.window.createQuickPick<T>();
        qp.placeholder = placeHolder;
        qp.items = items;
        // Scroll to & highlight the current item
        if (currentIndex >= 0 && currentIndex < items.length) {
            qp.activeItems = [items[currentIndex]];
        }
        qp.onDidAccept(async () => {
            const selected = qp.selectedItems[0];
            if (selected) {
                qp.hide();
                await onSelect(selected);
            }
        });
        qp.onDidHide(() => qp.dispose());
        qp.show();
    }

    context.subscriptions.push(vscode.commands.registerCommand('celer.selectPlatform', async (args?: { platform?: string }) => {
        // Direct selection from tree view (no QuickPick)
        if (args?.platform) {
            await applySelection(celer, 'Platform', args.platform,
                ['configure', `--platform=${args.platform}`], `Platform set to: ${args.platform}`);
            return;
        }

        const config = await celer.readCelerConfig();
        const platforms = await celer.getAvailablePlatforms();

        if (platforms.length === 0) {
            vscode.window.showWarningMessage('No platforms found in conf/platforms directory');
            return;
        }

        const currentPlatform = config.currentPlatform;
        const items = platforms.map(p => ({
            label: p,
            platform: p,
        }));
        const idx = items.findIndex(i => i.platform === currentPlatform);

        await pickCurrent('Select a platform', items, idx, async (item: any) => {
            await applySelection(celer, 'Platform', item.platform,
                ['configure', `--platform=${item.platform}`], `Platform set to: ${item.platform}`);
        });
    }),

    vscode.commands.registerCommand('celer.selectProject', async (args?: { project?: string }) => {
        // Direct selection from tree view (no QuickPick)
        if (args?.project) {
            await applyProject(args.project);
            return;
        }

        const config = await celer.readCelerConfig();
        const projects = await celer.getAvailableProjects();

        if (projects.length === 0) {
            vscode.window.showWarningMessage('No projects found in conf/projects directory');
            return;
        }

        const currentProject = config.currentProject;
        const items = projects.map(p => ({
            label: p,
            project: p,
        }));
        const idx = items.findIndex(i => i.project === currentProject);

        await pickCurrent('Select a project', items, idx, async (item: any) => {
            await applyProject(item.project);
        });
    }),

    vscode.commands.registerCommand('celer.selectBuildType', async (args?: { buildType?: string }) => {
        // Direct selection from tree view (no QuickPick)
        if (args?.buildType) {
            await applySelection(celer, 'Build type', args.buildType,
                ['configure', `--build-type=${args.buildType}`], `Build type set to: ${args.buildType}`);
            return;
        }

        const config = await celer.readCelerConfig();
        const types = await celer.getAvailableBuildTypes();

        const currentBuildType = config.currentBuildType?.toLowerCase();
        const items = types.map(t => ({
            label: t,
            buildType: t,
        }));
        const idx = items.findIndex(i => i.buildType.toLowerCase() === currentBuildType);

        await pickCurrent('Select a build type', items, idx, async (item: any) => {
            await applySelection(celer, 'Build type', item.buildType,
                ['configure', `--build-type=${item.buildType}`], `Build type set to: ${item.buildType}`);
        });
    })
    );
}

/**
 * Selection command for jobs configuration
 */
export function registerSelectJobsCommand(
    context: vscode.ExtensionContext,
    celer: Celer
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('celer.selectJobs', async (args?: { jobs?: number }) => {
            // Direct selection from tree view (no QuickPick)
            if (args?.jobs !== undefined) {
                await applySelection(celer, 'Build jobs', String(args.jobs),
                    ['configure', `--jobs=${args.jobs}`], `Build jobs set to: ${args.jobs}`);
                return;
            }

            const config = await celer.readCelerConfig();
            const currentJobs = config.jobs;
            const cpuCount = os.cpus().length;
            const padWidth = String(cpuCount).length;

            const items = Array.from({ length: cpuCount }, (_, i) => i + 1).map(jobNum => {
                const jobText = jobNum === 1 ? 'job' : 'jobs';
                const paddedJobNum = String(jobNum).padStart(padWidth, '0');

                let description = '';
                if (jobNum === cpuCount) {
                    description = 'Maximum (all cores)';
                } else if (jobNum === Math.ceil(cpuCount * 0.75)) {
                    description = 'Recommended (75%)';
                } else if (jobNum === Math.ceil(cpuCount / 2)) {
                    description = 'Balanced (50%)';
                }

                return {
                    label: `${paddedJobNum} ${jobText}`,
                    description,
                    value: jobNum,
                };
            });

            const idx = items.findIndex(i => i.value === currentJobs);

            const qp = vscode.window.createQuickPick<(typeof items)[0]>();
            qp.placeholder = `Select parallel build jobs (1-${cpuCount} cores available)`;
            qp.items = items;
            if (idx >= 0) {
                qp.activeItems = [items[idx]];
            }
            qp.onDidAccept(async () => {
                const selected = qp.selectedItems[0];
                if (selected) {
                    qp.hide();
                    await applySelection(celer, 'Build jobs', String(selected.value),
                        ['configure', `--jobs=${selected.value}`], `Build jobs set to: ${selected.value}`);
                }
            });
            qp.onDidHide(() => qp.dispose());
            qp.show();
        })
    );
}
