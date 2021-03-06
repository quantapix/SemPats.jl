import * as qv from 'vscode';
import type * as qp from '../server/proto';
import * as qk from './key';

export function snippetForFunctionCall(
  item: { insertText?: string | qv.SnippetString; label: string },
  displayParts: ReadonlyArray<qp.SymbolDisplayPart>
): { snippet: qv.SnippetString; parameterCount: number } {
  if (item.insertText && typeof item.insertText !== 'string') return { snippet: item.insertText, parameterCount: 0 };

  const parameterListParts = getParameterListParts(displayParts);
  const snippet = new qv.SnippetString();
  snippet.appendText(`${item.insertText || item.label}(`);
  appendJoinedPlaceholders(snippet, parameterListParts.parts, ', ');
  if (parameterListParts.hasOptionalParameters) snippet.appendTabstop();
  snippet.appendText(')');
  snippet.appendTabstop(0);
  return { snippet, parameterCount: parameterListParts.parts.length + (parameterListParts.hasOptionalParameters ? 1 : 0) };
}

function appendJoinedPlaceholders(snippet: qv.SnippetString, parts: ReadonlyArray<qp.SymbolDisplayPart>, joiner: string) {
  for (let i = 0; i < parts.length; ++i) {
    const paramterPart = parts[i];
    snippet.appendPlaceholder(paramterPart.text);
    if (i !== parts.length - 1) snippet.appendText(joiner);
  }
}

interface ParamterListParts {
  readonly parts: ReadonlyArray<qp.SymbolDisplayPart>;
  readonly hasOptionalParameters: boolean;
}

function getParameterListParts(displayParts: ReadonlyArray<qp.SymbolDisplayPart>): ParamterListParts {
  const parts: qp.SymbolDisplayPart[] = [];
  let isInMethod = false;
  let hasOptionalParameters = false;
  let parenCount = 0;
  let braceCount = 0;

  outer: for (let i = 0; i < displayParts.length; ++i) {
    const part = displayParts[i];
    switch (part.kind) {
      case qk.DisplayPartKind.methodName:
      case qk.DisplayPartKind.functionName:
      case qk.DisplayPartKind.text:
      case qk.DisplayPartKind.propertyName:
        if (parenCount === 0 && braceCount === 0) isInMethod = true;
        break;

      case qk.DisplayPartKind.parameterName:
        if (parenCount === 1 && braceCount === 0 && isInMethod) {
          const next = displayParts[i + 1];

          const nameIsFollowedByOptionalIndicator = next && next.text === '?';

          const nameIsThis = part.text === 'this';
          if (!nameIsFollowedByOptionalIndicator && !nameIsThis) parts.push(part);
          hasOptionalParameters = hasOptionalParameters || nameIsFollowedByOptionalIndicator;
        }
        break;

      case qk.DisplayPartKind.punctuation:
        if (part.text === '(') {
          ++parenCount;
        } else if (part.text === ')') {
          --parenCount;
          if (parenCount <= 0 && isInMethod) break outer;
        } else if (part.text === '...' && parenCount === 1) {
          hasOptionalParameters = true;
          break outer;
        } else if (part.text === '{') {
          ++braceCount;
        } else if (part.text === '}') {
          --braceCount;
        }
        break;
    }
  }

  return { hasOptionalParameters, parts };
}
