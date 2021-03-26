import { ClientCap, ServiceClient } from '../service';
import { condRegistration, requireSomeCap, requireMinVer } from '../registration';
import { DiagnosticsManager } from '../../old/ts/languageFeatures/diagnostics';
import * as nls from 'vscode-nls';
import * as qu from '../utils';
import * as qv from 'vscode';
import API from '../../old/ts/utils/api';
import FileConfigurationManager from '../../old/ts/languageFeatures/fileConfigurationManager';
import type * as qp from '../protocol';

const localize = nls.loadMessageBundle();

interface AutoFix {
  readonly codes: Set<number>;
  readonly fixName: string;
}

async function buildIndividualFixes(
  fixes: readonly AutoFix[],
  edit: qv.WorkspaceEdit,
  client: ServiceClient,
  file: string,
  diagnostics: readonly qv.Diagnostic[],
  token: qv.CancellationToken
): Promise<void> {
  for (const diagnostic of diagnostics) {
    for (const { codes, fixName } of fixes) {
      if (token.isCancellationRequested) {
        return;
      }

      if (!codes.has(diagnostic.code as number)) {
        continue;
      }

      const args: qp.CodeFixRequestArgs = {
        ...qu.Range.toFileRangeRequestArgs(file, diagnostic.range),
        errorCodes: [+diagnostic.code!],
      };

      const response = await client.execute('getCodeFixes', args, token);
      if (response.type !== 'response') {
        continue;
      }

      const fix = response.body?.find((fix) => fix.fixName === fixName);
      if (fix) {
        qu.WorkspaceEdit.withFileCodeEdits(edit, client, fix.changes);
        break;
      }
    }
  }
}

async function buildCombinedFix(
  fixes: readonly AutoFix[],
  edit: qv.WorkspaceEdit,
  client: ServiceClient,
  file: string,
  diagnostics: readonly qv.Diagnostic[],
  token: qv.CancellationToken
): Promise<void> {
  for (const diagnostic of diagnostics) {
    for (const { codes, fixName } of fixes) {
      if (token.isCancellationRequested) {
        return;
      }

      if (!codes.has(diagnostic.code as number)) {
        continue;
      }

      const args: qp.CodeFixRequestArgs = {
        ...qu.Range.toFileRangeRequestArgs(file, diagnostic.range),
        errorCodes: [+diagnostic.code!],
      };

      const response = await client.execute('getCodeFixes', args, token);
      if (response.type !== 'response' || !response.body?.length) {
        continue;
      }

      const fix = response.body?.find((fix) => fix.fixName === fixName);
      if (!fix) {
        continue;
      }

      if (!fix.fixId) {
        qu.WorkspaceEdit.withFileCodeEdits(edit, client, fix.changes);
        return;
      }

      const combinedArgs: qp.GetCombinedCodeFixRequestArgs = {
        scope: {
          type: 'file',
          args: { file },
        },
        fixId: fix.fixId,
      };

      const combinedResponse = await client.execute('getCombinedCodeFix', combinedArgs, token);
      if (combinedResponse.type !== 'response' || !combinedResponse.body) {
        return;
      }

      qu.WorkspaceEdit.withFileCodeEdits(edit, client, combinedResponse.body.changes);
      return;
    }
  }
}

// #region Source Actions

abstract class SourceAction extends qv.CodeAction {
  abstract build(client: ServiceClient, file: string, diagnostics: readonly qv.Diagnostic[], token: qv.CancellationToken): Promise<void>;
}

class SourceFixAll extends SourceAction {
  static readonly kind = qv.CodeActionKind.SourceFixAll.append('ts');

  constructor() {
    super(localize('autoFix.label', 'Fix All'), SourceFixAll.kind);
  }

  async build(client: ServiceClient, file: string, diagnostics: readonly qv.Diagnostic[], token: qv.CancellationToken): Promise<void> {
    this.edit = new qv.WorkspaceEdit();

    await buildIndividualFixes(
      [
        { codes: qu.incorrectlyImplementsInterface, fixName: qu.classIncorrectlyImplementsInterface },
        { codes: qu.asyncOnlyAllowedInAsyncFunctions, fixName: qu.awaitInSyncFunction },
      ],
      this.edit,
      client,
      file,
      diagnostics,
      token
    );

    await buildCombinedFix([{ codes: qu.unreachableCode, fixName: qu.unreachableCode }], this.edit, client, file, diagnostics, token);
  }
}

class SourceRemoveUnused extends SourceAction {
  static readonly kind = qv.CodeActionKind.Source.append('removeUnused').append('ts');

  constructor() {
    super(localize('autoFix.unused.label', 'Remove all unused code'), SourceRemoveUnused.kind);
  }

  async build(client: ServiceClient, file: string, diagnostics: readonly qv.Diagnostic[], token: qv.CancellationToken): Promise<void> {
    this.edit = new qv.WorkspaceEdit();
    await buildCombinedFix([{ codes: qu.variableDeclaredButNeverUsed, fixName: qu.unusedIdentifier }], this.edit, client, file, diagnostics, token);
  }
}

class SourceAddMissingImports extends SourceAction {
  static readonly kind = qv.CodeActionKind.Source.append('addMissingImports').append('ts');

  constructor() {
    super(localize('autoFix.missingImports.label', 'Add all missing imports'), SourceAddMissingImports.kind);
  }

  async build(client: ServiceClient, file: string, diagnostics: readonly qv.Diagnostic[], token: qv.CancellationToken): Promise<void> {
    this.edit = new qv.WorkspaceEdit();
    await buildCombinedFix([{ codes: qu.cannotFindName, fixName: qu.fixImport }], this.edit, client, file, diagnostics, token);
  }
}

//#endregion

class TypeScriptAutoFixProvider implements qv.CodeActionProvider {
  private static kindProviders = [SourceFixAll, SourceRemoveUnused, SourceAddMissingImports];

  constructor(private readonly client: ServiceClient, private readonly fileConfigurationManager: FileConfigurationManager, private readonly diagnosticsManager: DiagnosticsManager) {}

  public get metadata(): qv.CodeActionProviderMetadata {
    return {
      providedCodeActionKinds: TypeScriptAutoFixProvider.kindProviders.map((x) => x.kind),
    };
  }

  public async provideCodeActions(document: qv.TextDocument, _range: qv.Range, context: qv.CodeActionContext, token: qv.CancellationToken): Promise<qv.CodeAction[] | undefined> {
    if (!context.only || !qv.CodeActionKind.Source.intersects(context.only)) {
      return undefined;
    }

    const file = this.client.toOpenedFilePath(document);
    if (!file) {
      return undefined;
    }

    const actions = this.getFixAllActions(context.only);
    if (this.client.bufferSyncSupport.hasPendingDiagnostics(document.uri)) {
      return actions;
    }

    const diagnostics = this.diagnosticsManager.getDiagnostics(document.uri);
    if (!diagnostics.length) {
      // Actions are a no-op in this case but we still want to return them
      return actions;
    }

    await this.fileConfigurationManager.ensureConfigurationForDocument(document, token);

    if (token.isCancellationRequested) {
      return undefined;
    }

    await Promise.all(actions.map((action) => action.build(this.client, file, diagnostics, token)));

    return actions;
  }

  private getFixAllActions(only: qv.CodeActionKind): SourceAction[] {
    return TypeScriptAutoFixProvider.kindProviders.filter((provider) => only.intersects(provider.kind)).map((provider) => new provider());
  }
}

export function register(selector: qu.DocumentSelector, client: ServiceClient, fileConfigurationManager: FileConfigurationManager, diagnosticsManager: DiagnosticsManager) {
  return condRegistration([requireMinVer(client, API.v300), requireSomeCap(client, ClientCap.Semantic)], () => {
    const provider = new TypeScriptAutoFixProvider(client, fileConfigurationManager, diagnosticsManager);
    return qv.languages.registerCodeActionsProvider(selector.semantic, provider, provider.metadata);
  });
}