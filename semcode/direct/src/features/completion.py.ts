import { CancellationToken, CompletionItem, CompletionItemKind, CompletionList, InsertTextFormat, MarkupKind, Range, TextEdit } from 'vscode-languageserver';
import { ImportLookup } from '../analyzer/analyzerFileInfo';
import * as AnalyzerNodeInfo from '../analyzer/analyzerNodeInfo';
import { Declaration, DeclarationType, FunctionDeclaration, isAliasDeclaration, isFunctionDeclaration } from '../analyzer/declaration';
import { convertDocStringToMarkdown, convertDocStringToPlainText } from '../analyzer/docStringConversion';
import { ImportedModuleDescriptor, ImportResolver } from '../analyzer/importResolver';
import * as ParseTreeUtils from '../analyzer/parseTreeUtils';
import { getCallNodeAndActiveParameterIndex } from '../analyzer/parseTreeUtils';
import { SourceMapper } from '../analyzer/sourceMapper';
import { Symbol, SymbolTable } from '../analyzer/symbol';
import * as SymbolNameUtils from '../analyzer/symbolNameUtils';
import { getLastTypedDeclaredForSymbol } from '../analyzer/symbolUtils';
import { getClassDocString, getFunctionDocStringInherited, getModuleDocString, getOverloadedFunctionDocStringsInherited, getPropertyDocStringInherited } from '../analyzer/typeDocStringUtils';
import { CallSignatureInfo, TypeEvaluator } from '../analyzer/typeEvaluator';
import {
  ClassType,
  FunctionType,
  getTypeAliasInfo,
  isClass,
  isFunction,
  isModule,
  isNone,
  isObject,
  isOverloadedFunction,
  isUnbound,
  isUnknown,
  ObjectType,
  Type,
  TypeBase,
  TypeCategory,
  UnknownType,
} from '../analyzer/types';
import { doForEachSubtype, getDeclaringModulesForType, getMembersForClass, getMembersForModule, isProperty, transformTypeObjectToClass } from '../analyzer/typeUtils';
import { throwIfCancellationRequested } from '../common/cancellationUtils';
import { ConfigOptions } from '../common/configOptions';
import * as debug from '../common/debug';
import { fail } from '../common/debug';
import { TextEditAction } from '../common/editAction';
import { convertOffsetToPosition, convertPositionToOffset } from '../common/positionUtils';
import * as StringUtils from '../common/stringUtils';
import { comparePositions, Position } from '../common/textRange';
import { TextRange } from '../common/textRange';
import { TextRangeCollection } from '../common/textRangeCollection';
import { Duration } from '../common/timing';
import {
  DecoratorNode,
  ErrorExpressionCategory,
  ErrorNode,
  ExpressionNode,
  FunctionNode,
  ImportFromNode,
  isExpressionNode,
  ModuleNameNode,
  NameNode,
  ParameterCategory,
  ParameterNode,
  ParseNode,
  ParseNodeType,
  StringNode,
} from '../parser/parseNodes';
import { ParseResults } from '../parser/parser';
import { Token } from '../parser/tokenizerTypes';
import { AbbreviationInfo, AutoImporter, AutoImportResult, ModuleSymbolMap } from './py/autoImporter';
import { IndexResults } from './documentSymbolProvider';
import { getOverloadedFunctionTooltip } from './py/tooltipUtils';
const _keywords: string[] = [
  'True',
  'False',
  'None',
  'and',
  'or',
  'await',
  'not',
  'is',
  'lambda',
  'yield',
  'assert',
  'async',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'nonlocal',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'yield',
];
enum SortCategory {
  LikelyKeyword,
  RecentImportModuleName,
  ImportModuleName,
  LiteralValue,
  NamedParameter,
  RecentKeywordOrSymbol,
  RecentAutoImport,
  Keyword,
  NormalSymbol,
  PrivateSymbol,
  DunderSymbol,
  AutoImport,
}
export interface CompletionItemData {
  filePath: string;
  workspacePath: string;
  position: Position;
  autoImportText?: string;
  symbolLabel?: string;
  funcParensDisabled?: boolean;
}
export interface MemberAccessInfo {
  lastKnownModule?: string;
  lastKnownMemberName?: string;
  unknownMemberName?: string;
}
export interface AutoImportInfo {
  indexUsed: boolean;
  totalTimeInMS: number;
  moduleTimeInMS: number;
  indexTimeInMS: number;
  importAliasTimeInMS: number;
  itemCount: number;
  symbolCount: number;
  userIndexCount: number;
  indexCount: number;
  importAliasCount: number;
  editTimeInMS: number;
  moduleResolveTimeInMS: number;
  additionTimeInMS: number;
}
export interface CompletionResults {
  completionList: CompletionList | undefined;
  memberAccessInfo?: MemberAccessInfo;
  autoImportInfo?: AutoImportInfo;
}
export interface CompletionOptions {
  format: MarkupKind;
  snippet: boolean;
  lazyEdit: boolean;
}
export type AbbreviationMap = Map<string, AbbreviationInfo>;
export interface AutoImportMaps {
  nameMap?: AbbreviationMap;
  libraryMap?: Map<string, IndexResults>;
  getModuleSymbolsMap: () => ModuleSymbolMap;
}
interface RecentCompletionInfo {
  label: string;
  autoImportText: string;
}
interface Edits {
  format?: InsertTextFormat;
  textEdit?: TextEdit;
  additionalTextEdits?: TextEditAction[];
}
interface SymbolDetail {
  funcParensDisabled?: boolean;
  autoImportSource?: string;
  autoImportAlias?: string;
  boundObject?: ObjectType;
  edits?: Edits;
}
interface CompletionDetail {
  funcParensDisabled?: boolean;
  typeDetail?: string;
  documentation?: string;
  autoImportText?: string;
  edits?: Edits;
}
const similarityLimit = 0.25;
const maxRecentCompletions = 128;
export class CompletionProvider {
  private static _mostRecentCompletions: RecentCompletionInfo[] = [];
  private _itemToResolve: CompletionItem | undefined;
  constructor(
    private _workspacePath: string,
    private _parseResults: ParseResults,
    private _fileContents: string,
    private _importResolver: ImportResolver,
    private _position: Position,
    private _filePath: string,
    private _configOptions: ConfigOptions,
    private _importLookup: ImportLookup,
    private _evaluator: TypeEvaluator,
    private _options: CompletionOptions,
    private _sourceMapper: SourceMapper,
    private _autoImportMaps: AutoImportMaps | undefined,
    private _cancellationToken: CancellationToken
  ) {}
  getCompletionsForPosition(): CompletionResults | undefined {
    const offset = convertPositionToOffset(this._position, this._parseResults.tokenizerOutput.lines);
    if (offset === undefined) return undefined;
    let node = ParseTreeUtils.findNodeByOffset(this._parseResults.parseTree, offset);
    const initialNode = node;
    const initialDepth = node ? ParseTreeUtils.getNodeDepth(node) : 0;
    if (!initialNode || initialNode.nodeType !== ParseNodeType.Name) {
      let curOffset = offset;
      while (curOffset >= 0) {
        curOffset--;
        const curChar = this._fileContents.substr(curOffset, 1);
        if (curChar === '(' || curChar === '\n') {
          break;
        }
        const curNode = ParseTreeUtils.findNodeByOffset(this._parseResults.parseTree, curOffset);
        if (curNode && curNode !== initialNode) {
          if (ParseTreeUtils.getNodeDepth(curNode) > initialDepth) node = curNode;

          break;
        }
      }
    }
    if (node === undefined) return undefined;
    const lineTextRange = this._parseResults.tokenizerOutput.lines.getItemAt(this._position.line);
    const textOnLine = this._fileContents.substr(lineTextRange.start, lineTextRange.length);
    const priorText = textOnLine.substr(0, this._position.character);
    const postText = textOnLine.substr(this._position.character);
    const priorWordIndex = priorText.search(/\w+$/);
    const priorWord = priorWordIndex >= 0 ? priorText.substr(priorWordIndex) : '';
    if (this._isWithinComment(offset)) {
      return undefined;
    }
    let errorNode: ParseNode | undefined = node;
    while (errorNode) {
      if (errorNode.nodeType === ParseNodeType.Error) break;
      errorNode = errorNode.parent;
    }
    let curNode = errorNode || node;
    while (true) {
      throwIfCancellationRequested(this._cancellationToken);
      if (curNode.nodeType === ParseNodeType.String) return this._getStringLiteralCompletions(curNode, priorWord, priorText, postText);
      if (curNode.nodeType === ParseNodeType.StringList) return undefined;
      if (curNode.nodeType === ParseNodeType.ModuleName) return this._getImportModuleCompletions(curNode);
      if (curNode.nodeType === ParseNodeType.Error) return this._getExpressionErrorCompletions(curNode, priorWord, priorText, postText);
      if (curNode.nodeType === ParseNodeType.MemberAccess) return this._getMemberAccessCompletions(curNode.leftExpression, priorWord);
      if (curNode.nodeType === ParseNodeType.Name) {
        const result = this._tryGetNameCompletions(curNode, offset, priorWord);
        if (result || result === undefined) return result;
      }
      if (curNode.nodeType === ParseNodeType.ImportFrom) return this._getImportFromCompletions(curNode, priorWord);
      if (isExpressionNode(curNode)) {
        return this._getExpressionCompletions(curNode, priorWord, priorText, postText);
      }
      if (curNode.nodeType === ParseNodeType.Suite) {
        if (
          curNode.parent &&
          curNode.parent.nodeType === ParseNodeType.Except &&
          !curNode.parent.name &&
          curNode.parent.typeExpression &&
          TextRange.getEnd(curNode.parent.typeExpression) < offset &&
          offset <= curNode.parent.exceptSuite.start
        ) {
          return undefined;
        }
        if (
          curNode.parent &&
          curNode.parent.nodeType === ParseNodeType.Class &&
          (!curNode.parent.name || !curNode.parent.name.value) &&
          curNode.parent.arguments.length === 0 &&
          offset <= curNode.parent.suite.start
        ) {
          return undefined;
        }
        return this._getStatementCompletions(curNode, priorWord, priorText, postText);
      }
      if (curNode.nodeType === ParseNodeType.Module) return this._getStatementCompletions(curNode, priorWord, priorText, postText);
      if (curNode.nodeType === ParseNodeType.Parameter && curNode.length === 0 && curNode.parent && curNode.parent.nodeType === ParseNodeType.Lambda) return undefined;
      if (!curNode.parent) break;
      curNode = curNode.parent;
    }
    return undefined;
  }
  resolveCompletionItem(completionItem: CompletionItem) {
    throwIfCancellationRequested(this._cancellationToken);
    const completionItemData = completionItem.data as CompletionItemData;
    const label = completionItem.label;
    let autoImportText = '';
    if (completionItemData.autoImportText) autoImportText = completionItemData.autoImportText;
    const curIndex = CompletionProvider._mostRecentCompletions.findIndex((item) => item.label === label && item.autoImportText === autoImportText);
    if (curIndex > 0) CompletionProvider._mostRecentCompletions = CompletionProvider._mostRecentCompletions.splice(curIndex, 1);
    if (curIndex !== 0) CompletionProvider._mostRecentCompletions.unshift({ label, autoImportText });
    if (CompletionProvider._mostRecentCompletions.length > maxRecentCompletions) CompletionProvider._mostRecentCompletions.pop();
    if (completionItemData.symbolLabel) {
      this._itemToResolve = completionItem;
      if (!completionItemData.autoImportText) this.getCompletionsForPosition();
      else if (!completionItem.additionalTextEdits) {
        const completionList = CompletionList.create();
        const completionResults = { completionList };
        this._getAutoImportCompletions(completionItemData.symbolLabel, /* similarityLimit */ 1, /* lazyEdit */ false, completionResults);
      }
    }
  }
  private _tryGetNameCompletions(curNode: NameNode, offset: number, priorWord: string) {
    if (!curNode.parent) return false;
    if (curNode.parent.nodeType === ParseNodeType.ImportAs && curNode.parent.alias === curNode) return undefined;
    if (curNode.parent.nodeType === ParseNodeType.ModuleName) {
      if (curNode.parent.parent && curNode.parent.parent.nodeType === ParseNodeType.ImportAs && !curNode.parent.parent.alias && TextRange.getEnd(curNode.parent.parent) < offset) {
        return undefined;
      }
      return this._getImportModuleCompletions(curNode.parent);
    }
    if (curNode.parent.nodeType === ParseNodeType.ImportFromAs) {
      if (curNode.parent.alias === curNode) return undefined;

      const parentNode = curNode.parent.parent;
      if (parentNode && parentNode.nodeType === ParseNodeType.ImportFrom) {
        if (!curNode.parent.alias && TextRange.getEnd(curNode.parent) < offset) return undefined;

        if (curNode.parent.name === curNode) return this._getImportFromCompletions(parentNode, priorWord);
        return this._getImportFromCompletions(parentNode, '');
      }
      return false;
    }
    if (curNode.parent.nodeType === ParseNodeType.MemberAccess && curNode === curNode.parent.memberName) return this._getMemberAccessCompletions(curNode.parent.leftExpression, priorWord);
    if (curNode.parent.nodeType === ParseNodeType.Except && curNode === curNode.parent.name) return undefined;
    if (curNode.parent.nodeType === ParseNodeType.Function && curNode === curNode.parent.name) {
      if (curNode.parent.decorators?.some((d) => this._isOverload(d))) return this._getMethodOverloadsCompletions(priorWord, curNode);

      return undefined;
    }
    if (curNode.parent.nodeType === ParseNodeType.Parameter && curNode === curNode.parent.name) return undefined;
    if (curNode.parent.nodeType === ParseNodeType.Class && curNode === curNode.parent.name) return undefined;
    if (curNode.parent.nodeType === ParseNodeType.For && TextRange.contains(curNode.parent.targetExpression, curNode.start)) {
      return undefined;
    }
    if (curNode.parent.nodeType === ParseNodeType.ListComprehensionFor && TextRange.contains(curNode.parent.targetExpression, curNode.start)) {
      return undefined;
    }
    return false;
  }
  private _isWithinComment(offset: number): boolean {
    const token = getTokenAfter(offset, this._parseResults.tokenizerOutput.tokens);
    if (!token) return false;
    return token.comments?.some((c) => TextRange.overlaps(c, offset)) ?? false;
    function getTokenAfter(offset: number, tokens: TextRangeCollection<Token>) {
      const tokenIndex = tokens.getItemAtPosition(offset);
      if (tokenIndex < 0) return undefined;
      let token = tokens.getItemAt(tokenIndex);
      if (offset > token.start && offset < token.start + token.length) return undefined;
      for (let i = tokenIndex - 1; i >= 0; i--) {
        const prevToken = tokens.getItemAt(i);
        if (token.start !== prevToken.start) break;
        token = prevToken;
      }
      if (offset <= token.start) return token;
      debug.assert(tokenIndex + 1 < tokens.length);
      return tokens.getItemAt(tokenIndex + 1);
    }
  }
  private _getExpressionErrorCompletions(node: ErrorNode, priorWord: string, priorText: string, postText: string): CompletionResults | undefined {
    switch (node.category) {
      case ErrorExpressionCategory.MissingIn: {
        return this._createSingleKeywordCompletionList('in');
      }
      case ErrorExpressionCategory.MissingElse: {
        return this._createSingleKeywordCompletionList('else');
      }
      case ErrorExpressionCategory.MissingExpression:
      case ErrorExpressionCategory.MissingDecoratorCallName: {
        return this._getExpressionCompletions(node, priorWord, priorText, postText);
      }
      case ErrorExpressionCategory.MissingIndexOrSlice: {
        let completionResults = this._getStringLiteralCompletions(node, priorWord, priorText, postText);
        if (!completionResults || !completionResults.completionList) completionResults = this._getExpressionCompletions(node, priorWord, priorText, postText);
        return completionResults;
      }
      case ErrorExpressionCategory.MissingMemberAccessName: {
        if (node.child && isExpressionNode(node.child)) {
          return this._getMemberAccessCompletions(node.child, priorWord);
        }
        break;
      }
      case ErrorExpressionCategory.MissingFunctionParameterList: {
        if (node.child && node.child.nodeType === ParseNodeType.Name) {
          if (node.decorators?.some((d) => this._isOverload(d))) return this._getMethodOverloadsCompletions(priorWord, node.child);

          return this._getMethodOverrideCompletions(priorWord, node.child, node.decorators);
        }
        break;
      }
    }
    return undefined;
  }
  private _isOverload(node: DecoratorNode): boolean {
    return this._checkDecorator(node, 'overload');
  }
  private _checkDecorator(node: DecoratorNode, value: string): boolean {
    return node.expression.nodeType === ParseNodeType.Name && node.expression.value === value;
  }
  private _createSingleKeywordCompletionList(keyword: string): CompletionResults {
    const completionItem = CompletionItem.create(keyword);
    completionItem.kind = CompletionItemKind.Keyword;
    completionItem.sortText = this._makeSortText(SortCategory.LikelyKeyword, keyword);
    const completionList = CompletionList.create([completionItem]);
    return { completionList };
  }
  private _getMethodOverloadsCompletions(priorWord: string, partialName: NameNode): CompletionResults | undefined {
    const symbolTable = getSymbolTable(this._evaluator, partialName);
    if (!symbolTable) return undefined;
    const funcParensDisabled = partialName.parent?.nodeType === ParseNodeType.Function ? true : undefined;
    const completionList = CompletionList.create();
    const enclosingFunc = ParseTreeUtils.getEnclosingFunction(partialName);
    symbolTable.forEach((symbol, name) => {
      const decl = getLastTypedDeclaredForSymbol(symbol);
      if (!decl || decl.type !== DeclarationType.Function) return;
      if (!decl.node.decorators.some((d) => this._isOverload(d))) {
        return;
      }
      const decls = symbol.getDeclarations();
      if (decls.length === 1 && decls.some((d) => d.node === enclosingFunc)) return;
      if (StringUtils.isPatternInSymbol(partialName.value, name)) {
        const textEdit = this._createReplaceEdits(priorWord, partialName, decl.node.name.value);
        this._addSymbol(name, symbol, partialName.value, completionList, {
          funcParensDisabled,
          edits: { textEdit },
        });
      }
    });
    return { completionList };
    function getSymbolTable(evaluator: TypeEvaluator, partialName: NameNode) {
      const enclosingClass = ParseTreeUtils.getEnclosingClass(partialName, false);
      if (enclosingClass) {
        const classResults = evaluator.getTypeOfClass(enclosingClass);
        if (!classResults) return undefined;
        const symbolTable = new Map<string, Symbol>();
        for (const mroClass of classResults.classType.details.mro) {
          if (isClass(mroClass)) {
            getMembersForClass(mroClass, symbolTable, /* includeInstanceVars */ false);
          }
        }
        return symbolTable;
      }
      const moduleNode = ParseTreeUtils.getEnclosingModule(partialName);
      if (moduleNode) {
        const moduleScope = AnalyzerNodeInfo.getScope(moduleNode);
        return moduleScope?.symbolTable;
      }
      return undefined;
    }
  }
  private _getMethodOverrideCompletions(priorWord: string, partialName: NameNode, decorators?: DecoratorNode[]): CompletionResults | undefined {
    const enclosingClass = ParseTreeUtils.getEnclosingClass(partialName, true);
    if (!enclosingClass) return undefined;
    const classResults = this._evaluator.getTypeOfClass(enclosingClass);
    if (!classResults) return undefined;
    const symbolTable = new Map<string, Symbol>();
    for (let i = 1; i < classResults.classType.details.mro.length; i++) {
      const mroClass = classResults.classType.details.mro[i];
      if (isClass(mroClass)) {
        getMembersForClass(mroClass, symbolTable, /* includeInstanceVars */ false);
      }
    }
    const staticmethod = decorators?.some((d) => this._checkDecorator(d, 'staticmethod')) ?? false;
    const classmethod = decorators?.some((d) => this._checkDecorator(d, 'classmethod')) ?? false;
    const completionList = CompletionList.create();
    symbolTable.forEach((symbol, name) => {
      let decl = getLastTypedDeclaredForSymbol(symbol);
      if (decl && decl.type === DeclarationType.Function) {
        if (StringUtils.isPatternInSymbol(partialName.value, name)) {
          const declaredType = this._evaluator.getTypeForDeclaration(decl);
          if (!declaredType) return;
          let isProperty = isObject(declaredType) && ClassType.isPropertyClass(declaredType.classType);
          if (SymbolNameUtils.isDunderName(name)) {
            isProperty = false;
          }
          if (!isFunction(declaredType) && !isProperty) return;
          if (isProperty) {
            const typedDecls = symbol.getTypedDeclarations();
            if (typedDecls.length > 0 && typedDecls[0].type === DeclarationType.Function) decl = typedDecls[0];
          }
          const isDeclaredStaticMethod = isFunction(declaredType) && FunctionType.isStaticMethod(declaredType);
          const isDeclaredClassMethod = isFunction(declaredType) && FunctionType.isClassMethod(declaredType) && name !== '__init_subclass__';
          if (staticmethod !== isDeclaredStaticMethod || classmethod !== isDeclaredClassMethod) return;
          const methodSignature = this._printMethodSignature(decl.node) + ':';
          const methodBody = this._printOverriddenMethodBody(classResults.classType, isDeclaredStaticMethod, isProperty, decl);
          const textEdit = this._createReplaceEdits(priorWord, partialName, `${methodSignature}\n${methodBody}`);
          this._addSymbol(name, symbol, partialName.value, completionList, {
            funcParensDisabled: true,
            edits: {
              format: this._options.snippet ? InsertTextFormat.Snippet : undefined,
              textEdit,
            },
          });
        }
      }
    });
    return { completionList };
  }
  private _createReplaceEdits(priorWord: string, node: ParseNode | undefined, text: string) {
    const replaceOrInsertEndChar = node?.nodeType === ParseNodeType.Name ? this._position.character - priorWord.length + node.value.length : this._position.character;
    const range: Range = {
      start: { line: this._position.line, character: this._position.character - priorWord.length },
      end: { line: this._position.line, character: replaceOrInsertEndChar },
    };
    return TextEdit.replace(range, text);
  }
  private _printMethodSignature(node: FunctionNode): string {
    const paramList = node.parameters
      .map((param, index) => {
        let paramString = '';
        if (param.category === ParameterCategory.VarArgList) paramString += '*';
        else if (param.category === ParameterCategory.VarArgDictionary) paramString += '**';
        if (param.name) paramString += param.name.value;
        const paramTypeAnnotation = this._evaluator.getTypeAnnotationForParameter(node, index);
        if (paramTypeAnnotation) paramString += ': ' + ParseTreeUtils.printExpression(paramTypeAnnotation);
        if (!paramString && !param.name && param.category === ParameterCategory.Simple) return '/';
        return paramString;
      })
      .join(', ');
    let methodSignature = node.name.value + '(' + paramList + ')';
    if (node.returnTypeAnnotation) methodSignature += ' -> ' + ParseTreeUtils.printExpression(node.returnTypeAnnotation);
    else if (node.functionAnnotationComment) methodSignature += ' -> ' + ParseTreeUtils.printExpression(node.functionAnnotationComment.returnTypeAnnotation);
    return methodSignature;
  }
  private _printOverriddenMethodBody(classType: ClassType, isStaticMethod: boolean, isProperty: boolean, decl: FunctionDeclaration) {
    let sb = '    ';
    if (classType.details.baseClasses.length === 1 && classType.details.baseClasses[0].category === TypeCategory.Class && classType.details.baseClasses[0].details.fullName === 'builtins.object') {
      sb += this._options.snippet ? '${0:pass}' : 'pass';
      return sb;
    }
    if (decl.node.parameters.length === 0) {
      sb += this._options.snippet ? '${0:pass}' : 'pass';
      return sb;
    }
    const parameters = getParameters();
    if (decl.node.name.value !== '__init__') sb += 'return ';
    if (isProperty) return sb + `super().${decl.node.name.value}`;
    return sb + `super().${decl.node.name.value}(${parameters.map(convertToString).join(', ')})`;
    function getParameters() {
      if (isStaticMethod) return decl.node.parameters.filter((p) => p.name);
      return decl.node.parameters.slice(1).filter((p) => p.name);
    }
    function convertToString(parameter: ParameterNode) {
      const name = parameter.name?.value;
      if (parameter.category === ParameterCategory.VarArgList) return `*${name}`;
      if (parameter.category === ParameterCategory.VarArgDictionary) return `**${name}`;
      return parameter.defaultValue ? `${name}=${name}` : name;
    }
  }
  private _getMemberAccessCompletions(leftExprNode: ExpressionNode, priorWord: string): CompletionResults | undefined {
    const symbolTable = new Map<string, Symbol>();
    const completionList = CompletionList.create();
    let memberAccessInfo: MemberAccessInfo = {};
    let leftType = this._evaluator.getType(leftExprNode);
    if (leftType) {
      leftType = this._evaluator.makeTopLevelTypeVarsConcrete(leftType);
      doForEachSubtype(leftType, (subtype) => {
        subtype = this._evaluator.makeTopLevelTypeVarsConcrete(transformTypeObjectToClass(subtype));
        if (isObject(subtype)) {
          getMembersForClass(subtype.classType, symbolTable, /* includeInstanceVars */ true);
        } else if (isClass(subtype)) {
          getMembersForClass(subtype, symbolTable, /* includeInstanceVars */ false);
        } else if (isModule(subtype)) {
          getMembersForModule(subtype, symbolTable);
        } else if (isFunction(subtype) || isOverloadedFunction(subtype)) {
          const functionClass = this._evaluator.getBuiltInType(leftExprNode, 'function');
          if (functionClass && isClass(functionClass)) {
            getMembersForClass(functionClass, symbolTable, /* includeInstanceVars */ true);
          }
        } else if (isNone(subtype)) {
          const objectClass = this._evaluator.getBuiltInType(leftExprNode, 'object');
          if (objectClass && isClass(objectClass)) {
            getMembersForClass(objectClass, symbolTable, TypeBase.isInstance(subtype));
          }
        }
        const boundObject = isObject(subtype) ? subtype : undefined;
        this._addSymbolsForSymbolTable(symbolTable, (_) => true, priorWord, /* isInImport */ false, boundObject, completionList);
      });
    }
    if (!leftType || isUnknown(leftType) || isUnbound(leftType)) {
      memberAccessInfo = this._getLastKnownModule(leftExprNode, leftType);
    }
    return { completionList, memberAccessInfo };
  }
  private _getLastKnownModule(leftExprNode: ExpressionNode, leftType: Type | undefined): MemberAccessInfo {
    let curNode: ExpressionNode | undefined = leftExprNode;
    let curType: Type | undefined = leftType;
    let unknownMemberName: string | undefined = leftExprNode.nodeType === ParseNodeType.MemberAccess ? leftExprNode?.memberName.value : undefined;
    while (curNode) {
      if (curNode.nodeType === ParseNodeType.Call || curNode.nodeType === ParseNodeType.MemberAccess) {
        curNode = curNode.leftExpression;
        if (unknownMemberName === undefined) unknownMemberName = curNode.nodeType === ParseNodeType.MemberAccess ? curNode?.memberName.value ?? '' : '';
      } else {
        curNode = undefined;
      }
      if (curNode) {
        curType = this._evaluator.getType(curNode);
        if (curType !== undefined && !isUnknown(curType) && !isUnbound(curType)) {
          break;
        }
      }
    }
    const memberAccessInfo: MemberAccessInfo = {};
    if (curType && !isUnknown(curType) && !isUnbound(curType) && curNode) {
      const moduleNamesForType = getDeclaringModulesForType(curType);
      memberAccessInfo.lastKnownModule = moduleNamesForType.find((n) => n !== 'typing');
      if (curNode.nodeType === ParseNodeType.MemberAccess) memberAccessInfo.lastKnownMemberName = curNode.memberName.value;
      else if (curNode.nodeType === ParseNodeType.Name && isClass(curType)) {
        memberAccessInfo.lastKnownMemberName = curType.details.name;
      } else if (curNode.nodeType === ParseNodeType.Name && isObject(curType)) {
        memberAccessInfo.lastKnownMemberName = curType.classType.details.name;
      }
      memberAccessInfo.unknownMemberName = unknownMemberName;
    }
    return memberAccessInfo;
  }
  private _getStatementCompletions(parseNode: ParseNode, priorWord: string, priorText: string, postText: string): CompletionResults | undefined {
    return this._getExpressionCompletions(parseNode, priorWord, priorText, postText);
  }
  private _getExpressionCompletions(parseNode: ParseNode, priorWord: string, priorText: string, postText: string): CompletionResults | undefined {
    if (parseNode.nodeType === ParseNodeType.Number) return undefined;
    if (parseNode.parent?.nodeType === ParseNodeType.WithItem && parseNode.parent === parseNode.parent.target?.parent) return undefined;
    const completionList = CompletionList.create();
    const completionResults = { completionList };
    this._addCallArgumentCompletions(parseNode, priorWord, priorText, postText, completionList);
    this._addSymbols(parseNode, priorWord, completionList);
    this._findMatchingKeywords(_keywords, priorWord).map((keyword) => {
      const completionItem = CompletionItem.create(keyword);
      completionItem.kind = CompletionItemKind.Keyword;
      completionList.items.push(completionItem);
      completionItem.sortText = this._makeSortText(SortCategory.Keyword, keyword);
    });
    if (this._configOptions.autoImportCompletions && !priorWord.startsWith('_') && !this._itemToResolve) {
      this._getAutoImportCompletions(priorWord, similarityLimit, this._options.lazyEdit, completionResults);
    }
    if (parseNode.nodeType === ParseNodeType.Error) {
      if (parseNode.category === ErrorExpressionCategory.MissingIndexOrSlice) this._getIndexStringLiteral(parseNode, completionList);
      else if (parseNode.category === ErrorExpressionCategory.MissingExpression) {
        if (parseNode.parent && parseNode.parent.nodeType === ParseNodeType.Assignment) {
          const declaredTypeOfTarget = this._evaluator.getDeclaredTypeForExpression(parseNode.parent.leftExpression);
          if (declaredTypeOfTarget) this._addLiteralValuesForTargetType(declaredTypeOfTarget, priorText, postText, completionList);
        }
      }
    }
    return completionResults;
  }
  private _addCallArgumentCompletions(parseNode: ParseNode, priorWord: string, priorText: string, postText: string, completionList: CompletionList) {
    const offset = convertPositionToOffset(this._position, this._parseResults.tokenizerOutput.lines)!;
    const callInfo = getCallNodeAndActiveParameterIndex(parseNode, offset, this._parseResults.tokenizerOutput.tokens);
    if (!callInfo) return;
    const signatureInfo = this._evaluator.getCallSignatureInfo(callInfo.callNode, callInfo.activeIndex, callInfo.activeOrFake);
    if (signatureInfo) {
      const callNameEnd = convertOffsetToPosition(signatureInfo.callNode.leftExpression.start + signatureInfo.callNode.leftExpression.length, this._parseResults.tokenizerOutput.lines);
      if (comparePositions(this._position, callNameEnd) > 0) {
        this._addNamedParameters(signatureInfo, priorWord, completionList);
        this._addLiteralValuesForArgument(signatureInfo, priorText, postText, completionList);
      }
    }
  }
  private _addLiteralValuesForArgument(signatureInfo: CallSignatureInfo, priorText: string, postText: string, completionList: CompletionList) {
    signatureInfo.signatures.forEach((signature) => {
      if (!signature.activeParam) return undefined;
      const type = signature.type;
      const paramIndex = type.details.parameters.indexOf(signature.activeParam);
      if (paramIndex < 0) return undefined;
      const paramType = type.details.parameters[paramIndex].type;
      this._addLiteralValuesForTargetType(paramType, priorText, postText, completionList);
      return undefined;
    });
  }
  private _addLiteralValuesForTargetType(type: Type, priorText: string, postText: string, completionList: CompletionList) {
    const quoteValue = this._getQuoteValueFromPriorText(priorText);
    doForEachSubtype(type, (subtype) => {
      if (isObject(subtype) && ClassType.isBuiltIn(subtype.classType, 'str') && subtype.classType.literalValue !== undefined) {
        this._addStringLiteralToCompletionList(subtype.classType.literalValue as string, quoteValue.stringValue, postText, quoteValue.quoteCharacter, completionList);
      }
    });
  }
  private _getStringLiteralCompletions(parseNode: StringNode | ErrorNode, priorWord: string, priorText: string, postText: string): CompletionResults | undefined {
    let parentNode: ParseNode | undefined = parseNode.parent;
    if (!parentNode) return undefined;
    if (parentNode.nodeType !== ParseNodeType.Argument) {
      if (parentNode.nodeType !== ParseNodeType.StringList || parentNode.strings.length > 1) return undefined;

      parentNode = parentNode.parent;
      if (!parentNode) return undefined;
    }
    const completionList = CompletionList.create();
    if (parentNode.nodeType === ParseNodeType.Argument && parentNode.parent?.nodeType === ParseNodeType.Index) {
      const baseType = this._evaluator.getType(parentNode.parent.baseExpression);
      if (!baseType || !isObject(baseType)) {
        return undefined;
      }
      const classType = baseType.classType;
      if (!ClassType.isTypedDictClass(classType)) return;
      const entries = this._evaluator.getTypedDictMembersForClass(classType, /* allowNarrowed */ true);
      const quoteValue = this._getQuoteValueFromPriorText(priorText);
      entries.forEach((_, key) => {
        this._addStringLiteralToCompletionList(key, quoteValue.stringValue, postText, quoteValue.quoteCharacter, completionList);
      });
    } else if (parentNode.nodeType === ParseNodeType.Assignment) {
      const declaredTypeOfTarget = this._evaluator.getDeclaredTypeForExpression(parentNode.leftExpression);
      if (declaredTypeOfTarget) this._addLiteralValuesForTargetType(declaredTypeOfTarget, priorText, postText, completionList);
    } else {
      debug.assert(parseNode.nodeType === ParseNodeType.String);
      const offset = convertPositionToOffset(this._position, this._parseResults.tokenizerOutput.lines)!;
      if (offset <= parentNode.start || TextRange.getEnd(parseNode) <= offset) {
        this._addCallArgumentCompletions(parseNode, priorWord, priorText, postText, completionList);
      }
    }
    return { completionList };
  }
  private _getQuoteValueFromPriorText(priorText: string) {
    const lastSingleQuote = priorText.lastIndexOf("'");
    const lastDoubleQuote = priorText.lastIndexOf('"');
    let quoteCharacter = this._parseResults.tokenizerOutput.predominantSingleQuoteCharacter;
    let stringValue = undefined;
    if (lastSingleQuote > lastDoubleQuote) {
      quoteCharacter = "'";
      stringValue = priorText.substr(lastSingleQuote + 1);
    } else if (lastDoubleQuote > lastSingleQuote) {
      quoteCharacter = '"';
      stringValue = priorText.substr(lastDoubleQuote + 1);
    }
    return { stringValue, quoteCharacter };
  }
  private _getIndexStringLiteral(parseNode: ErrorNode, completionList: CompletionList) {
    if (!parseNode.parent || parseNode.parent.nodeType !== ParseNodeType.Index) return;
    const baseType = this._evaluator.getType(parseNode.parent.baseExpression);
    if (!baseType || !isObject(baseType)) return;
    const classType = baseType.classType;
    if (!ClassType.isTypedDictClass(classType)) return;
    const entries = this._evaluator.getTypedDictMembersForClass(classType, /* allowNarrowed */ true);
    entries.forEach((_, key) => {
      this._addStringLiteralToCompletionList(key, undefined, undefined, this._parseResults.tokenizerOutput.predominantSingleQuoteCharacter, completionList);
    });
  }
  private _addStringLiteralToCompletionList(value: string, priorString: string | undefined, postText: string | undefined, quoteCharacter: string, completionList: CompletionList) {
    if (StringUtils.isPatternInSymbol(priorString || '', value)) {
      const valueWithQuotes = `${quoteCharacter}${value}${quoteCharacter}`;
      const completionItem = CompletionItem.create(valueWithQuotes);
      completionItem.kind = CompletionItemKind.Constant;
      completionItem.sortText = this._makeSortText(SortCategory.LiteralValue, valueWithQuotes);
      let rangeStartCol = this._position.character;
      if (priorString !== undefined) rangeStartCol -= priorString.length + 1;
      let rangeEndCol = this._position.character;
      if (postText !== undefined) {
        if (postText.startsWith(quoteCharacter)) rangeEndCol++;
      }
      const range: Range = {
        start: { line: this._position.line, character: rangeStartCol },
        end: { line: this._position.line, character: rangeEndCol },
      };
      completionItem.textEdit = TextEdit.replace(range, valueWithQuotes);
      completionList.items.push(completionItem);
    }
  }
  private _getAutoImportCompletions(priorWord: string, similarityLimit: number, lazyEdit: boolean, completionResults: CompletionResults) {
    if (!this._autoImportMaps) return;
    const completionList = completionResults.completionList;
    if (!completionList) return;
    const moduleSymbolMap = this._autoImportMaps.getModuleSymbolsMap();
    const excludes = new Set(completionList.items.filter((i) => !i.data?.autoImport).map((i) => i.label));
    const autoImporter = new AutoImporter(this._configOptions.findExecEnvironment(this._filePath), this._importResolver, this._parseResults, this._position, excludes, moduleSymbolMap, {
      libraryMap: this._autoImportMaps.libraryMap,
      lazyEdit,
    });
    const results: AutoImportResult[] = [];
    const info = this._autoImportMaps.nameMap?.get(priorWord);
    if (info && priorWord.length > 1 && !excludes.has(priorWord)) {
      results.push(...autoImporter.getAutoImportCandidatesForAbbr(priorWord, info, this._cancellationToken));
    }
    results.push(...autoImporter.getAutoImportCandidates(priorWord, similarityLimit, undefined, this._cancellationToken));
    const perfInfo = autoImporter.getPerfInfo();
    const additionDuration = new Duration();
    for (const result of results) {
      if (result.symbol) {
        this._addSymbol(result.name, result.symbol, priorWord, completionList, {
          autoImportSource: result.source,
          autoImportAlias: result.alias,
          edits: {
            textEdit: this._createReplaceEdits(priorWord, undefined, result.insertionText),
            additionalTextEdits: result.edits,
          },
        });
      } else {
        this._addNameToCompletionList(result.alias ?? result.name, result.kind ?? CompletionItemKind.Module, priorWord, completionList, {
          autoImportText: this._getAutoImportText(result.name, result.source, result.alias),
          edits: {
            textEdit: this._createReplaceEdits(priorWord, undefined, result.insertionText),
            additionalTextEdits: result.edits,
          },
        });
      }
    }
    completionResults.autoImportInfo = {
      indexUsed: perfInfo.indexUsed,
      totalTimeInMS: perfInfo.totalInMs,
      moduleTimeInMS: perfInfo.moduleTimeInMS,
      indexTimeInMS: perfInfo.indexTimeInMS,
      importAliasTimeInMS: perfInfo.importAliasTimeInMS,
      itemCount: results.length,
      symbolCount: perfInfo.symbolCount,
      userIndexCount: perfInfo.userIndexCount,
      indexCount: perfInfo.indexCount,
      importAliasCount: perfInfo.userIndexCount,
      editTimeInMS: perfInfo.editTimeInMS,
      moduleResolveTimeInMS: perfInfo.moduleResolveTimeInMS,
      additionTimeInMS: additionDuration.getDurationInMilliseconds(),
    };
  }
  private _getImportFromCompletions(importFromNode: ImportFromNode, priorWord: string): CompletionResults | undefined {
    if (importFromNode.isWildcardImport) return undefined;
    const importInfo = AnalyzerNodeInfo.getImportInfo(importFromNode.module);
    if (!importInfo) return undefined;
    const completionList = CompletionList.create();
    const resolvedPath = importInfo.resolvedPaths.length > 0 ? importInfo.resolvedPaths[importInfo.resolvedPaths.length - 1] : '';
    const lookupResults = this._importLookup(resolvedPath);
    if (lookupResults) {
      this._addSymbolsForSymbolTable(
        lookupResults.symbolTable,
        (name) => {
          return !importFromNode.imports.find((imp) => imp.name.value === name);
        },
        priorWord,
        /* isInImport */ true,
        /* boundObject */ undefined,
        completionList
      );
    }
    importInfo.implicitImports.forEach((implImport) => {
      if (!importFromNode.imports.find((imp) => imp.name.value === implImport.name)) {
        this._addNameToCompletionList(implImport.name, CompletionItemKind.Module, priorWord, completionList);
      }
    });
    return { completionList };
  }
  private _findMatchingKeywords(keywordList: string[], partialMatch: string): string[] {
    return keywordList.filter((keyword) => {
      if (partialMatch) return StringUtils.isPatternInSymbol(partialMatch, keyword);
      else return true;
    });
  }
  private _addNamedParameters(signatureInfo: CallSignatureInfo, priorWord: string, completionList: CompletionList) {
    const argNameMap = new Map<string, string>();
    signatureInfo.signatures.forEach((signature) => {
      this._addNamedParametersToMap(signature.type, argNameMap);
    });
    signatureInfo.callNode.arguments!.forEach((arg) => {
      if (arg.name) argNameMap.delete(arg.name.value);
    });
    argNameMap.forEach((argName) => {
      if (StringUtils.isPatternInSymbol(priorWord, argName)) {
        const completionItem = CompletionItem.create(argName + '=');
        completionItem.kind = CompletionItemKind.Variable;
        const completionItemData: CompletionItemData = {
          workspacePath: this._workspacePath,
          filePath: this._filePath,
          position: this._position,
        };
        completionItem.data = completionItemData;
        completionItem.sortText = this._makeSortText(SortCategory.NamedParameter, argName);
        completionList.items.push(completionItem);
      }
    });
  }
  private _addNamedParametersToMap(type: FunctionType, paramMap: Map<string, string>) {
    type.details.parameters.forEach((param) => {
      if (param.name && !param.isNameSynthesized) {
        if (!SymbolNameUtils.isPrivateOrProtectedName(param.name)) paramMap.set(param.name, param.name);
      }
    });
  }
  private _addSymbols(node: ParseNode, priorWord: string, completionList: CompletionList) {
    let curNode: ParseNode | undefined = node;
    while (curNode) {
      let scope = AnalyzerNodeInfo.getScope(curNode);
      if (scope) {
        while (scope) {
          this._addSymbolsForSymbolTable(scope.symbolTable, () => true, priorWord, /* isInImport */ false, /* boundObject */ undefined, completionList);
          scope = scope.parent;
        }
        if (curNode.nodeType === ParseNodeType.Class) {
          const classType = this._evaluator.getTypeOfClass(curNode);
          if (classType && isClass(classType.classType)) {
            classType.classType.details.mro.forEach((baseClass, index) => {
              if (isClass(baseClass)) {
                this._addSymbolsForSymbolTable(
                  baseClass.details.fields,
                  (name) => {
                    const symbol = baseClass.details.fields.get(name);
                    if (!symbol || !symbol.isClassMember()) {
                      return false;
                    }
                    return symbol.getDeclarations().some((decl) => decl.type === DeclarationType.Variable);
                  },
                  priorWord,
                  /* isInImport */ false,
                  /* boundObject */ undefined,
                  completionList
                );
              }
            });
          }
        }
        break;
      }
      curNode = curNode.parent;
    }
  }
  private _addSymbolsForSymbolTable(
    symbolTable: SymbolTable,
    includeSymbolCallback: (name: string) => boolean,
    priorWord: string,
    isInImport: boolean,
    boundObject: ObjectType | undefined,
    completionList: CompletionList
  ) {
    symbolTable.forEach((symbol, name) => {
      const hidden = symbol.isExternallyHidden() && !symbol.getDeclarations().some((d) => this._definedInCurrentFile(d));
      if (!hidden && includeSymbolCallback(name)) {
        if (!completionList.items.some((item) => item.label === name)) {
          this._addSymbol(name, symbol, priorWord, completionList, {
            boundObject,
            funcParensDisabled: isInImport,
          });
        }
      }
    });
  }
  private _definedInCurrentFile(decl: Declaration) {
    if (isAliasDeclaration(decl)) {
      return getFileInfo(decl.node)?.filePath === this._filePath;
    }
    return decl.path === this._filePath;
    function getFileInfo(node: ParseNode | undefined) {
      while (node && node.nodeType !== ParseNodeType.Module) {
        node = node.parent;
      }
      return node ? AnalyzerNodeInfo.getFileInfo(node) : undefined;
    }
  }
  private _addSymbol(name: string, symbol: Symbol, priorWord: string, completionList: CompletionList, detail: SymbolDetail) {
    let primaryDecl = getLastTypedDeclaredForSymbol(symbol);
    if (!primaryDecl) {
      const declarations = symbol.getDeclarations();
      if (declarations.length > 0) primaryDecl = declarations[declarations.length - 1];
    }
    if (primaryDecl) {
      let itemKind: CompletionItemKind = CompletionItemKind.Variable;
      primaryDecl = this._evaluator.resolveAliasDeclaration(primaryDecl, /* resolveLocalNames */ true);
      if (primaryDecl) {
        itemKind = this._convertDeclarationTypeToItemKind(primaryDecl);
        if (this._itemToResolve) {
          const completionItemData = this._itemToResolve.data as CompletionItemData;
          if (completionItemData.symbolLabel === name && !completionItemData.autoImportText) {
            const type = this._evaluator.getEffectiveTypeOfSymbol(symbol);
            if (type) {
              let typeDetail: string | undefined;
              let documentation: string | undefined;
              switch (primaryDecl.type) {
                case DeclarationType.Intrinsic:
                case DeclarationType.Variable:
                case DeclarationType.Parameter: {
                  let expandTypeAlias = false;
                  if (type && TypeBase.isInstantiable(type)) {
                    const typeAliasInfo = getTypeAliasInfo(type);
                    if (typeAliasInfo) {
                      if (typeAliasInfo.name === name) expandTypeAlias = true;
                    }
                  }
                  typeDetail = name + ': ' + this._evaluator.printType(type, expandTypeAlias);
                  break;
                }
                case DeclarationType.Function: {
                  const functionType = detail.boundObject && (isFunction(type) || isOverloadedFunction(type)) ? this._evaluator.bindFunctionToClassOrObject(detail.boundObject, type) : type;
                  if (functionType) {
                    if (isProperty(functionType) && detail.boundObject) {
                      const propertyType = this._evaluator.getGetterTypeFromProperty(functionType.classType, /* inferTypeIfNeeded */ true) || UnknownType.create();
                      typeDetail = name + ': ' + this._evaluator.printType(propertyType, /* expandTypeAlias */ false) + ' (property)';
                    } else if (isOverloadedFunction(functionType)) {
                      typeDetail = getOverloadedFunctionTooltip(functionType, this._evaluator, /* columnThreshold */ 35);
                    } else {
                      typeDetail = name + ': ' + this._evaluator.printType(functionType, /* expandTypeAlias */ false);
                    }
                  }
                  break;
                }
                case DeclarationType.Class:
                case DeclarationType.SpecialBuiltInClass: {
                  typeDetail = 'class ' + name + '()';
                  break;
                }
                case DeclarationType.Alias: {
                  typeDetail = name;
                  if (primaryDecl.path) {
                    const lookupResults = this._importLookup(primaryDecl.path);
                    if (lookupResults) documentation = lookupResults.docString;
                  }
                  break;
                }
                default: {
                  typeDetail = name;
                  break;
                }
              }
              if (isModule(type)) {
                documentation = getModuleDocString(type, primaryDecl, this._sourceMapper);
              } else if (isClass(type)) {
                documentation = getClassDocString(type, primaryDecl, this._sourceMapper);
              } else if (isFunction(type)) {
                const enclosingClass = isFunctionDeclaration(primaryDecl) ? ParseTreeUtils.getEnclosingClass(primaryDecl.node.name, false) : undefined;
                const classResults = enclosingClass ? this._evaluator.getTypeOfClass(enclosingClass) : undefined;
                documentation = getFunctionDocStringInherited(type, primaryDecl, this._sourceMapper, classResults?.classType);
              } else if (isOverloadedFunction(type)) {
                const enclosingClass = isFunctionDeclaration(primaryDecl) ? ParseTreeUtils.getEnclosingClass(primaryDecl.node.name, false) : undefined;
                const classResults = enclosingClass ? this._evaluator.getTypeOfClass(enclosingClass) : undefined;
                documentation = getOverloadedFunctionDocStringsInherited(type, primaryDecl, this._sourceMapper, this._evaluator, classResults?.classType).find((doc) => doc);
              } else if (primaryDecl?.type === DeclarationType.Function) {
                const enclosingClass = isFunctionDeclaration(primaryDecl) ? ParseTreeUtils.getEnclosingClass(primaryDecl.node.name, false) : undefined;
                const classResults = enclosingClass ? this._evaluator.getTypeOfClass(enclosingClass) : undefined;
                if (classResults) documentation = getPropertyDocStringInherited(primaryDecl, this._sourceMapper, this._evaluator, classResults?.classType);
              }
              if (this._options.format === MarkupKind.Markdown) {
                let markdownString = '```python\n' + typeDetail + '\n```\n';
                if (documentation) {
                  markdownString += '---\n';
                  markdownString += convertDocStringToMarkdown(documentation);
                }
                this._itemToResolve.documentation = {
                  kind: MarkupKind.Markdown,
                  value: markdownString,
                };
              } else if (this._options.format === MarkupKind.PlainText) {
                let plainTextString = typeDetail + '\n';
                if (documentation) {
                  plainTextString += '\n';
                  plainTextString += convertDocStringToPlainText(documentation);
                }
                this._itemToResolve.documentation = {
                  kind: MarkupKind.PlainText,
                  value: plainTextString,
                };
              } else {
                fail(`Unsupported markup type: ${this._options.format}`);
              }
            }
          }
        }
      }
      const autoImportText = detail.autoImportSource ? this._getAutoImportText(name, detail.autoImportSource, detail.autoImportAlias) : undefined;
      this._addNameToCompletionList(detail.autoImportAlias ?? name, itemKind, priorWord, completionList, {
        autoImportText,
        funcParensDisabled: detail.funcParensDisabled,
        edits: detail.edits,
      });
    } else {
      const synthesizedType = symbol.getSynthesizedType();
      if (synthesizedType) {
        const itemKind: CompletionItemKind = CompletionItemKind.Variable;
        this._addNameToCompletionList(name, itemKind, priorWord, completionList, {
          funcParensDisabled: detail.funcParensDisabled,
          edits: detail.edits,
        });
      }
    }
  }
  private _getAutoImportText(importName: string, importFrom?: string, importAlias?: string) {
    let autoImportText: string | undefined;
    if (!importFrom) autoImportText = `import ${importName}`;
    else autoImportText = `from ${importFrom} import ${importName}`;

    if (importAlias) autoImportText = `${autoImportText} as ${importAlias}`;
    if (this._options.format === MarkupKind.Markdown) return `\`\`\`\n${autoImportText}\n\`\`\``;
    else if (this._options.format === MarkupKind.PlainText) return autoImportText;
    else {
      fail(`Unsupported markup type: ${this._options.format}`);
    }
  }
  private _addNameToCompletionList(name: string, itemKind: CompletionItemKind, filter: string, completionList: CompletionList, detail?: CompletionDetail) {
    const similarity = detail?.autoImportText ? true : StringUtils.isPatternInSymbol(filter, name);
    if (!similarity) return;
    const completionItem = CompletionItem.create(name);
    completionItem.kind = itemKind;
    const completionItemData: CompletionItemData = {
      workspacePath: this._workspacePath,
      filePath: this._filePath,
      position: this._position,
    };
    if (detail?.funcParensDisabled) completionItemData.funcParensDisabled = true;
    completionItem.data = completionItemData;
    if (detail?.autoImportText) {
      completionItem.sortText = this._makeSortText(SortCategory.AutoImport, name, detail.autoImportText);
      completionItemData.autoImportText = detail.autoImportText;
      completionItem.detail = 'Auto-import';
    } else if (SymbolNameUtils.isDunderName(name)) {
      completionItem.sortText = this._makeSortText(SortCategory.DunderSymbol, name);
    } else if (filter === '' && SymbolNameUtils.isPrivateOrProtectedName(name)) {
      completionItem.sortText = this._makeSortText(SortCategory.PrivateSymbol, name);
    } else {
      completionItem.sortText = this._makeSortText(SortCategory.NormalSymbol, name);
    }
    completionItemData.symbolLabel = name;
    if (this._options.format === MarkupKind.Markdown) {
      let markdownString = '';
      if (detail?.autoImportText) markdownString += detail.autoImportText + '\n\n';
      if (detail?.typeDetail) markdownString += '```python\n' + detail.typeDetail + '\n```\n';
      if (detail?.documentation) {
        markdownString += '---\n';
        markdownString += convertDocStringToMarkdown(detail.documentation);
      }
      markdownString = markdownString.trimEnd();
      if (markdownString) completionItem.documentation = { kind: MarkupKind.Markdown, value: markdownString };
    } else if (this._options.format === MarkupKind.PlainText) {
      let plainTextString = '';
      if (detail?.autoImportText) plainTextString += detail.autoImportText + '\n\n';
      if (detail?.typeDetail) plainTextString += detail.typeDetail + '\n';
      if (detail?.documentation) plainTextString += '\n' + convertDocStringToPlainText(detail.documentation);
      plainTextString = plainTextString.trimEnd();
      if (plainTextString) completionItem.documentation = { kind: MarkupKind.PlainText, value: plainTextString };
    } else {
      fail(`Unsupported markup type: ${this._options.format}`);
    }
    if (detail?.edits?.format) completionItem.insertTextFormat = detail.edits.format;
    if (detail?.edits?.textEdit) completionItem.textEdit = detail.edits.textEdit;
    if (detail?.edits?.additionalTextEdits) {
      completionItem.additionalTextEdits = detail.edits.additionalTextEdits.map((te) => {
        const textEdit: TextEdit = {
          range: {
            start: { line: te.range.start.line, character: te.range.start.character },
            end: { line: te.range.end.line, character: te.range.end.character },
          },
          newText: te.replacementText,
        };
        return textEdit;
      });
      if (this._itemToResolve) {
        const data = this._itemToResolve.data as CompletionItemData;
        if (data.autoImportText === completionItemData.autoImportText) this._itemToResolve.additionalTextEdits = completionItem.additionalTextEdits;
      }
    }
    completionList.items.push(completionItem);
  }
  private _getRecentListIndex(name: string, autoImportText: string) {
    return CompletionProvider._mostRecentCompletions.findIndex((item) => item.label === name && item.autoImportText === autoImportText);
  }
  private _makeSortText(c: SortCategory, name: string, autoImportText = ''): string {
    const recentListIndex = this._getRecentListIndex(name, autoImportText);
    if (recentListIndex >= 0) {
      if (c === SortCategory.AutoImport) c = SortCategory.RecentAutoImport;
      else if (c === SortCategory.ImportModuleName) c = SortCategory.RecentImportModuleName;
      else if (c === SortCategory.Keyword || c === SortCategory.NormalSymbol || c === SortCategory.PrivateSymbol || c === SortCategory.DunderSymbol) c = SortCategory.RecentKeywordOrSymbol;
    }
    return this._formatInteger(c, 2) + '.' + this._formatInteger(recentListIndex, 4) + '.' + name;
  }
  private _formatInteger(val: number, digits: number): string {
    const charCodeZero = '0'.charCodeAt(0);
    let result = '';
    for (let i = 0; i < digits; i++) {
      let digit = Math.floor(val % 10);
      if (digit < 0) digit = 9;
      result = String.fromCharCode(digit + charCodeZero) + result;
      val = Math.floor(val / 10);
    }
    return result;
  }
  private _convertDeclarationTypeToItemKind(declaration: Declaration): CompletionItemKind {
    const resolvedDeclaration = this._evaluator.resolveAliasDeclaration(declaration, /* resolveLocalNames */ true);
    if (!resolvedDeclaration) return CompletionItemKind.Variable;
    switch (resolvedDeclaration.type) {
      case DeclarationType.Intrinsic:
        return resolvedDeclaration.intrinsicType === 'class' ? CompletionItemKind.Class : CompletionItemKind.Variable;
      case DeclarationType.Parameter:
        return CompletionItemKind.Variable;
      case DeclarationType.Variable:
        return resolvedDeclaration.isConstant || resolvedDeclaration.isFinal ? CompletionItemKind.Constant : CompletionItemKind.Variable;
      case DeclarationType.Function: {
        if (this._isPossiblePropertyDeclaration(resolvedDeclaration)) {
          const functionType = this._evaluator.getTypeOfFunction(resolvedDeclaration.node);
          if (functionType && isProperty(functionType.decoratedType)) {
            return CompletionItemKind.Property;
          }
        }
        return resolvedDeclaration.isMethod ? CompletionItemKind.Method : CompletionItemKind.Function;
      }
      case DeclarationType.Class:
      case DeclarationType.SpecialBuiltInClass:
        return CompletionItemKind.Class;
      case DeclarationType.Alias:
        return CompletionItemKind.Module;
    }
  }
  private _getImportModuleCompletions(node: ModuleNameNode): CompletionResults {
    const execEnvironment = this._configOptions.findExecEnvironment(this._filePath);
    const moduleDescriptor: ImportedModuleDescriptor = {
      leadingDots: node.leadingDots,
      hasTrailingDot: node.hasTrailingDot,
      nameParts: node.nameParts.map((part) => part.value),
      importedSymbols: [],
    };
    const completions = this._importResolver.getCompletionSuggestions(this._filePath, execEnvironment, moduleDescriptor, similarityLimit);
    const completionList = CompletionList.create();
    if (!node.hasTrailingDot && node.parent && node.parent.nodeType === ParseNodeType.ImportFrom && node.parent.missingImportKeyword) {
      const keyword = 'import';
      const completionItem = CompletionItem.create(keyword);
      completionItem.kind = CompletionItemKind.Keyword;
      completionList.items.push(completionItem);
      completionItem.sortText = this._makeSortText(SortCategory.Keyword, keyword);
    }
    completions.forEach((completionName) => {
      const completionItem = CompletionItem.create(completionName);
      completionItem.kind = CompletionItemKind.Module;
      completionList.items.push(completionItem);
      completionItem.sortText = this._makeSortText(SortCategory.ImportModuleName, completionName);
    });
    return { completionList };
  }
  private _isPossiblePropertyDeclaration(decl: FunctionDeclaration) {
    return decl.isMethod && decl.node.decorators.length > 0;
  }
}
