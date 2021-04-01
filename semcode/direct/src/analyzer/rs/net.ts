const fetch = require('node-fetch') as typeof import('node-fetch')['default'];

import * as qv from 'vscode';
import * as stream from 'stream';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as util from 'util';
import * as path from 'path';
import { log, assert } from './util';

const pipeline = util.promisify(stream.pipeline);

const GITHUB_API_ENDPOINT_URL = 'https://api.github.com';
const OWNER = 'rust-analyzer';
const REPO = 'rust-analyzer';

export async function fetchRelease(releaseTag: string): Promise<GithubRelease> {
  const apiEndpointPath = `/repos/${OWNER}/${REPO}/releases/tags/${releaseTag}`;

  const requestUrl = GITHUB_API_ENDPOINT_URL + apiEndpointPath;

  log.debug('Issuing request for released artifacts metadata to', requestUrl);

  const response = await fetch(requestUrl, { headers: { Accept: 'application/vnd.github.v3+json' } });

  if (!response.ok) {
    log.error('Error fetching artifact release info', {
      requestUrl,
      releaseTag,
      response: {
        headers: response.headers,
        status: response.status,
        body: await response.text(),
      },
    });

    throw new Error(`Got response ${response.status} when trying to fetch ` + `release info for ${releaseTag} release`);
  }

  const release: GithubRelease = await response.json();
  return release;
}

export interface GithubRelease {
  name: string;
  id: number;

  published_at: string;
  assets: Array<{
    name: string;

    browser_download_url: string;
  }>;
}

interface DownloadOpts {
  progressTitle: string;
  url: string;
  dest: string;
  mode?: number;
  gunzip?: boolean;
}

export async function download(opts: DownloadOpts) {
  const dest = path.parse(opts.dest);
  const randomHex = crypto.randomBytes(5).toString('hex');
  const tempFile = path.join(dest.dir, `${dest.name}${randomHex}`);

  await qv.window.withProgress(
    {
      location: qv.ProgressLocation.Notification,
      cancellable: false,
      title: opts.progressTitle,
    },
    async (progress, _cancellationToken) => {
      let lastPercentage = 0;
      await downloadFile(opts.url, tempFile, opts.mode, !!opts.gunzip, (readBytes, totalBytes) => {
        const newPercentage = (readBytes / totalBytes) * 100;
        progress.report({
          message: newPercentage.toFixed(0) + '%',
          increment: newPercentage - lastPercentage,
        });

        lastPercentage = newPercentage;
      });
    }
  );

  await fs.promises.rename(tempFile, opts.dest);
}

async function downloadFile(url: string, destFilePath: fs.PathLike, mode: number | undefined, gunzip: boolean, onProgress: (readBytes: number, totalBytes: number) => void): Promise<void> {
  const res = await fetch(url);

  if (!res.ok) {
    log.error('Error', res.status, 'while downloading file from', url);
    log.error({ body: await res.text(), headers: res.headers });

    throw new Error(`Got response ${res.status} when trying to download a file.`);
  }

  const totalBytes = Number(res.headers.get('content-length'));
  assert(!Number.isNaN(totalBytes), 'Sanity check of content-length protocol');

  log.debug('Downloading file of', totalBytes, 'bytes size from', url, 'to', destFilePath);

  let readBytes = 0;
  res.body.on('data', (chunk: Buffer) => {
    readBytes += chunk.length;
    onProgress(readBytes, totalBytes);
  });

  const destFileStream = fs.createWriteStream(destFilePath, { mode });
  const srcStream = gunzip ? res.body.pipe(zlib.createGunzip()) : res.body;

  await pipeline(srcStream, destFileStream);

  await new Promise<void>((resolve) => {
    destFileStream.on('close', resolve);
    destFileStream.destroy();
  });
}
