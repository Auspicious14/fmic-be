import { Injectable, Logger } from '@nestjs/common';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';

export interface ProcessedAudio {
  buffer: Buffer;
  mimetype: string;
  wasProcessed: boolean;
}

@Injectable()
export class AudioPreprocessorService {
  private readonly logger = new Logger(AudioPreprocessorService.name);

  async preprocess(file: {
    buffer: Buffer;
    mimetype: string;
  }): Promise<ProcessedAudio> {
    const workDir = await mkdtemp(join(tmpdir(), 'fmic-audio-'));
    const inputPath = join(workDir, `input${this.mimeToExt(file.mimetype)}`);
    const outputPath = join(workDir, `${randomUUID()}.wav`);

    try {
      await writeFile(inputPath, file.buffer);

      await this.runFfmpeg([
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        inputPath,
        '-ac',
        '1',
        '-ar',
        '16000',
        '-af',
        'highpass=f=80,lowpass=f=8000,afftdn=nf=-25,dynaudnorm=f=75:g=11',
        '-f',
        'wav',
        outputPath,
      ]);

      const buffer = await readFile(outputPath);
      this.logger.log(
        `[AudioPreprocessor] normalized ${file.buffer.length}b -> ${buffer.length}b`,
      );

      return {
        buffer,
        mimetype: 'audio/wav',
        wasProcessed: true,
      };
    } catch (error) {
      this.logger.warn(
        `[AudioPreprocessor] ffmpeg preprocessing skipped: ${(error as Error).message}`,
      );
      return {
        buffer: file.buffer,
        mimetype: file.mimetype,
        wasProcessed: false,
      };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', args);
      let stderr = '';

      const timeout = setTimeout(() => {
        ffmpeg.kill('SIGKILL');
        reject(new Error('ffmpeg timed out'));
      }, 15000);

      ffmpeg.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      ffmpeg.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      ffmpeg.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(stderr || `ffmpeg exited with code ${code}`));
      });
    });
  }

  private mimeToExt(mimeType: string): string {
    const map: Record<string, string> = {
      'audio/webm': '.webm',
      'audio/ogg': '.ogg',
      'audio/wav': '.wav',
      'audio/mpeg': '.mp3',
      'audio/mp4': '.mp4',
      'video/webm': '.webm',
    };
    return map[mimeType] ?? '.webm';
  }
}
