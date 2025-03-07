/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { basename } from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { TerminalShellType } from '../../../../../platform/terminal/common/terminal.js';
import { ISimpleCompletion } from '../../../../services/suggest/browser/simpleCompletionItem.js';
import { ITerminalSuggestConfiguration, terminalSuggestConfigSection } from '../common/terminalSuggestConfiguration.js';

export const ITerminalCompletionService = createDecorator<ITerminalCompletionService>('terminalCompletionService');

export enum TerminalCompletionItemKind {
	File = 0,
	Folder = 1,
	Flag = 2,
	Method = 3,
	Argument = 4
}

export interface ITerminalCompletion extends ISimpleCompletion {
	kind?: TerminalCompletionItemKind;
}


/**
 * Represents a collection of {@link CompletionItem completion items} to be presented
 * in the editor.
 */
export class TerminalCompletionList<ITerminalCompletion> {

	/**
	 * Resources should be shown in the completions list
	 */
	resourceRequestConfig?: TerminalResourceRequestConfig;

	/**
	 * The completion items.
	 */
	items?: ITerminalCompletion[];

	/**
	 * Creates a new completion list.
	 *
	 * @param items The completion items.
	 * @param isIncomplete The list is not complete.
	 */
	constructor(items?: ITerminalCompletion[], resourceRequestConfig?: TerminalResourceRequestConfig) {
		this.items = items;
		this.resourceRequestConfig = resourceRequestConfig;
	}
}

export interface TerminalResourceRequestConfig {
	filesRequested?: boolean;
	foldersRequested?: boolean;
	cwd?: URI;
	pathSeparator: string;
}


export interface ITerminalCompletionProvider {
	id: string;
	shellTypes?: TerminalShellType[];
	provideCompletions(value: string, cursorPosition: number, token: CancellationToken): Promise<ITerminalCompletion[] | TerminalCompletionList<ITerminalCompletion> | undefined>;
	triggerCharacters?: string[];
	isBuiltin?: boolean;
}

export interface ITerminalCompletionService {
	_serviceBrand: undefined;
	readonly providers: IterableIterator<ITerminalCompletionProvider>;
	registerTerminalCompletionProvider(extensionIdentifier: string, id: string, provider: ITerminalCompletionProvider, ...triggerCharacters: string[]): IDisposable;
	provideCompletions(promptValue: string, cursorPosition: number, shellType: TerminalShellType, token: CancellationToken, triggerCharacter?: boolean, skipExtensionCompletions?: boolean): Promise<ITerminalCompletion[] | undefined>;
}

export class TerminalCompletionService extends Disposable implements ITerminalCompletionService {
	declare _serviceBrand: undefined;
	private readonly _providers: Map</*ext id*/string, Map</*provider id*/string, ITerminalCompletionProvider>> = new Map();

	get providers(): IterableIterator<ITerminalCompletionProvider> {
		return this._providersGenerator();
	}

	private *_providersGenerator(): IterableIterator<ITerminalCompletionProvider> {
		for (const providerMap of this._providers.values()) {
			for (const provider of providerMap.values()) {
				yield provider;
			}
		}
	}

	constructor(@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IFileService private readonly _fileService: IFileService
	) {
		super();
	}

	registerTerminalCompletionProvider(extensionIdentifier: string, id: string, provider: ITerminalCompletionProvider, ...triggerCharacters: string[]): IDisposable {
		let extMap = this._providers.get(extensionIdentifier);
		if (!extMap) {
			extMap = new Map();
			this._providers.set(extensionIdentifier, extMap);
		}
		provider.triggerCharacters = triggerCharacters;
		provider.id = id;
		extMap.set(id, provider);
		return toDisposable(() => {
			const extMap = this._providers.get(extensionIdentifier);
			if (extMap) {
				extMap.delete(id);
				if (extMap.size === 0) {
					this._providers.delete(extensionIdentifier);
				}
			}
		});
	}

	async provideCompletions(promptValue: string, cursorPosition: number, shellType: TerminalShellType, token: CancellationToken, triggerCharacter?: boolean, skipExtensionCompletions?: boolean): Promise<ITerminalCompletion[] | undefined> {
		if (!this._providers || !this._providers.values) {
			return undefined;
		}

		const extensionCompletionsEnabled = this._configurationService.getValue<ITerminalSuggestConfiguration>(terminalSuggestConfigSection).enableExtensionCompletions;
		let providers;
		if (triggerCharacter) {
			const providersToRequest: ITerminalCompletionProvider[] = [];
			for (const provider of this.providers) {
				if (!provider.triggerCharacters) {
					continue;
				}
				for (const char of provider.triggerCharacters) {
					if (promptValue.substring(0, cursorPosition)?.endsWith(char)) {
						providersToRequest.push(provider);
						break;
					}
				}
			}
			providers = providersToRequest;
		} else {
			providers = [...this._providers.values()].flatMap(providerMap => [...providerMap.values()]);
		}

		if (!extensionCompletionsEnabled || skipExtensionCompletions) {
			providers = providers.filter(p => p.isBuiltin);
		}

		return this._collectCompletions(providers, shellType, promptValue, cursorPosition, token);
	}

	private async _collectCompletions(providers: ITerminalCompletionProvider[], shellType: TerminalShellType, promptValue: string, cursorPosition: number, token: CancellationToken): Promise<ITerminalCompletion[] | undefined> {
		const completionPromises = providers.map(async provider => {
			if (provider.shellTypes && !provider.shellTypes.includes(shellType)) {
				return undefined;
			}
			const completions: ITerminalCompletion[] | TerminalCompletionList<ITerminalCompletion> | undefined = await provider.provideCompletions(promptValue, cursorPosition, token);
			if (!completions) {
				return undefined;
			}
			const completionItems = Array.isArray(completions) ? completions : completions.items ?? [];
			for (const item of completionItems) {
				item.provider = provider.id;
			}

			if (Array.isArray(completions)) {
				return completionItems;
			}
			if (completions.resourceRequestConfig) {
				const resourceCompletions = await this.resolveResources(completions.resourceRequestConfig, promptValue, cursorPosition, provider.id);
				if (resourceCompletions) {
					completionItems.push(...resourceCompletions);
				}
				return completionItems;
			}
			return;
		});

		const results = await Promise.all(completionPromises);
		return results.filter(result => !!result).flat();
	}

	async resolveResources(resourceRequestConfig: TerminalResourceRequestConfig, promptValue: string, cursorPosition: number, providerId: string): Promise<ITerminalCompletion[] | undefined> {
		const cwd = URI.revive(resourceRequestConfig.cwd);
		const foldersRequested = resourceRequestConfig.foldersRequested ?? false;
		const filesRequested = resourceRequestConfig.filesRequested ?? false;
		if (!cwd || (!foldersRequested && !filesRequested)) {
			return;
		}

		const fileStat = await this._fileService.resolve(cwd, { resolveSingleChildDescendants: true });
		if (!fileStat || !fileStat?.children) {
			return;
		}

		const resourceCompletions: ITerminalCompletion[] = [];
		const cursorPrefix = promptValue.substring(0, cursorPosition);
		const endsWithSpace = cursorPrefix.endsWith(' ');
		const lastWord = endsWithSpace ? '' : cursorPrefix.split(' ').at(-1) ?? '';

		for (const stat of fileStat.children) {
			let kind: TerminalCompletionItemKind | undefined;
			if (foldersRequested && stat.isDirectory) {
				kind = TerminalCompletionItemKind.Folder;
			}
			if (filesRequested && !stat.isDirectory && (stat.isFile || stat.resource.scheme === Schemas.file)) {
				kind = TerminalCompletionItemKind.File;
			}
			if (kind === undefined) {
				continue;
			}
			const isDirectory = kind === TerminalCompletionItemKind.Folder;
			const fileName = basename(stat.resource.fsPath);

			let label;
			if (!lastWord.startsWith('.' + resourceRequestConfig.pathSeparator) && !lastWord.startsWith('..' + resourceRequestConfig.pathSeparator)) {
				// add a dot to the beginning of the label if it doesn't already have one
				label = `.${resourceRequestConfig.pathSeparator}${fileName}`;
			} else {
				if (lastWord.endsWith(resourceRequestConfig.pathSeparator)) {
					label = `${lastWord}${fileName}`;
				} else {
					label = `${lastWord}${resourceRequestConfig.pathSeparator}${fileName}`;
				}
				if (lastWord.length && lastWord.at(-1) !== resourceRequestConfig.pathSeparator && lastWord.at(-1) !== '.') {
					label = `.${resourceRequestConfig.pathSeparator}${fileName}`;
				}
			}
			if (isDirectory && !label.endsWith(resourceRequestConfig.pathSeparator)) {
				label = label + resourceRequestConfig.pathSeparator;
			}
			resourceCompletions.push({
				label,
				provider: providerId,
				kind,
				isDirectory,
				isFile: kind === TerminalCompletionItemKind.File,
				replacementIndex: cursorPosition - lastWord.length,
				replacementLength: lastWord.length
			});
		}

		return resourceCompletions.length ? resourceCompletions : undefined;
	}
}
