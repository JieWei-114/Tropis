import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUE_FILE_PROCESSING, JOB_PROCESS_FILE } from './queue.constants';
import type { FileProcessingJobData } from './queue.service';

@Processor(QUEUE_FILE_PROCESSING)
export class FileProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(FileProcessingProcessor.name);

  async process(job: Job<FileProcessingJobData>): Promise<void> {
    this.logger.log(
      `Processing job ${job.name} (id=${job.id}) — file: ${job.data.fileKey}`,
    );

    if (job.name === JOB_PROCESS_FILE) {
      const { fileKey, bucket, userId, operation } = job.data;

      // Stub: extend with real operations (thumbnail generation, virus scan, transcoding, etc.)
      this.logger.log(
        `File operation "${operation}" on ${bucket}/${fileKey} for user ${userId}`,
      );
    }
  }
}
