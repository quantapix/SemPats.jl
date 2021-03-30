import { CancellationToken, DocumentSymbol, Location, SymbolInformation, SymbolKind } from 'vscode-languageserver';
import { URI } from 'vscode-uri';

import { resolveAliasDeclaration } from '../analyzer/aliasDeclarationUtils';
import { AnalyzerFileInfo, ImportLookup } from '../analyzer/analyzerFileInfo';
import * as AnalyzerNodeInfo from '../analyzer/analyzerNodeInfo';
import { AliasDeclaration, Declaration, DeclarationType } from '../analyzer/declaration';
import { getNameFromDeclaration } from '../analyzer/declarationUtils';
import { getLastTypedDeclaredForSymbol } from '../analyzer/symbolUtils';
import { TypeEvaluator } from '../analyzer/typeEvaluator';
import { isProperty } from '../analyzer/typeUtils';
import { throwIfCancellationRequested } from '../common/cancellationUtils';
import { convertOffsetsToRange } from '../common/positionUtils';
import * as StringUtils from '../common/stringUtils';
import { Range } from '../common/textRange';
import { ParseResults } from '../parser/parser';

export interface IndexAliasData {
  readonly originalName: string;
  readonly modulePath: string;
  readonly kind: SymbolKind;
}

export interface IndexSymbolData {
  readonly name: string;
  readonly externallyVisible: boolean;
  readonly kind: SymbolKind;
  readonly alias?: IndexAliasData;
  readonly range?: Range;
  readonly selectionRange?: Range;
  readonly children?: IndexSymbolData[];
}

export interface IndexResults {
  readonly privateOrProtected: boolean;
  readonly symbols: IndexSymbolData[];
}

export interface IndexOptions {
  indexingForAutoImportMode: boolean;
}

export type WorkspaceSymbolCallback = (symbols: SymbolInformation[]) => void;

export function getIndexAliasData(importLookup: ImportLookup, declaration: AliasDeclaration): IndexAliasData | undefined {
  if (!declaration.symbolName) {
    return undefined;
  }

  const resolved = resolveAliasDeclaration(importLookup, declaration, /* resolveLocalNames */ true);
  const nameValue = resolved ? getNameFromDeclaration(resolved) : undefined;
  if (!nameValue || resolved!.path.length <= 0) {
    return undefined;
  }

  return {
    originalName: nameValue,
    modulePath: resolved!.path,
    kind: getSymbolKind(nameValue, resolved!) ?? SymbolKind.Module,
  };
}

export function convertToFlatSymbols(documentUri: string, symbolList: DocumentSymbol[]): SymbolInformation[] {
  const flatSymbols: SymbolInformation[] = [];

  for (const symbol of symbolList) {
    appendToFlatSymbolsRecursive(flatSymbols, documentUri, symbol);
  }

  return flatSymbols;
}

export class DocumentSymbolProvider {
  static getSymbolsForDocument(
    fileInfo: AnalyzerFileInfo | undefined,
    indexResults: IndexResults | undefined,
    parseResults: ParseResults | undefined,
    filePath: string,
    query: string,
    token: CancellationToken
  ): SymbolInformation[] {
    const symbolList: SymbolInformation[] = [];

    if (!indexResults && !parseResults) {
      return symbolList;
    }

    const indexSymbolData = (indexResults?.symbols as IndexSymbolData[]) ?? DocumentSymbolProvider.indexSymbols(fileInfo!, parseResults!, { indexingForAutoImportMode: false }, token);

    appendWorkspaceSymbolsRecursive(indexSymbolData, filePath, query, '', symbolList, token);
    return symbolList;
  }

  static addHierarchicalSymbolsForDocument(
    fileInfo: AnalyzerFileInfo | undefined,
    indexResults: IndexResults | undefined,
    parseResults: ParseResults | undefined,
    symbolList: DocumentSymbol[],
    token: CancellationToken
  ) {
    if (!indexResults && !parseResults) {
      return;
    }

    const indexSymbolData = (indexResults?.symbols as IndexSymbolData[]) ?? DocumentSymbolProvider.indexSymbols(fileInfo!, parseResults!, { indexingForAutoImportMode: false }, token);
    appendDocumentSymbolsRecursive(indexSymbolData, symbolList, token);
  }

  static indexSymbols(fileInfo: AnalyzerFileInfo, parseResults: ParseResults, options: IndexOptions, token: CancellationToken): IndexSymbolData[] {
    const indexSymbolData: IndexSymbolData[] = [];
    collectSymbolIndexData(fileInfo, parseResults, parseResults.parseTree, options, indexSymbolData, token);

    return indexSymbolData;
  }
}

function getSymbolKind(name: string, declaration: Declaration, evaluator?: TypeEvaluator): SymbolKind | undefined {
  let symbolKind: SymbolKind;
  switch (declaration.type) {
    case DeclarationType.Class:
    case DeclarationType.SpecialBuiltInClass:
      symbolKind = SymbolKind.Class;
      break;

    case DeclarationType.Function:
      if (declaration.isMethod) {
        const declType = evaluator?.getTypeForDeclaration(declaration);
        if (declType && isProperty(declType)) {
          symbolKind = SymbolKind.Property;
        } else {
          symbolKind = SymbolKind.Method;
        }
      } else {
        symbolKind = SymbolKind.Function;
      }
      break;

    case DeclarationType.Alias:
      symbolKind = SymbolKind.Module;
      break;

    case DeclarationType.Parameter:
      if (name === 'self' || name === 'cls' || name === '_') {
        return;
      }
      symbolKind = SymbolKind.Variable;
      break;

    case DeclarationType.Variable:
      if (name === '_') {
        return;
      }
      symbolKind = declaration.isConstant || declaration.isFinal ? SymbolKind.Constant : SymbolKind.Variable;
      break;

    default:
      symbolKind = SymbolKind.Variable;
      break;
  }

  return symbolKind;
}

function appendWorkspaceSymbolsRecursive(
  indexSymbolData: IndexSymbolData[] | undefined,
  filePath: string,
  query: string,
  container: string,
  symbolList: SymbolInformation[],
  token: CancellationToken
) {
  throwIfCancellationRequested(token);

  if (!indexSymbolData) {
    return;
  }

  for (const symbolData of indexSymbolData) {
    if (symbolData.alias) {
      continue;
    }

    if (StringUtils.isPatternInSymbol(query, symbolData.name)) {
      const location: Location = {
        uri: URI.file(filePath).toString(),
        range: symbolData.selectionRange!,
      };

      const symbolInfo: SymbolInformation = {
        name: symbolData.name,
        kind: symbolData.kind,
        containerName: container.length > 0 ? container : undefined,
        location,
      };

      symbolList.push(symbolInfo);
    }

    appendWorkspaceSymbolsRecursive(symbolData.children, filePath, query, getContainerName(container, symbolData.name), symbolList, token);
  }

  function getContainerName(container: string, name: string) {
    if (container.length > 0) {
      return `${container}.${name}`;
    }

    return name;
  }
}

function appendDocumentSymbolsRecursive(indexSymbolData: IndexSymbolData[] | undefined, symbolList: DocumentSymbol[], token: CancellationToken) {
  throwIfCancellationRequested(token);

  if (!indexSymbolData) {
    return;
  }

  for (const symbolData of indexSymbolData) {
    if (symbolData.alias) {
      continue;
    }

    const children: DocumentSymbol[] = [];
    appendDocumentSymbolsRecursive(symbolData.children, children, token);

    const symbolInfo: DocumentSymbol = {
      name: symbolData.name,
      kind: symbolData.kind,
      range: symbolData.range!,
      selectionRange: symbolData.selectionRange!,
      children: children!,
    };

    symbolList.push(symbolInfo);
  }
}

function collectSymbolIndexData(
  fileInfo: AnalyzerFileInfo,
  parseResults: ParseResults,
  node: AnalyzerNodeInfo.ScopedNode,
  options: IndexOptions,
  indexSymbolData: IndexSymbolData[],
  token: CancellationToken
) {
  throwIfCancellationRequested(token);

  const scope = AnalyzerNodeInfo.getScope(node);
  if (!scope) {
    return;
  }

  const symbolTable = scope.symbolTable;
  symbolTable.forEach((symbol, name) => {
    if (symbol.isIgnoredForProtocolMatch()) {
      return;
    }
    if (options.indexingForAutoImportMode && !fileInfo.isStubFile && !fileInfo.isInPyTypedPackage && !symbol.isInDunderAll()) {
      return;
    }
    let declaration = getLastTypedDeclaredForSymbol(symbol);
    if (!declaration && symbol.hasDeclarations()) {
      declaration = symbol.getDeclarations()[0];
    }

    if (!declaration) {
      return;
    }

    if (DeclarationType.Alias === declaration.type) {
      if (!options.indexingForAutoImportMode) {
        return;
      }

      if (declaration.path.length <= 0) {
        return;
      }
    }
    collectSymbolIndexDataForName(fileInfo, parseResults, declaration, options, !symbol.isExternallyHidden(), name, indexSymbolData, token);
  });
}

function collectSymbolIndexDataForName(
  fileInfo: AnalyzerFileInfo,
  parseResults: ParseResults,
  declaration: Declaration,
  options: IndexOptions,
  externallyVisible: boolean,
  name: string,
  indexSymbolData: IndexSymbolData[],
  token: CancellationToken
) {
  if (options.indexingForAutoImportMode && !externallyVisible) {
    return;
  }

  const symbolKind = getSymbolKind(name, declaration);
  if (symbolKind === undefined) {
    return;
  }

  const selectionRange = declaration.range;
  let range = selectionRange;
  const children: IndexSymbolData[] = [];

  if (declaration.type === DeclarationType.Class || declaration.type === DeclarationType.Function) {
    if (!options.indexingForAutoImportMode) {
      collectSymbolIndexData(fileInfo, parseResults, declaration.node, options, children, token);
    }

    range = convertOffsetsToRange(declaration.node.start, declaration.node.start + declaration.node.length, parseResults.tokenizerOutput.lines);
  }

  const data: IndexSymbolData = {
    name,
    externallyVisible,
    kind: symbolKind,
    alias: DeclarationType.Alias === declaration.type ? getIndexAliasData(AnalyzerNodeInfo.getFileInfo(parseResults.parseTree)!.importLookup, declaration) : undefined,
    range: options.indexingForAutoImportMode ? undefined : range,
    selectionRange: options.indexingForAutoImportMode ? undefined : selectionRange,
    children: options.indexingForAutoImportMode ? undefined : children,
  };

  indexSymbolData.push(data);
}

function appendToFlatSymbolsRecursive(flatSymbols: SymbolInformation[], documentUri: string, symbol: DocumentSymbol, parent?: DocumentSymbol) {
  const flatSymbol: SymbolInformation = {
    name: symbol.name,
    kind: symbol.kind,
    location: Location.create(documentUri, symbol.range),
    tags: symbol.tags,
    containerName: parent?.name,
  };

  flatSymbols.push(flatSymbol);

  if (symbol.children) {
    for (const child of symbol.children) {
      appendToFlatSymbolsRecursive(flatSymbols, documentUri, child, symbol);
    }
  }
}