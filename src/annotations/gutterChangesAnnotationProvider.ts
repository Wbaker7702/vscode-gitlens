import type { CancellationToken, DecorationOptions, Disposable, TextDocument, TextEditor } from 'vscode';
import { Hover, languages, Position, Range, Selection, TextEditorRevealType } from 'vscode';
import type { Container } from '../container';
import type { GitCommit } from '../git/models/commit';
import type { ParsedGitDiffHunks } from '../git/models/diff';
import { localChangesMessage } from '../hovers/hovers';
import { configuration } from '../system/-webview/configuration';
import { log } from '../system/decorators/log';
import { getLogScope } from '../system/logger.scope';
import { getSettledValue } from '../system/promise';
import { maybeStopWatch } from '../system/stopwatch';
import type { TrackedGitDocument } from '../trackers/trackedDocument';
import type { AnnotationContext, AnnotationState, DidChangeStatusCallback } from './annotationProvider';
import { AnnotationProviderBase } from './annotationProvider';
import type { Decoration } from './annotations';
import { Decorations } from './fileAnnotationController';

const maxSmallIntegerV8 = 2 ** 30 - 1; // Max number that can be stored in V8's smis (small integers)

export interface ChangesAnnotationContext extends AnnotationContext {
	sha?: string;
	only?: boolean;
}

export class GutterChangesAnnotationProvider extends AnnotationProviderBase<ChangesAnnotationContext> {
	private hoverProviderDisposable: Disposable | undefined;
	private sortedHunkStarts: number[] | undefined;
	private state: { commit: GitCommit | undefined; diffs: ParsedGitDiffHunks[] } | undefined;

	constructor(
		container: Container,
		onDidChangeStatus: DidChangeStatusCallback,
		editor: TextEditor,
		trackedDocument: TrackedGitDocument,
	) {
		super(container, onDidChangeStatus, 'changes', editor, trackedDocument);
	}

	override canReuse(context?: ChangesAnnotationContext): boolean {
		return !(this.annotationContext?.sha !== context?.sha || this.annotationContext?.only !== context?.only);
	}

	override clear(): Promise<void> {
		this.state = undefined;
		if (this.hoverProviderDisposable != null) {
			this.hoverProviderDisposable.dispose();
			this.hoverProviderDisposable = undefined;
		}
		return super.clear();
	}

	override nextChange(): void {
		if (this.sortedHunkStarts == null) return;

		let nextLine = -1;
		const currentLine = this.editor.selection.active.line;
		for (const line of this.sortedHunkStarts) {
			if (line > currentLine) {
				nextLine = line;
				break;
			}
		}

		if (nextLine === -1) {
			nextLine = this.sortedHunkStarts[0];
		}

		if (nextLine > 0) {
			this.editor.selection = new Selection(nextLine, 0, nextLine, 0);
			this.editor.revealRange(
				new Range(nextLine, 0, nextLine, 0),
				TextEditorRevealType.InCenterIfOutsideViewport,
			);
		}
	}

	override previousChange(): void {
		if (this.sortedHunkStarts == null) return;

		let previousLine = -1;
		const currentLine = this.editor.selection.active.line;
		for (const line of this.sortedHunkStarts) {
			if (line >= currentLine) break;

			previousLine = line;
		}

		if (previousLine === -1) {
			previousLine = this.sortedHunkStarts[this.sortedHunkStarts.length - 1];
		}

		if (previousLine > 0) {
			this.editor.selection = new Selection(previousLine, 0, previousLine, 0);
			this.editor.revealRange(
				new Range(previousLine, 0, previousLine, 0),
				TextEditorRevealType.InCenterIfOutsideViewport,
			);
		}
	}

	@log()
	override async onProvideAnnotation(context?: ChangesAnnotationContext, state?: AnnotationState): Promise<boolean> {
		const scope = getLogScope();

		let rev1 = this.trackedDocument.uri.sha;
		let rev2 = context?.sha != null && context.sha !== rev1 ? `${context.sha}^` : undefined;

		let commit: GitCommit | undefined;

		const svc = this.container.git.getRepositoryService(this.trackedDocument.uri.repoPath!);

		let localChanges = rev1 == null && rev2 == null;
		if (localChanges) {
			let rev = await svc.commits.getOldestUnpushedShaForPath(this.trackedDocument.uri);
			if (rev != null) {
				rev = `${rev}^`;
				commit = await svc.commits.getCommitForFile(this.trackedDocument.uri, rev);
				if (commit != null) {
					if (rev2 != null) {
						rev2 = rev;
					} else {
						rev1 = rev;
						rev2 = '';
					}
				} else {
					localChanges = false;
				}
			} else {
				const status = await svc.status.getStatusForFile?.(this.trackedDocument.uri);
				const commits = status?.getPseudoCommits(this.container, await svc.config.getCurrentUser());
				if (commits?.length) {
					commit = await svc.commits.getCommitForFile(this.trackedDocument.uri);
					rev1 = 'HEAD';
				} else if (this.trackedDocument.dirty) {
					rev1 = 'HEAD';
				} else {
					localChanges = false;
				}
			}
		}

		if (!localChanges) {
			commit = await svc.commits.getCommitForFile(this.trackedDocument.uri, rev2 ?? rev1);

			if (commit != null) {
				if (rev2 != null) {
					rev2 = commit.ref;
				} else {
					rev1 = `${commit.ref}^`;
					rev2 = commit.ref;
				}
			}
		}

		const diffs = (
			await Promise.allSettled(
				rev2 == null && this.editor.document.isDirty
					? [
							this.container.git.getDiffForFileContents(
								this.trackedDocument.uri,
								rev1!,
								this.editor.document.getText(),
							),
							this.container.git.getDiffForFile(this.trackedDocument.uri, rev1, rev2),
						]
					: [this.container.git.getDiffForFile(this.trackedDocument.uri, rev1, rev2)],
			)
		)
			.map(d => getSettledValue(d))
			.filter(<T>(d?: T): d is T => Boolean(d));
		if (!diffs?.length) return false;

		using sw = maybeStopWatch(scope);

		const decorationsMap = new Map<string, Decoration<DecorationOptions[]>>();

		// If we want to only show changes from the specified sha, get the blame so we can compare with "visible" shas
		const blame =
			context?.sha != null && context?.only
				? await this.container.git.getBlame(this.trackedDocument.uri, this.editor?.document)
				: undefined;

		let selection: Selection | undefined;

		this.sortedHunkStarts = [];

		for (const diff of diffs) {
			for (const hunk of diff.hunks) {
				// Only show "visible" hunks
				if (blame != null) {
					let skip = true;

					const sha = context!.sha;
					for (let i = hunk.current.position.start - 1; i < hunk.current.position.end; i++) {
						if (blame.lines[i]?.sha === sha) {
							skip = false;
						}
					}

					if (skip) continue;
				}

				for (const [line, hunkLine] of hunk.lines) {
					if (hunkLine.state === 'unchanged') continue;

					// Uncomment this if we want to only show "visible" lines, rather than just visible hunks
					// if (blame != null && blame.lines[count].sha !== context!.sha) {
					// 	continue;
					// }

					const range = this.editor.document.validateRange(
						new Range(new Position(line - 1, 0), new Position(line - 1, maxSmallIntegerV8)),
					);

					this.sortedHunkStarts.push(range.start.line);

					if (selection == null) {
						selection = new Selection(range.start, range.end);
					}

					let decoration = decorationsMap.get(hunkLine.state);
					if (decoration == null) {
						decoration = {
							decorationType: (hunkLine.state === 'added'
								? Decorations.changesLineAddedAnnotation
								: hunkLine.state === 'removed'
									? Decorations.changesLineDeletedAnnotation
									: Decorations.changesLineChangedAnnotation)!,
							rangesOrOptions: [{ range: range }],
						};
						decorationsMap.set(hunkLine.state, decoration);
					} else {
						decoration.rangesOrOptions.push({ range: range });
					}
				}
			}
		}

		this.sortedHunkStarts.sort((a, b) => a - b);

		sw?.restart({ suffix: ' to compute recent changes annotations' });

		if (decorationsMap.size) {
			this.setDecorations([...decorationsMap.values()]);

			sw?.stop({ suffix: ' to apply all recent changes annotations' });

			if (selection != null && context?.selection !== false && !state?.restoring) {
				this.editor.selection = selection;
				this.editor.revealRange(selection, TextEditorRevealType.InCenterIfOutsideViewport);
			}
		}

		this.state = { commit: commit, diffs: diffs };
		this.registerHoverProvider();
		return true;
	}

	registerHoverProvider(): void {
		const cfg = configuration.get('hovers');
		if (!cfg.enabled || !cfg.annotations.enabled) return;

		this.hoverProviderDisposable?.dispose();
		this.hoverProviderDisposable = languages.registerHoverProvider(
			{ pattern: this.editor.document.uri.fsPath },
			{
				provideHover: (document: TextDocument, position: Position, token: CancellationToken) =>
					this.provideHover(document, position, token),
			},
		);
	}

	async provideHover(
		document: TextDocument,
		position: Position,
		_token: CancellationToken,
	): Promise<Hover | undefined> {
		if (this.state == null) return undefined;
		if (configuration.get('hovers.annotations.over') !== 'line' && position.character !== 0) return undefined;

		const { commit, diffs } = this.state;

		for (const diff of diffs) {
			for (const hunk of diff.hunks) {
				// If we have a "mixed" diff hunk, check if we have more deleted lines than added, to include a trailing line for the deleted indicator
				const hasMoreDeletedLines = /*hunk.state === 'changed' &&*/ hunk.previous.count > hunk.current.count;
				if (
					position.line >= hunk.current.position.start - 1 &&
					position.line <= hunk.current.position.end - (hasMoreDeletedLines ? 0 : 1)
				) {
					const markdown = await localChangesMessage(commit, this.trackedDocument.uri, position.line, hunk);
					if (markdown == null) return undefined;

					return new Hover(
						markdown,
						document.validateRange(
							new Range(
								hunk.current.position.start - 1,
								0,
								hunk.current.position.end - (hasMoreDeletedLines ? 0 : 1),
								maxSmallIntegerV8,
							),
						),
					);
				}
			}
		}

		return undefined;
	}
}
