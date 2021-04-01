import * as assert from 'assert';
import * as fs from 'fs';
import fetch from 'node-fetch';
import * as stream from 'stream';
import * as util from 'util';
import * as qv from 'vscode';

const pipeline = util.promisify(stream.pipeline);

const GITHUB_API_ENDPOINT_URL = 'https://api.github.com';

export async function fetchRelease(owner: string, repository: string, releaseTag: string): Promise<GithubRelease> {
  const apiEndpointPath = `/repos/${owner}/${repository}/releases/tags/${releaseTag}`;
  const requestUrl = GITHUB_API_ENDPOINT_URL + apiEndpointPath;
  console.debug('Issuing request for released artifacts metadata to', requestUrl);
  const response = await fetch(requestUrl, {
    headers: { Accept: 'application/vnd.github.v3+json' },
  });
  if (!response.ok) {
    console.error('Error fetching artifact release info', {
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

export async function download(downloadUrl: string, destinationPath: string, progressTitle: string, { mode }: { mode?: number } = {}) {
  await qv.window.withProgress(
    {
      location: qv.ProgressLocation.Notification,
      cancellable: false,
      title: progressTitle,
    },
    async (progress, _cancellationToken) => {
      let lastPercentage = 0;
      await downloadFile(downloadUrl, destinationPath, mode, (readBytes, totalBytes) => {
        const newPercentage = (readBytes / totalBytes) * 100;
        progress.report({
          message: newPercentage.toFixed(0) + '%',
          increment: newPercentage - lastPercentage,
        });

        lastPercentage = newPercentage;
      });
    }
  );
}

async function downloadFile(url: string, destFilePath: fs.PathLike, mode: number | undefined, onProgress: (readBytes: number, totalBytes: number) => void): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    console.error('Error', res.status, 'while downloading file from', url);
    console.error({ body: await res.text(), headers: res.headers });
    throw new Error(`Got response ${res.status} when trying to download a file.`);
  }
  const totalBytes = Number(res.headers.get('content-length'));
  assert(!Number.isNaN(totalBytes), 'Sanity check of content-length protocol');
  console.debug('Downloading file of', totalBytes, 'bytes size from', url, 'to', destFilePath);
  let readBytes = 0;
  res.body.on('data', (chunk: Buffer) => {
    readBytes += chunk.length;
    onProgress(readBytes, totalBytes);
  });

  const destFileStream = fs.createWriteStream(destFilePath, { mode });

  await pipeline(res.body, destFileStream);
  return new Promise<void>((resolve) => {
    destFileStream.on('close', resolve);
    destFileStream.destroy();
  });
}