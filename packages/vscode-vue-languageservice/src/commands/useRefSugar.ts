import * as vscode from 'vscode-languageserver-protocol';
import type { Connection } from 'vscode-languageserver';
import { parseDeclarationRanges, parseDotValueRanges } from '@volar/vue-code-gen/out/parsers/refSugarRanges';
import * as definition from '../services/definition';
import { isBlacklistNode, isRefType } from '../services/refAutoClose';
import * as references from '../services/references';
import type { ApiLanguageServiceContext } from '../types';

export function register(context: ApiLanguageServiceContext) {

	const { sourceFiles, modules: { typescript: ts }, scriptTsLs } = context;
	const findTypeDefinition = definition.register(context).onType;
	const findReferences = references.register(context);

	return async (connection: Connection, uri: string) => {

		const sourceFile = sourceFiles.get(uri);
		if (!sourceFile) return;

		const descriptor = sourceFile.getDescriptor();
		if (!descriptor.scriptSetup) return;

		const scriptSetupAst = sourceFile.getScriptSetupAst();
		if (!scriptSetupAst) return;

		const progress = await connection.window.createWorkDoneProgress();
		progress.begin('Unuse Ref Sugar', 0, '', true);

		const edits = await getUseRefSugarEdits(sourceFile, descriptor.scriptSetup, scriptSetupAst);

		if (progress.token.isCancellationRequested)
			return;

		if (edits?.length) {
			await connection.workspace.applyEdit({ changes: { [uri]: edits } });
		}

		progress.done();

		async function getUseRefSugarEdits(
			_sourceFile: NonNullable<typeof sourceFile>,
			_scriptSetup: NonNullable<typeof descriptor['scriptSetup']>,
			_scriptSetupAst: NonNullable<typeof scriptSetupAst>,
		) {

			const ranges = parseDeclarationRanges(ts, _scriptSetupAst);
			const dotValueRanges = parseDotValueRanges(ts, _scriptSetupAst);
			const document = _sourceFile.getTextDocument();
			const edits: vscode.TextEdit[] = [];

			for (const declaration of ranges) {

				let isRefDeclaration = false;

				for (const binding of declaration.leftBindings) {

					const definitions = await findTypeDefinition(uri, document.positionAt(_scriptSetup.startTagEnd + binding.end));
					const _isRefType = isRefType(definitions, scriptTsLs);

					if (!_isRefType)
						continue;

					isRefDeclaration = true;

					let references = await findReferences(uri, document.positionAt(_scriptSetup.startTagEnd + binding.end));

					references = references.filter(reference => {

						if (reference.uri !== uri)
							return false;

						const start = document.offsetAt(reference.range.start);
						const end = document.offsetAt(reference.range.end);

						if (start >= (_scriptSetup.startTagEnd + binding.start) && end <= (_scriptSetup.startTagEnd + binding.end))
							return false;

						if (end < _scriptSetup.startTagEnd || start > _scriptSetup.startTagEnd + _scriptSetup.content.length)
							return false;

						if (isBlacklistNode(ts, _scriptSetupAst, start - _scriptSetup.startTagEnd))
							return false;

						return true;
					});

					for (const reference of references) {

						const sfcStart = document.offsetAt(reference.range.start);
						const sfcEnd = document.offsetAt(reference.range.end);
						const setupStart = sfcStart - _scriptSetup.startTagEnd;
						const setupEnd = sfcEnd - _scriptSetup.startTagEnd;
						const dotValue = dotValueRanges.find(dot => dot.beforeDot === setupEnd);

						if (!dotValue) {
							addReplace(setupStart, setupStart, '$raw(');
							addReplace(setupEnd, setupEnd, ')');
						}
						else {
							addReplace(dotValue.beforeDot, dotValue.range.end, '');
						}
					}
				}

				if (isRefDeclaration) {
					if (!declaration.leftIsIdentifier) {
						addReplace(declaration.right.start, declaration.right.start, '$fromRefs(');
						addReplace(declaration.right.end, declaration.right.end, ')');
					}
					else if (declaration.rightFn) {
						const fnText = _scriptSetup.content.substring(declaration.rightFn.start, declaration.rightFn.end);
						if (['ref', 'shallowRef'].includes(fnText)) {
							addReplace(declaration.flag.start, declaration.flag.end, 'let');
						}
						if (['ref', 'computed', 'shallowRef'].includes(fnText)) {
							addReplace(declaration.right.start, declaration.right.start, '$');
						}
					}
					else {
						addReplace(declaration.right.start, declaration.right.start, '$ref(');
						addReplace(declaration.right.end, declaration.right.end, ')');
					}
				}
			}

			return edits;

			function addReplace(start: number, end: number, text: string) {

				if (_scriptSetup.content.substring(start, end) === text)
					return;

				edits.push(vscode.TextEdit.replace(
					{
						start: document.positionAt(_scriptSetup.startTagEnd + start),
						end: document.positionAt(_scriptSetup.startTagEnd + end),
					},
					text
				));
			}
		}
	};
}
