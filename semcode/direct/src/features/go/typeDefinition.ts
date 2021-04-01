import cp = require('child_process');
import * as path from 'path';
import * as qv from 'vscode';
import { getGoConfig } from '../../../../old/go/config';
import { adjustWordPosition, definitionLocation, parseMissingError } from './go/definition';
import { toolExecutionEnvironment } from '../../../../old/go/goEnv';
import { promptForMissingTool } from '../../../../old/go/goInstallTools';
import { byteOffsetAt, canonicalizeGOPATHPrefix, getBinPath, getFileArchive, goBuiltinTypes } from '../../../../old/go/util';
import { killProcessTree } from './utils/processUtils';

interface GuruDescribeOutput {
  desc: string;
  pos: string;
  detail: string;
  value: GuruDescribeValueOutput;
}

interface GuruDescribeValueOutput {
  type: string;
  value: string;
  objpos: string;
  typespos: GuruDefinitionOutput[];
}

interface GuruDefinitionOutput {
  objpos: string;
  desc: string;
}

export class GoTypeDefinitionProvider implements qv.TypeDefinitionProvider {
  public provideTypeDefinition(document: qv.TextDocument, position: qv.Position, token: qv.CancellationToken): qv.ProviderResult<qv.Definition> {
    const adjustedPos = adjustWordPosition(document, position);
    if (!adjustedPos[0]) {
      return Promise.resolve(null);
    }
    position = adjustedPos[2];

    return new Promise<qv.Definition>((resolve, reject) => {
      const goGuru = getBinPath('guru');
      if (!path.isAbsolute(goGuru)) {
        promptForMissingTool('guru');
        return reject('Cannot find tool "guru" to find type definitions.');
      }

      const filename = canonicalizeGOPATHPrefix(document.fileName);
      const offset = byteOffsetAt(document, position);
      const env = toolExecutionEnvironment();
      const buildTags = getGoConfig(document.uri)['buildTags'];
      const args = buildTags ? ['-tags', buildTags] : [];
      args.push('-json', '-modified', 'describe', `${filename}:#${offset.toString()}`);

      const process = cp.execFile(goGuru, args, { env }, (guruErr, stdout) => {
        try {
          if (guruErr && (<any>guruErr).code === 'ENOENT') {
            promptForMissingTool('guru');
            return resolve(null);
          }

          if (guruErr) {
            return reject(guruErr);
          }

          const guruOutput = <GuruDescribeOutput>JSON.parse(stdout.toString());
          if (!guruOutput.value || !guruOutput.value.typespos) {
            if (guruOutput.value && guruOutput.value.type && !goBuiltinTypes.has(guruOutput.value.type) && guruOutput.value.type !== 'invalid type') {
              console.log("no typespos from guru's output - try to update guru tool");
            }

            // Fall back to position of declaration
            return definitionLocation(document, position, null, false, token).then(
              (definitionInfo) => {
                if (definitionInfo === null || definitionInfo.file === null) {
                  return null;
                }
                const definitionResource = qv.Uri.file(definitionInfo.file);
                const pos = new qv.Position(definitionInfo.line, definitionInfo.column);
                resolve(new qv.Location(definitionResource, pos));
              },
              (err) => {
                const miss = parseMissingError(err);
                if (miss[0]) {
                  promptForMissingTool(miss[1]);
                } else if (err) {
                  return Promise.reject(err);
                }
                return Promise.resolve(null);
              }
            );
          }

          const results: qv.Location[] = [];
          guruOutput.value.typespos.forEach((ref) => {
            const match = /^(.*):(\d+):(\d+)/.exec(ref.objpos);
            if (!match) {
              return;
            }
            const [, file, line, col] = match;
            const referenceResource = qv.Uri.file(file);
            const pos = new qv.Position(parseInt(line, 10) - 1, parseInt(col, 10) - 1);
            results.push(new qv.Location(referenceResource, pos));
          });

          resolve(results);
        } catch (e) {
          reject(e);
        }
      });
      if (process.pid) {
        process.stdin.end(getFileArchive(document));
      }
      token.onCancellationRequested(() => killProcessTree(process));
    });
  }
}