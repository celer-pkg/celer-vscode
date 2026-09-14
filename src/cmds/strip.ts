import * as vscode from 'vscode';
import { Celer } from '../celer';

/**
 * Strip installed binaries and libraries
 */
export function registerStripCommand(context: vscode.ExtensionContext, celer: Celer): void {
    context.subscriptions.push(vscode.commands.registerCommand('celer.strip', async () => {
        try {
            await celer.runCommandInTerminal(['strip']);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to strip: ${error}`);
        }
    }));
}
